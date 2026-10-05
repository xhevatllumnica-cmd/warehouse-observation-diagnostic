/* Tabela ditore — the daily board at the warehouse entrance (page /tabela, also shown in the app). Agent-side only.
   Two sources, both WMS:
   - live (every ~2 min): today's ProductLogs from the WMS web (the agent's fetchDayProductLogs). Per operator, on the same
     basis as Statistikat e WH § 5.4 (staff roster, the two accounts of one person merged): check-out = products checked out
     (LogTypeId 4 + 18), check-in = LogTypeId 2, mapping = LogTypeId 7; orders = distinct OrderId on the same check-out rows
     (4 + 18) — the definition Statistikat e WH, the plan and the Bottleneck Register use; the day's "orders out" counts every
     account, like Statistikat. "Active hour" = a clock hour with at least one such scan.
   - hourly (pulse block M, WMS database): orders READY by the cut-offs 13:00 / 15:00 / 17:30 and yesterday's carryover,
     with the Bottleneck Register D1/D1o definition (ready = created or last unit reserved; complete = all units reserved).
   The WMS does not record which operator works at which station (LabelPrintJobs/PickSession are unused), so the
   station → operator assignment is set on the board and kept in data/tabela-assign.json (this agent is the only writer). */
const fs=require('fs'), path=require('path');
const CUTS=[{b:13,label:'13:00'},{b:15,label:'15:00'},{b:17,label:'17:30'}];
const MAPPED=7;
const RETURN_DISP=new Set([20,21,22,29]);   // customer-return dispositions (WMS "Returns"): defect, outlet, return to stock, auction

function liveByOperator(rows, staff, normName, parseWmsDate, aliases){
  const ops={}; let last=0; const allOrders=new Set(), types={};
  rows.forEach(x=>{
    const t=parseWmsDate(x.InsertDateTime); if(t==null) return; const id=Number(x.LogTypeId);
    const ty=types[id]||(types[id]={id, name:x.LogType||'', n:0}); ty.n++;   // log-type names as the WMS shows them (no personal data)
    const isOut=id===4||id===18, isOrd=isOut && !!x.OrderId, isIn=id===2, isMap=id===MAPPED, isRet=RETURN_DISP.has(id);
    if(!isOrd && !isIn && !isMap && !isRet && !isOut) return;
    if(isOrd) allOrders.add(x.OrderId);   // the day's orders out: every account, as in Statistikat e WH
    const raw=String(x.UpdatedByName||'').replace(/\s+/g,' ').trim(); if(!raw || !staff.has(normName(raw))) return;
    const name=(aliases&&aliases[normName(raw)])||raw;   // e.g. two WMS accounts of one person → one name, as in § 5.4
    if(t>last) last=t;
    const o=ops[name]||(ops[name]={name, ord:new Map(), coH:new Set(), ciT:[], mpT:[], retT:[], outT:[], first:t, last:t});
    if(t<o.first) o.first=t; if(t>o.last) o.last=t;
    // rows arrive in paging order, not time order: keep each order's EARLIEST completion scan
    if(isOrd){ const p=o.ord.get(x.OrderId); if(p==null || t<p) o.ord.set(x.OrderId,t); o.coH.add(new Date(t).getHours()); }
    if(isIn) o.ciT.push(t);
    if(isMap) o.mpT.push(t);
    if(isRet) o.retT.push(t);
    if(isOut) o.outT.push(t);
  });
  const r1=v=>Math.round(v*10)/10, byH=arr=>{ const m={}; arr.forEach(t=>{ const h=new Date(t).getHours(); m[h]=(m[h]||0)+1; }); return m; };
  const list=Object.values(ops).map(o=>{ const ordT=[...o.ord.values()], ciH=byH(o.ciT), mpH=byH(o.mpT);
    const coHours=o.coH.size, ciHours=Object.keys(ciH).length, mpHours=Object.keys(mpH).length;
    return {name:o.name, orders:ordT.length, coHours, coRate: coHours? r1(ordT.length/coHours) : null, byHour:byH(ordT),
      ci:o.ciT.length, ciHours, ciRate: ciHours? r1(o.ciT.length/ciHours) : null, ciByHour:ciH, mp:o.mpT.length, mpHours, mpRate: mpHours? r1(o.mpT.length/mpHours) : null,
      ret:o.retT.length, retByHour:byH(o.retT), mpByHour:mpH, out:o.outT.length, outByHour:byH(o.outT), first:new Date(o.first).toISOString(), last:new Date(o.last).toISOString(),
      _ordT:ordT, _ciT:o.ciT, _retT:o.retT, _mpT:o.mpT, _outT:o.outT};   // event times — used for the station cards, stripped before sending
  });
  return {ops:list, ordersOut:allOrders.size, lastScan: last? new Date(last).toISOString() : null, types:Object.values(types).sort((a,b)=>a.id-b.id)};
}

