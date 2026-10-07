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
   operators are placed on the tables automatically (autoPlace); a correction on the board is kept in
   data/tabela-assign.json (this agent is the only writer). */
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
  // which tables were set by hand on which day: fixed for that day (see autoPlace); before this, the whole day's snapshot
  if(!rec.edits){ rec.edits={}; Object.keys(rec.history).forEach(d=>{ if(d!==date) rec.edits[d]=Object.keys(rec.history[d]); }); }
  const e=rec.edits[date]||(rec.edits[date]=[]); if(!e.includes(body.station)) e.push(body.station);
  const rm=[...new Set((Array.isArray(body.removed)? body.removed : []).map(o=>String(o||'').trim().slice(0,80)).filter(o=>o && !ops.includes(o)))].slice(0,10);
  rec.removed=rec.removed||{}; const rd=rec.removed[date]||(rec.removed[date]={}); rd[body.station]=[...new Set((rd[body.station]||[]).filter(o=>!ops.includes(o)).concat(rm))];
  const rk=Object.keys(rec.removed).sort().slice(-60), r2={}; rk.forEach(d=>r2[d]=rec.removed[d]); rec.removed=r2;
  const ek=Object.keys(rec.edits).sort().slice(-400), e2={}; ek.forEach(d=>e2[d]=rec.edits[d]); rec.edits=e2;
  rec.updatedAt=new Date().toISOString();
  fs.mkdirSync(path.dirname(assignFile(appDir)),{recursive:true}); fs.writeFileSync(assignFile(appDir), JSON.stringify(rec,null,2));
  return rec;
}
/* Automatic placement on the numbered tables. The WMS records no station for a scan (checked in the database, 05.10.2026:
   ProductLogs / ProductCheckIns carry only user, time and order; PickSession, LabelPrintJobs and the print agents are unused
   since September), so the table is inferred, without anything installed:
   - each operator's check-out work (products checked out) and check-in work (units) is split into sessions (gap > 45 min);
     an operator with at least 3 check-out / 5 check-in scans gets ONE table of that kind for the day;
   - in order of their first scan, each takes the first table, of the right kind, that is free during their sessions (no
     overlap over 15 min with another operator there — N1 then N2 share a table), trying in turn: the table they got earlier
     today (stable during the day), their tables on the board from the last saved assignment, their usual table (the most
     frequent one over the last 30 days of placements), then the other tables in order;
   - a correction on the board FOR THAT DAY (dialog) pins the people listed there and wins; those removed from a table are not
     put back on it that day; others may still join it automatically. A correction is also remembered as the operator's
     table for the next days. Who finds no free table stays in the pool "pa tavolinë".
   Tavolina 5 (check-in & check-out together, not in use now) gets nobody automatically. Placements are kept by day in
   data/tabela-auto.json (this agent is the only writer). */