/* cut-offs for `today` and yesterday's carryover, from pulse block M (as of its query time) */
function cutoffs(board, today, yday){
  if(!board || !String(board.gen||'').startsWith(today)) return {available:false, gen: board&&board.gen || null};
  const out=board.outd||[], open=board.openr||[];
  const sum=(arr,f)=>arr.filter(f).reduce((a,x)=>a+(+x.n||0),0);
  const cuts=CUTS.map(c=>{ const done=sum(out,x=>x.rd===today && x.b<=c.b), left=sum(open,x=>x.rd===today && x.b<=c.b && x.cmp===1);
    return {label:c.label, ready:done+left, out:done, open:left, waiting:sum(open,x=>x.rd===today && x.b<=c.b && x.cmp===0)}; });
  const yReady=sum(out,x=>x.rd===yday && x.b<=17)+sum(open,x=>x.rd===yday && x.b<=17 && x.cmp===1);
  const yCarryOut=sum(out,x=>x.rd===yday && x.b<=17 && x.od===today), yOpen=sum(open,x=>x.rd===yday && x.b<=17 && x.cmp===1);
  const carry=yCarryOut+yOpen;
  return {available:true, gen:board.gen, cuts,
    carry:{date:yday, ready:yReady, carry, pct: yReady? Math.round(carry/yReady*1000)/10 : null, outToday:yCarryOut, stillOpen:yOpen,
      olderOpen:sum(open,x=>x.rd==='older' && x.b<=17 && x.cmp===1)}};
}

/* Virtual tables that are not WMS stations: Mapimi (units mapped to a shelf row, LogTypeId 7) and POD (orders scanned for
   the couriers in the Delivery Platform, Accept Delivery — see withPod). */
const EXTRA_STATIONS=[{name:'MAPIMI', label:'Mapimi', kind:'map'}, {name:'POD', label:'POD', kind:'pod'},
  // automatic pools: check-out / check-in work of anyone not assigned to a numbered table — no work is left off the board
  {name:'POOL_CO', label:'Check-out · pa tavolinë', kind:'poolco', co:true, auto:true}, {name:'POOL_CI', label:'Check-in · pa tavolinë', kind:'poolci', ci:true, auto:true}];
/* Station assignment: tables = {station: [operator, …]} — the operators who work at that table (e.g. the N1 and the N2
   operator), kept until changed. Each operator's whole day counts (see stationCards); the shift from "Orari i punës" only orders the
   card, and an assigned operator who is off and did nothing that day is not shown. An operator may work at two
   tables in one shift: a table counts only its own kind of work (orders / check-in units / mapping / returns), and when two
   of their tables count the same kind, it is counted once — at the first table — and the other card says where. */
function assignFile(appDir){ return path.join(appDir,'data','tabela-assign.json'); }
/* History by date: history = {'YYYY-MM-DD': {station:[ops]}} — the full table map saved for that day. A day uses the
   latest snapshot on or before it (so an assignment carries over until changed); before the first snapshot, "base" — the
   map as it was when history started. Changing a past day pins the following day first, so the change stays on that day only. "tables" = today's map. */