const AUTO_GAP=45*60000, AUTO_OVERLAP=15*60000, AUTO_MIN={co:3, ci:5}, AUTO_LEARN_DAYS=30;
function autoFile(appDir){ return path.join(appDir,'data','tabela-auto.json'); }
function readAuto(appDir){ try{ const r=JSON.parse(fs.readFileSync(autoFile(appDir),'utf8')); return r&&r.days? r : {days:{}}; }catch(e){ return {days:{}}; } }
const isoAdd=(d,n)=>{ const x=new Date(d+'T12:00:00'); x.setDate(x.getDate()+n); return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
function sessionsOf(times){ const t=times.slice().sort((a,b)=>a-b), out=[]; t.forEach(x=>{ const s=out[out.length-1]; if(s && x-s[1]<=AUTO_GAP) s[1]=x; else out.push([x,x]); }); return out; }
const clash=(A,B)=>A.some(a=>B.some(b=>Math.min(a[1],b[1])-Math.max(a[0],b[0])>AUTO_OVERLAP));
/* stations, ops (liveByOperator/withPod list), rec (readAssign), date → {tables:{station:[ops]}, how:{station:{op:'manual'|'auto'}}} */
function autoPlace(stations, ops, rec, date, appDir, canon, persist){
  const kindOf=s=> s.kind||s.auto? null : s.co&&s.ci? null : s.co? 'co' : s.ci? 'ci' : null;
  const T={co:(stations||[]).filter(s=>kindOf(s)==='co').map(s=>s.name), ci:(stations||[]).filter(s=>kindOf(s)==='ci').map(s=>s.name)};
  const kindByName={}; Object.entries(T).forEach(([k,list])=>list.forEach(n=>kindByName[n]=k));
  const carried=tablesFor(rec, date), edits=rec.edits||null;
  // fixed for this day: tables edited on the board for this date (older files without "edits": the snapshot saved that day)
  const fixedSt= edits? new Set(edits[date]||[]) : new Set(rec.history&&rec.history[date]? Object.keys(rec.history[date]) : []);
  const tables={}, how={}, put=(st,op,h)=>{ (tables[st]=tables[st]||[]); if(!tables[st].includes(op)){ tables[st].push(op); (how[st]=how[st]||{})[op]=h; } };
  // every table set by hand that day keeps its people; process cards (Mapimi, POD, returns) fill themselves from the work
  Object.entries(carried).forEach(([st,list])=>{ if(fixedSt.has(st)) (list||[]).forEach(op=>put(st,canon(op),'manual')); });
  const A=readAuto(appDir), todayAuto=(A.days[date]||{});
  // usual table per operator and kind: placements of the last 30 days before this date
  const usual={}; Object.keys(A.days).filter(d=>d<date && d>=isoAdd(date,-AUTO_LEARN_DAYS)).forEach(d=>Object.entries(A.days[d]).forEach(([k,st])=>{ const u=usual[k]||(usual[k]={}); u[st]=(u[st]||0)+1; }));
  const occ={}; const occOf=st=>occ[st]||(occ[st]=[]);
  const S={}; (ops||[]).forEach(o=>{ S[o.name]={co:sessionsOf(o._outT||[]), ci:sessionsOf(o._ciT||[]), nco:(o._outT||[]).length, nci:(o._ciT||[]).length}; });
  Object.entries(tables).forEach(([st,list])=>{ const k=kindByName[st]; if(k) list.forEach(op=>{ if(S[op]) occOf(st).push({op, ses:S[op][k]}); }); });
  const fixedOps={co:new Set(), ci:new Set()}; Object.entries(tables).forEach(([st,list])=>{ const k=kindByName[st]; if(k) list.forEach(op=>fixedOps[k].add(op)); });
  const cand=[]; (ops||[]).forEach(o=>['co','ci'].forEach(k=>{ const s=S[o.name]; if(!fixedOps[k].has(o.name) && s['n'+k]>=AUTO_MIN[k] && T[k].length) cand.push({op:o.name, k, ses:s[k], n:s['n'+k], first:s[k][0][0]}); }));
  // a correction pins the people listed on that table; the others still come automatically, except those removed from it that day
  const removed=(rec.removed&&rec.removed[date])||{};
  const free=(st,c)=>!(removed[st]||[]).map(canon).includes(c.op) && !occOf(st).some(x=>x.op!==c.op && clash(x.ses, c.ses));
  const take=(c,st)=>{ occOf(st).push({op:c.op, ses:c.ses}); put(st, c.op, 'auto'); c.done=true; };
  const own=c=>{ const key=c.op+'|'+c.k, carriedSt=T[c.k].filter(st=>(carried[st]||[]).map(canon).includes(c.op));
    return [...new Set([...carriedSt, ...Object.entries(usual[key]||{}).sort((a,b)=>b[1]-a[1]).map(e=>e[0])])].filter(st=>T[c.k].includes(st)); };
  const byWork=cand.slice().sort((a,b)=>b.n-a.n);
  // pass 1 — own table (on the board at the last correction, or the usual one over 30 days); the one with more work that day
  // goes first, so a short help at someone else's table does not push its regular operator away
  byWork.forEach(c=>{ const st=own(c).find(s=>free(s,c)); if(st) take(c,st); });
  // pass 2 — the table got earlier today (keeps a newcomer where they were), never before anyone's own table
  byWork.forEach(c=>{ if(c.done) return; const st=todayAuto[c.op+'|'+c.k]; if(st && T[c.k].includes(st) && free(st,c)) take(c,st); });
  // pass 3 — the others, in order of their first scan: the first free table, those whose regular operators are not working
  // in this process today first (so a newcomer does not sit at a colleague's usual table)
  const claimed={co:new Set(), ci:new Set()}; Object.keys(S).forEach(op=>['co','ci'].forEach(k=>{ if(S[op]['n'+k]) own({op,k}).forEach(st=>claimed[k].add(st)); }));
  cand.filter(c=>!c.done).sort((a,b)=>a.first-b.first).forEach(c=>{ const tl=T[c.k].filter(s=>!claimed[c.k].has(s)).concat(T[c.k].filter(s=>claimed[c.k].has(s)));
    const st=tl.find(s=>free(s,c)); if(st) take(c,st); });   // none free → pool
  if(persist){   // the day's placements (automatic and by hand) — the memory for "usual table"
    const day={}; Object.entries(tables).forEach(([st,list])=>{ const k=kindByName[st]; if(k) list.forEach(op=>{ if(S[op] && S[op]['n'+k]) day[op+'|'+k]=st; }); });
    if(JSON.stringify(day)!==JSON.stringify(A.days[date]||{})){ A.days[date]=day; const keep=Object.keys(A.days).sort().slice(-120), d2={}; keep.forEach(d=>d2[d]=A.days[d]); A.days=d2;
      try{ fs.mkdirSync(path.dirname(autoFile(appDir)),{recursive:true}); fs.writeFileSync(autoFile(appDir), JSON.stringify(A,null,1)); }catch(e){} }
  }
  return {tables, how};
}
/* the operator's shift today from the schedule day object {name:{start,end}|{off}} */
function shiftOf(day, name, normName, today){
  if(!day) return null; const key=Object.keys(day).find(n=>normName(n)===normName(name)); if(!key) return null;
  const s=day[key]; if(s.off) return {off:true, reason:s.reason||null};
  const a=Date.parse(today+'T'+s.start+':00'); let b=Date.parse(today+'T'+s.end+':00'); if(b<=a) b+=86400000;
  return {start:s.start, end:s.end, a, b};
}
/* one card per table: today's total and each operator's orders/units within their shift; "current" = on shift now */
/* One card per table / process. Nothing has to be added by hand for the work to show:
   - tables with a PC on the list (station-ips.json): the operators whose WMS account was logged in at that PC (reported
     by the "WMS Station" extension); each one's work is credited for the time they were logged in there;
   - tables without reports that day: the operators assigned on the board (optional), their whole day;
   - process cards (Mapimi, POD, refusals/returns): everyone who did that work that day;
   - the pools "Check-out · pa tavolinë" / "Check-in · pa tavolinë": all check-out / check-in work not credited above.
   Every scan is credited once: tables with reports first, then assigned tables, process cards, the pools. The shift from
   Orari i punës only orders a card (N1 on top until N1 ends, then N2); on a table with reports the account logged in now
   is on top. Operators with no work on a card are not shown. */
const PRES_SLACK=2*60000;   // reports come about once a minute: a scan within 2 min of an interval belongs to it
function stationCards(stations, rec, ops, today, day, normName, aliases, presence, how){
  const canon=n=>(aliases&&aliases[normName(n)])||n;
  const now=Date.now(), dayStart=Date.parse(today+'T00:00:00'), dayEnd=dayStart+86400000, by={}; (ops||[]).forEach(o=>by[o.name]=o);
  const ARR={out:'_outT', orders:'_ordT', units:'_ciT', map:'_mpT', pod:'_podT', ref:'_refT', ret:'_retT'};
  const metricsOf=st=> st.kind==='ret'? ['ref','ret'] : st.kind==='map'? ['map'] : st.kind==='pod'? ['pod'] : st.co&&st.ci? ['out','orders','units'] : st.co? ['out','orders'] : st.ci? ['units'] : [];
  const used={}, scansAt={};   // operator|metric → indices of scans already credited to a card; card|operator → times of the scans credited there
  const take=(name,m,wins,stName)=>{ const o=by[name], arr=o&&o[ARR[m]]; if(!arr) return 0; const u=used[name+'|'+m]||(used[name+'|'+m]=new Set()); let n=0;
    arr.forEach((t,i)=>{ if(!u.has(i) && wins.some(w=>t>=w[0] && t<w[1])){ u.add(i); n++; (scansAt[stName+'|'+name]=scansAt[stName+'|'+name]||[]).push(t); } }); return n; };
  const has=(o,m)=> o && o[ARR[m]] && o[ARR[m]].length;
  const autoOf=st=> st.kind==='map'? (ops||[]).filter(o=>has(o,'map')) : st.kind==='pod'? (ops||[]).filter(o=>has(o,'pod'))
    : st.kind==='ret'? (ops||[]).filter(o=>has(o,'ref')||has(o,'ret')) : st.kind==='poolco'? (ops||[]).filter(o=>has(o,'out')) : st.kind==='poolci'? (ops||[]).filter(o=>has(o,'units')) : [];
  const pres=presence||{}, P=st=> (pres[st.name]||[]).filter(x=>x.b>=dayStart && x.a<dayEnd);
  const prio=st=> P(st).length? 0 : st.auto? 3 : st.kind==='map'||st.kind==='pod'||st.kind==='ret'? 2 : 1;
  const order=(stations||[]).map((st,i)=>({st,i})).sort((x,y)=>prio(x.st)-prio(y.st) || x.i-y.i);
  const result=new Array((stations||[]).length);
  order.forEach(({st,i})=>{
    const iv=P(st), viaPresence=iv.length>0, assigned=[...new Set((rec.tables[st.name]||[]).map(canon))];
    const names= viaPresence? [...new Set(iv.map(x=>x.op))] : [...new Set(assigned.concat(autoOf(st).map(o=>o.name)))];
    const people=names.map(name=>{
      const wins= viaPresence? iv.filter(x=>x.op===name).map(x=>[x.a-PRES_SLACK, x.b+PRES_SLACK]) : [[dayStart, dayEnd]];
      const c={}; Object.keys(ARR).forEach(m=>c[m]=0); metricsOf(st).forEach(m=>{ c[m]=take(name,m,wins,st.name); });
      const myIv=iv.filter(x=>x.op===name), liveNow=myIv.some(x=>x.live), from=myIv.length? Math.min(...myIv.map(x=>x.a)) : null, to=myIv.length? Math.max(...myIv.map(x=>x.b)) : null;
      let sh=shiftOf(day, name, normName, today), offDay=false; if(sh&&sh.off){ sh=null; offDay=true; }
      const state= viaPresence? (liveNow? 'now' : 'done') : offDay? 'done' : !sh? 'day' : now<sh.a? 'later' : now>=sh.b? 'done' : 'now';
      const start= viaPresence? from : sh? sh.a : dayStart, end= viaPresence? to : offDay? dayStart : sh? sh.b : dayEnd;
      const placed= viaPresence? 'pc' : (how&&how[st.name]&&how[st.name][name]) || (assigned.includes(name)? 'manual' : null);
      return Object.assign({op:name, shift: sh? sh.start+'–'+sh.end : null, start, end, state, auto:!viaPresence && !assigned.includes(name), placed, viaPresence,
        loggedFrom: from? new Date(from).toISOString() : null, loggedTo: to? new Date(to).toISOString() : null, live:liveNow}, c);
    }).filter(p=>metricsOf(st).some(m=>p[m]>0) || (viaPresence && p.live));   // no work here → not shown (the account logged in now is)
    people.sort((x,y)=>{ const m=metricsOf(st)[0]; return x.start-y.start || (m? (y[m]||0)-(x[m]||0) : 0); });
    // on top: a table with reports → the account logged in now (else the last one); otherwise, of those on shift now, the one
    // doing the most work here in the last hour of activity on this card (N1 until it stops, then N2; on POD / Mapimi the one
    // doing the work now), ties → the latest scan
    let current=null;
    if(viaPresence){ const live=people.filter(p=>p.live).sort((x,y)=>y.end-x.end)[0]; const last=people.slice().sort((x,y)=>y.end-x.end)[0]; current=(live||last||{}).op||null; }
    else{ const onNow=people.filter(p=>p.state==='now'||p.state==='day'); const lastDone=people.filter(p=>p.state==='done').reduce((b,p)=> !b || p.end>b.end? p : b, null);
      const T=p=>scansAt[st.name+'|'+p.op]||[], ref=Math.max(0,...people.map(p=>Math.max(0,...T(p))));
      const score=p=>T(p).filter(t=>t>ref-3600000).length, lastT=p=>Math.max(0,...T(p));
      // takes over only with real work in that hour (10+ scans); otherwise the one with the most work here today
      const total=p=>metricsOf(st).reduce((s,m)=>s+(p[m]||0),0);
      const recent=arr=>{ const busy=arr.filter(p=>score(p)>=10); return (busy.length? busy.sort((x,y)=>score(y)-score(x) || lastT(y)-lastT(x)) : arr.slice().sort((x,y)=>total(y)-total(x) || lastT(y)-lastT(x)))[0]; };
      // after everyone's shift: the last shift (N2) stays on top — someone with real work here (10+), else the last shift at all
      const doneReal=people.filter(p=>p.state==='done' && total(p)>=10).reduce((b,p)=> !b || p.end>b.end || (p.end===b.end && total(p)>total(b))? p : b, null);
      current= onNow.length? recent(onNow).op : (doneReal||lastDone||{}).op||null; }
    const sum=k=>people.reduce((s,p)=>s+(p[k]||0),0);
    result[i]={name:st.name, label:st.label||null, kind:st.kind||null, auto:!!st.auto, co:!!st.co, ci:!!st.ci, table:st.table||null, ip:st.ip||null, viaPresence,
      orders:sum('orders'), units:sum('units'), ret:sum('ret'), map:sum('map'), out:sum('out'), pod:sum('pod'), ref:sum('ref'),
      current, people:people.map(p=>{ const c=Object.assign({},p); delete c.start; delete c.end; return c; }),
      off:viaPresence? [] : assigned.filter(n=>{ const sh=shiftOf(day,n,normName,today); return sh&&sh.off && !people.some(p=>p.op===n); })};
  });
  return result;
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

module.exports={EXTRA_STATIONS, autoPlace, tablesFor, withPod, liveByOperator, cutoffs, readAssign, saveAssign, currentAssign, stationCards, CUTS};