function readAssign(appDir){
  let r; try{ r=JSON.parse(fs.readFileSync(assignFile(appDir),'utf8')); }catch(e){ r={}; }
  if(!r.tables){ const t={};   // older formats: {assign:{st:op}} or {log:[{station,op,from}]} → current operator per table
    if(Array.isArray(r.log)) r.log.slice().sort((a,b)=>Date.parse(a.from)-Date.parse(b.from)).forEach(e=>{ t[e.station]= e.op? [e.op] : []; });
    else Object.entries(r.assign||{}).forEach(([st,op])=>{ if(op) t[st]=[op]; });
    r={tables:t, updatedAt:r.updatedAt||null}; }
  if(!r.history || typeof r.history!=='object') r.history={};
  return r;
}
const cloneT=t=>{ const o={}; Object.entries(t||{}).forEach(([k,v])=>{ o[k]=(v||[]).slice(); }); return o; };
function tablesFor(rec, date){
  const days=Object.keys(rec.history||{}).sort(); if(!days.length) return cloneT(rec.tables);
  let pick=null; days.forEach(d=>{ if(d<=date) pick=d; });
  return cloneT(pick? rec.history[pick] : rec.base || rec.history[days[0]]);
}
function currentAssign(rec, date){ const out={}; Object.entries(date? tablesFor(rec,date) : rec.tables||{}).forEach(([st,ops])=>{ if(ops&&ops.length) out[st]=ops.slice(); }); return out; }
const isoNext=d=>{ const x=new Date(d+'T12:00:00'); x.setDate(x.getDate()+1); return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
/* body = {station, ops:[names], date?:'YYYY-MM-DD'} — one table, for that day (default today; never a future day) */
function saveAssign(appDir, body, stations, today){
  const names=new Set((stations||[]).map(s=>s.name)), rec=readAssign(appDir);
  if(!body || !names.has(body.station)) return rec;
  let date=String(body.date||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || date>today) date=today;
  const ops=[...new Set((Array.isArray(body.ops)? body.ops : []).map(o=>String(o||'').trim().slice(0,80)).filter(Boolean))].slice(0,6);
  if(!Object.keys(rec.history).length){ rec.base=cloneT(rec.tables); rec.history[today]=cloneT(rec.tables); }   // first save: today's map becomes the base
  const next=isoNext(date); if(date<today && !rec.history[next]) rec.history[next]=tablesFor(rec, next);   // keep later days as they were
  const snap=rec.history[date]? rec.history[date] : (rec.history[date]=tablesFor(rec, date));
  snap[body.station]=ops;
  if(date===today) rec.tables=cloneT(snap);
  const keep=Object.keys(rec.history).sort().slice(-400), h={}; keep.forEach(d=>h[d]=rec.history[d]); rec.history=h;
  rec.updatedAt=new Date().toISOString();
  fs.mkdirSync(path.dirname(assignFile(appDir)),{recursive:true}); fs.writeFileSync(assignFile(appDir), JSON.stringify(rec,null,2));
  return rec;
}
/* the operator's shift today from the schedule day object {name:{start,end}|{off}} */
function shiftOf(day, name, normName, today){
  if(!day) return null; const key=Object.keys(day).find(n=>normName(n)===normName(name)); if(!key) return null;
  const s=day[key]; if(s.off) return {off:true, reason:s.reason||null};
  const a=Date.parse(today+'T'+s.start+':00'); let b=Date.parse(today+'T'+s.end+':00'); if(b<=a) b+=86400000;
  return {start:s.start, end:s.end, a, b};
}
/* one card per table: today's total and each operator's orders/units within their shift; "current" = on shift now */
/* One card per table / process. Since 05.10.2026 nothing has to be added by hand for the work to show:
   - process cards (Mapimi, POD, refusals/returns) take everyone who did that work that day;
   - numbered tables show the operators assigned to them (optional — it only tells which physical table);
   - the pools "Check-out · pa tavolinë" / "Check-in · pa tavolinë" take everyone else who did that work.
   Everyone's whole day counts, whatever the shift; the shift (Orari i punës) only orders the card (N1 on top until N1 ends,
   then N2). Work of one kind is counted once — at the first card that claims it (assigned tables before the pools). */
function stationCards(stations, rec, ops, today, day, normName, aliases){
  const canon=n=>(aliases&&aliases[normName(n)])||n;   // an assignment made with a second account of the same person
  const now=Date.now(), dayStart=Date.parse(today+'T00:00:00'), dayEnd=dayStart+86400000, by={}; (ops||[]).forEach(o=>by[o.name]=o);
  const claims={};   // operator|metric → the card that counts it
  const metricsOf=st=> st.kind==='ret'? ['ref','ret'] : st.kind==='map'? ['map'] : st.kind==='pod'? ['pod'] : st.co&&st.ci? ['out','orders','units'] : st.co? ['out','orders'] : st.ci? ['units'] : [];
  const has=(o,k)=> o && o[k] && o[k].length;
  const autoOf=st=> st.kind==='map'? (ops||[]).filter(o=>has(o,'_mpT')) : st.kind==='pod'? (ops||[]).filter(o=>has(o,'_podT'))
    : st.kind==='ret'? (ops||[]).filter(o=>has(o,'_refT')||has(o,'_retT')) : st.kind==='poolco'? (ops||[]).filter(o=>has(o,'_outT')) : st.kind==='poolci'? (ops||[]).filter(o=>has(o,'_ciT')) : [];
  const cntAll=(o,k)=> o&&o[k]? o[k].filter(t=>t>=dayStart && t<dayEnd).length : 0;
  return (stations||[]).map(st=>{
    const auto=autoOf(st).map(o=>o.name), assigned=[...new Set((rec.tables[st.name]||[]).map(canon))];
    const people=[...new Set(assigned.concat(auto))].map(name=>{
      const o=by[name], c={orders:cntAll(o,'_ordT'), units:cntAll(o,'_ciT'), ret:cntAll(o,'_retT'), map:cntAll(o,'_mpT'), out:cntAll(o,'_outT'), pod:cntAll(o,'_podT'), ref:cntAll(o,'_refT')};
      const worked= metricsOf(st).some(m=>c[m]>0);
      let sh=shiftOf(day, name, normName, today), offDay=false;
      if(sh&&sh.off){ if(!worked) return null; sh=null; offDay=true; }   // off in the schedule but worked: the work still shows
      const state= offDay? 'done' : !sh? 'day' : now<sh.a? 'later' : now>=sh.b? 'done' : 'now';
      return Object.assign({op:name, shift: sh? sh.start+'–'+sh.end : null, start: sh? sh.a : dayStart, end: offDay? dayStart : sh? sh.b : dayEnd, state, auto:!assigned.includes(name)}, c);
    // shift order (N1 before N2); two operators on the same shift: the one with more of this card's work first
    }).filter(Boolean).sort((x,y)=>{ const m=metricsOf(st)[0]; return x.start-y.start || (m? (y[m]||0)-(x[m]||0) : 0); });
    people.forEach(p=>metricsOf(st).forEach(m=>{ const k=p.op+'|'+m;
      if(claims[k] && claims[k]!==st.name){ p[m]=0; (p.countedAt=p.countedAt||{})[m]=claims[k]; } else if(p[m]>0 || !st.auto) claims[k]=st.name; }));
    const shown= st.auto? people.filter(p=>metricsOf(st).some(m=>p[m]>0)) : people;   // a pool keeps only work no other card counts
    // on top: the earliest operator still on shift (N1 stays until their shift ends); when nobody is on shift, the one who
    // finished last stays on top until the next operator starts
    const onNow=shown.filter(p=>p.state==='now'||p.state==='day');
    const lastDone=shown.filter(p=>p.state==='done').reduce((best,p)=> !best || p.end>best.end? p : best, null);
    const current= onNow.length? onNow[0].op : lastDone? lastDone.op : null;
    const sum=k=>shown.reduce((s,p)=>s+(p[k]||0),0);
    return {name:st.name, label:st.label||null, kind:st.kind||null, auto:!!st.auto, co:!!st.co, ci:!!st.ci, orders:sum('orders'), units:sum('units'), ret:sum('ret'), map:sum('map'), out:sum('out'), pod:sum('pod'), ref:sum('ref'),
      current, people:shown.map(p=>{ const c=Object.assign({},p); delete c.start; delete c.end; return c; }),
      off:assigned.filter(n=>{ const sh=shiftOf(day,n,normName,today); return sh&&sh.off && !shown.some(p=>p.op===n); })};
  });
}

/* Delivery Platform work merged into the per-operator data, by the logged-in account's full name: POD scans (one per
   order) and collected refusals (one row per collection, n orders). A copy, so the cached live object is never changed;
   staff without WMS scans that day (a POD-only day) get an entry of their own. */
function withPod(live, pod, staff, normName, aliases, ref){
  if(!live || live.error || !live.ops) return live;
  const ops=live.ops.map(o=>Object.assign({}, o, {pod:0, podByHour:{}, _podT:[], ref:0, refByHour:{}, _refT:[]})), by={}; ops.forEach(o=>by[o.name]=o);
  const infoOf=src=>({error: src&&src.error || null, total: src&&src.total!=null? src.total : null, complete: src? src.complete!==false : false, at: src&&src.at || null, otherAccounts:0});
  const info=infoOf(pod), rinfo=infoOf(ref);
  const opFor=(raw,t)=>{ const name=(aliases&&aliases[normName(raw)])||raw;
    return by[name]||(by[name]=ops[ops.push({name, orders:0, coHours:0, coRate:null, byHour:{}, ci:0, ciHours:0, ciRate:null, ciByHour:{}, mp:0, mpHours:0, mpRate:null, mpByHour:{},
      ret:0, retByHour:{}, out:0, outByHour:{}, first:new Date(t).toISOString(), last:new Date(t).toISOString(), _ordT:[], _ciT:[], _retT:[], _mpT:[], _outT:[],
      pod:0, podByHour:{}, _podT:[], ref:0, refByHour:{}, _refT:[]})-1]); };
  ((pod&&pod.rows)||[]).forEach(r=>{ const raw=r.scanner; if(!raw || !staff.has(normName(raw))){ info.otherAccounts++; return; }
    const o=opFor(raw,r.t); o._podT.push(r.t); o.pod++; const h=new Date(r.t).getHours(); o.podByHour[h]=(o.podByHour[h]||0)+1; });
  ((ref&&ref.rows)||[]).forEach(r=>{ const raw=r.receiver; if(!raw || !staff.has(normName(raw))){ rinfo.otherAccounts+=r.n; return; }
    const o=opFor(raw,r.t); for(let i=0;i<r.n;i++) o._refT.push(r.t); o.ref+=r.n; const h=new Date(r.t).getHours(); o.refByHour[h]=(o.refByHour[h]||0)+r.n; });
  return Object.assign({}, live, {ops, pod:info, ref:rinfo});
}

module.exports={EXTRA_STATIONS, tablesFor, withPod, liveByOperator, cutoffs, readAssign, saveAssign, currentAssign, stationCards, CUTS};
