#!/usr/bin/env node
/* WMS Pulse builder.
   Input:  the result rows of the 5 query blocks in pulse/queries.sql (A–E), either
             - pulse/raw/<A..E>.json (the row object of each block), or
             - read straight from Claude Code session transcripts (--from-transcripts): the latest queryWMSDb call
               whose SQL carries the marker  /*pulse:A*\/ … /*pulse:E*\/  and its result, from sessions touched
               within the last --max-age minutes (default 90).
   Output: pulse/data.json      → served by the agent at /pulse/data (app tab "WMS Pulse")
           pulse/wms-pulse.html → the same page with the data embedded (published as the artifact)
   Both outputs contain worker e-mails and pay → git-ignored, local only. */
'use strict';
const fs=require('fs'), path=require('path'), os=require('os');
const DIR=__dirname, RAW=path.join(DIR,'raw'), GROUPS=['A','B','C','D','E'], OPTIONAL=['F','G','H','I','J','K','L','M'];   // M daily board (Tabela ditore), F inbound (Inbound Flow), G orders (Order Flow), H/I/J capacity (Kapaciteti & Stafi), K shipments (Shipments), L returns (Kthimet)
const args=process.argv.slice(2), flag=f=>args.includes(f), opt=(f,d)=>{ const i=args.indexOf(f); return i>=0? args[i+1] : d; };

function fromTranscripts(maxAgeMin){
  const root=path.join(os.homedir(),'.claude','projects'), since=Date.now()-maxAgeMin*60000, found={}, failed={};
  let files=[];
  for(const d of fs.readdirSync(root)){ const p=path.join(root,d); let st; try{ st=fs.statSync(p); }catch(e){ continue; } if(!st.isDirectory()) continue;
    for(const f of fs.readdirSync(p)){ if(!f.endsWith('.jsonl')) continue; const fp=path.join(p,f); const s=fs.statSync(fp); if(s.mtimeMs>=since) files.push(fp); } }
  for(const fp of files){
    const uses={};
    for(const line of fs.readFileSync(fp,'utf8').split('\n')){ if(!line) continue; let o; try{ o=JSON.parse(line); }catch(e){ continue; }
      const c=o.message&&o.message.content; if(!Array.isArray(c)) continue;
      for(const b of c){
        if(b.type==='tool_use' && /queryWMSDb/.test(b.name||'')){ const m=/\/\*pulse:([A-M])\*\//.exec((b.input&&b.input.query)||''); if(m) uses[b.id]={g:m[1], ts:Date.parse(o.timestamp)||0}; }
        if(b.type==='tool_result' && uses[b.tool_use_id]){
          const u=uses[b.tool_use_id]; let t=Array.isArray(b.content)? b.content.map(x=>x.text||'').join('') : String(b.content||'');
          // a run that gave no row (timeout, SQL error, refused) is kept as the block's last failure, so the summary names it
          const fail=why=>{ if(!failed[u.g] || failed[u.g].ts<u.ts) failed[u.g]={ts:u.ts, error:String(why).replace(/\s+/g,' ').trim().slice(0,160)}; };
          // a large result is not inlined: Claude Code saves it to a file and the tool result names that file
          const saved=/saved to (\S+?\.txt)/.exec(t);
          if(saved){ try{ t=fs.readFileSync(saved[1],'utf8'); }catch(e){ fail('result file not readable: '+saved[1]); continue; } } else if(b.is_error){ fail(t); continue; }
          let j; try{ j=JSON.parse(t); }catch(e){ fail(t); continue; }
          const row=j.rows&&j.rows[0]; if(!row){ fail(j.error||'no row'); continue; }
          if(!found[u.g] || found[u.g].ts<u.ts) found[u.g]={ts:u.ts, row};
        } } } }
  return {found, failed};
}

let rows={}, failed={};
if(flag('--from-transcripts')){
  const t=fromTranscripts(+opt('--max-age',90)), f=t.found; failed=t.failed;
  GROUPS.concat(OPTIONAL).forEach(g=>{ if(f[g]){ rows[g]=f[g].row; rows[g]._at=new Date(f[g].ts).toISOString(); fs.mkdirSync(RAW,{recursive:true}); fs.writeFileSync(path.join(RAW,g+'.json'), JSON.stringify(f[g].row)); } });
}
GROUPS.concat(OPTIONAL).forEach(g=>{ if(!rows[g]){ const p=path.join(RAW,g+'.json'); if(fs.existsSync(p)) rows[g]=JSON.parse(fs.readFileSync(p,'utf8')); } });
const missing=GROUPS.filter(g=>!rows[g]); if(missing.length){ console.error('Missing query results for groups: '+missing.join(', ')); process.exit(2); }
const J=v=> v==null? [] : typeof v==='string'? JSON.parse(v) : v;
const A=rows.A, B=rows.B, C=rows.C, Dd=rows.D, E=rows.E;
const PL={1:'GjirafaMall',2:'Gjirafa50'};
const r1=x=>Math.round(x*10)/10;

/* The warehouse staff = the names on the work schedule, passed by the agent (--staff '{"names":[…],"aliases":{…}}'; the
   warehouse lead, 12.10.2026). Rows of any other account (temp / shared logins, Gjirafa accounts outside the warehouse,
   sellers) are left out of every list AND of the totals built from them. Rows are matched on the account's full name
   (fn / n in opsMeta). A block read before the full name was added to its query has no fn: it stays as it is until it
   runs again, and is named in staffFilter.unfiltered. Without --staff nothing is filtered. */
const normN=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
let STAFF=null; try{ const s=JSON.parse(opt('--staff','null')); if(s && s.names && s.names.length){ const set=new Set(s.names.map(normN));
  Object.entries(s.aliases||{}).forEach(([k,v])=>{ if(set.has(normN(v))) set.add(normN(k)); }); STAFF={set, n:s.names.length, from:s.from||''}; } }catch(e){}
const unfiltered=[];
const isStaff=fn=> !!fn && STAFF.set.has(normN(fn));
/* The filter starts on STAFF.from (01.09.2026, the warehouse lead 13.10.2026): days — and a pay period — before it keep every
   account, as they were. The productivity week (7 days), bands (30 days) and hour profile (14 days) lie after it.
   Active in the WMS: an account the WMS marks inactive (opsMeta.act = 0) is never counted as staff. */
const BEFORE=d=> !!(STAFF && STAFF.from && d && d<STAFF.from);
const isStaffU=m=> isStaff(m.n) && m.act!==0;
// an account with no first/last name in the WMS whose username is the name itself (no "@") is matched on the username
const rowName=r=> r.fn || (r.n && !/@/.test(r.n)? r.n : '');
const keep=(arr, label)=>{ if(!STAFF || !arr.length) return arr; if(!('fn' in arr[0])){ unfiltered.push(label); return arr; } return arr.filter(r=>isStaff(rowName(r))); };

// productivity
const week=keep(J(A.week),'A.week').map(r=>[r.n, r.ci, r.mp, r.co, r.d, r1(r.co*1.0+r.ci*0.8+r.mp*0.6)]).sort((a,b)=>b[5]-a[5]);
const bandsRaw=keep(J(A.bands),'A.bands').map(r=>[r.n, r1(+r.opd), r.d]);
const avg=bandsRaw.reduce((s,r)=>s+r[1],0)/Math.max(1,bandsRaw.length);
const sd=Math.sqrt(bandsRaw.reduce((s,r)=>s+(r[1]-avg)**2,0)/Math.max(1,bandsRaw.length));
const band=v=> v>avg+2*sd? 'Spike' : v>avg*1.25? 'Above' : v<avg*0.75? 'Below' : 'Average';
const bands=bandsRaw.map(r=>[...r, band(r[1])]);
// by hour: from the per-account hours when the staff list is given (summed for the staff only)
const hour= STAFF && A.hourU? (()=>{ const by={}; J(A.hourU).filter(r=>isStaff(r.fn)).forEach(r=>{ const o=by[r.h]||(by[r.h]=[r.h,0,0,0]); o[1]+=r.ci; o[2]+=r.mp; o[3]+=r.co; }); return Object.values(by).sort((a,b)=>a[0]-b[0]); })()
  : (STAFF && unfiltered.push('A.hour'), J(A.hour).map(r=>[r.h, r.ci, r.mp, r.co]));
// pay
const per=J(B.per);
const period=J(B.period).map(r=>[r.c, r.r, r.q, r.cost, r.q? Math.round(r.cost/r.q*1e6)/1e6 : 0]);
// a pay period that ends before STAFF.from (e.g. August 2026) keeps every paid account, as it was
const perYm= per && per.y? per.y+'-'+String(per.m).padStart(2,'0') : '';
const pay=(STAFF && STAFF.from && perYm && perYm<STAFF.from.slice(0,7)? J(B.pay) : keep(J(B.pay),'B.pay')).map(r=>[r.n, r.ci, r.mp, r.pk, r.co, r.hrs, r.cost]);
const dmy=s=>s? s.slice(8,10)+'.'+s.slice(5,7)+'.'+s.slice(0,4) : '';
const validity=r=>{ const vf=r.vf||'', vt=r.vt||'';
  if(r.op) return dmy(vf).slice(0,5)+' '+vf.slice(11)+' → aktual';
  if(vf.startsWith('1900')) return '→ '+dmy(vt);
  if(vf.slice(0,10)===vt.slice(0,10)) return dmy(vf).slice(0,5)+' '+vf.slice(11)+'–'+vt.slice(11);
  return dmy(vf)+' → '+dmy(vt); };
const rates=J(B.rates).map(r=>[r.v, r.c, r.ocp, r.tw, r.w, r.p, r.vf, r.op, validity(r)]);
// orders
const daily=J(C.daily).map(r=>[r.d, r.mall, r.g50, r.co]);
const o2c=J(C.o2c).map(r=>[PL[r.p]||String(r.p), r.n, r.avg_h, r.med_h, r.p90_h]);
const upo=J(C.upo).map(r=>[PL[r.p]||String(r.p), r.n, r.avgu, r.mx]);
const status=J(C.status).map(r=>[r.w, r.p, r.s, r.n, r.h24, r.h72]);
const statusNames={}; J(C.statusNames).forEach(r=>{ statusNames[r.s]=r.a; });
// stock
const state=J(Dd.state).map(r=>[r.s, r.n]);
const dwell=J(Dd.dwell).map(r=>[r.d, r.n, r.m]);
const sect=J(Dd.sect).map(r=>[r.id, String(r.nm||'').trim(), r.n, r.r]);
const insp=J(Dd.insp).map(r=>[r.id, String(r.nm||'').trim(), r.st, r.cd, r.sc, r.ms]);
const diff=J(Dd.diff).map(r=>[r.c, r.sku||'', r.n, r.mx, r.sm]);
// inbound
const sup=J(E.sup).map(r=>[r.wk, r.st, r.n, r.fl, r.units]);
const car=J(E.car).map(r=>[r.nm, r.stops, r.ontime, r.delay, r.pal, r.price]);
const pick=J(E.pick).map(r=>[r.n, r.s, r.m, r.o, r.sc, r.rq]);
const st=J(E.st).map(r=>[r.nm, r.ci, r.co, r.pa, r.ps]);
const inv=J(E.inv).map(r=>[r.m, r.n, r.s3, r.s1, r.qbo]);

// inbound batches (block F, optional): kept as the query's compact objects — rendered by the app's Inbound Flow page
const inb=rows.F? J(rows.F.inb) : null, inbDaily=rows.F? J(rows.F.inbDaily) : null;

// orders (block G, optional): checked out today, waiting (units reserved, not checked out), 14-day trend
const ordG=rows.G? {at:rows.G._at||null, done:J(rows.G.ord), wait:J(rows.G.wait), daily:J(rows.G.daily), unmaps:J(rows.G.unmaps)} : null;

// capacity (blocks H/I/J, optional): 12-week demand + volumes + hourly coverage + piece-rate, operators, same-day
const capacity= rows.H? { at:rows.H._at||null, from:rows.H.wFrom, to:rows.H.wTo, created:J(rows.H.created), vol:J(rows.H.vol), coOrd:J(rows.H.coOrd),
    hourly:J(rows.H.hourly), pay:J(rows.H.pay), std:J(rows.H.std), ops: rows.I&&rows.I.ops? J(rows.I.ops) : null, opsMeta: rows.I? J(rows.I.opsMeta) : null, opsDay: rows.I? J(rows.I.opsDay) : null,
    opsOrd: rows.I? J(rows.I.opsOrd) : null, rates: rows.I? J(rows.I.rates) : null,
    opsFrom: rows.I? rows.I.dFrom||null : null, opsTo: rows.I? rows.I.dTo||null : null, opsAt: rows.I? rows.I._at||null : null,
    sameDay: rows.J? J(rows.J.sameDay) : null, sameDayAt: rows.J? rows.J._at||null : null } : null;

// capacity, the staff only: the accounts and their days, orders out per day (from the per-account counts), and the
// 12-week daily volumes / orders rebuilt from those rows for the days they cover; the hourly profile has no account
// (named in staffFilter.unfiltered). An order checked out by two staff accounts counts for each (rare).
if(capacity && STAFF && capacity.opsMeta){
  // the staff's accounts; an account with days before STAFF.from stays for those days only (as it was)
  const keepU=new Set(capacity.opsMeta.filter(isStaffU).map(m=>m.u));
  const oldU=new Set((capacity.opsDay||[]).filter(r=>BEFORE(r.d)).map(r=>r.u));
  STAFF.keys=[...new Set(capacity.opsMeta.filter(m=>keepU.has(m.u)).map(m=>m.i+' #'+m.id))].sort();   // for the Bottleneck Register
  capacity.opsMeta=capacity.opsMeta.filter(m=>keepU.has(m.u) || oldU.has(m.u));
  if(capacity.opsDay) capacity.opsDay=capacity.opsDay.filter(r=>BEFORE(r.d) || keepU.has(r.u));
  const ordU= rows.I && rows.I.opsOrdU? J(rows.I.opsOrdU) : null;
  if(ordU){ const by={}; (capacity.opsOrd||[]).forEach(r=>{ if(BEFORE(r.d)) by[r.d]=r.n; });   // before STAFF.from: the all-accounts count, as it was
    ordU.forEach(r=>{ if(!BEFORE(r.d) && keepU.has(r.u)) by[r.d]=(by[r.d]||0)+r.n; }); capacity.opsOrd=Object.keys(by).sort().map(d=>({d, n:by[d]})); }
  else unfiltered.push('I.opsOrd');
  const from=capacity.opsFrom, to=capacity.opsTo, day={}, ord={};
  (capacity.opsDay||[]).forEach(r=>{ const o=day[r.d]||(day[r.d]={ci:0,mp:0,co:0,ops:0}); o.ci+=r.ci; o.mp+=r.mp; o.co+=r.co; o.ops++; });
  (capacity.opsOrd||[]).forEach(r=>ord[r.d]=r.n);
  if(from && to){   // the 12-week volumes / orders: rebuilt from the staff's rows for the days from STAFF.from only
    capacity.vol=(capacity.vol||[]).map(v=> v.d>=from && v.d<=to && !BEFORE(v.d)? Object.assign({}, v, day[v.d]||{ci:0,mp:0,co:0,ops:0}) : v);
    if(ordU) capacity.coOrd=(capacity.coOrd||[]).map(c=> c.d>=from && c.d<=to && !BEFORE(c.d)? {d:c.d, n:ord[c.d]||0} : c); }
  // the latest closed pay period: the staff's cost and actions, and the orders the staff checked out that month
  // (a period that ends before STAFF.from stays as it was)
  const P=J(B.pay), payYm= capacity.pay? capacity.pay.y+'-'+String(capacity.pay.mo).padStart(2,'0') : '';
  if(capacity.pay && STAFF.from && payYm<STAFF.from.slice(0,7)){ /* before the filter: unchanged */ }
  else if(capacity.pay && P.length && 'fn' in P[0]){ const S=P.filter(r=>isStaff(r.fn)), ym=payYm;
    const mOrd=ordU? Object.entries(ord).filter(([d])=>d.startsWith(ym)).reduce((a,[,n])=>a+n,0) : capacity.pay.orders;
    capacity.pay=Object.assign({}, capacity.pay, {tc:S.reduce((a,r)=>a+(+r.cost||0),0), ta:S.reduce((a,r)=>a+(+r.ci||0)+(+r.mp||0)+(+r.pk||0)+(+r.co||0),0), orders:mOrd}); }
  else if(capacity.pay) unfiltered.push('H.pay');
  unfiltered.push('H.hourly');
}
const shipments= rows.K? {at:rows.K._at||null, gen:rows.K.gen, stops:J(rows.K.stops), carriers:J(rows.K.carriers), trucks:J(rows.K.trucks)} : null;
const returns= rows.L? {at:rows.L._at||null, gen:rows.L.gen, batches:J(rows.L.batches), units:J(rows.L.units), disp:J(rows.L.disp), monthly:J(rows.L.monthly), dispMonthly:J(rows.L.dispMonthly), legacy:J(rows.L.legacy)} : null;
const board= rows.M? {at:rows.M._at||null, gen:rows.M.gen, outd:J(rows.M.outd), openr:J(rows.M.openr), stations:J(rows.M.stations)} : null;
// per block: when its result was read and whether it is stale. A block that was not run (or failed) keeps its previous
// result from pulse/raw/ — e.g. the board (M) of an older day, which the Tabela ditore then shows as "not refreshed today".
const today=(d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'))(new Date());
const blocks={}; GROUPS.concat(OPTIONAL).forEach(g=>{ const r=rows[g], fl=failed[g], at=r? r._at||null : null;
  if(!r && !fl) return;
  blocks[g]={at, gen: r&&r.gen || null, failedAt: fl&&(!at || fl.ts>Date.parse(at))? new Date(fl.ts).toISOString() : null, error: fl&&(!at || fl.ts>Date.parse(at))? fl.error : null}; });
const boardStale= !board || !String(board.gen||'').startsWith(today);
const data={ version:1, staffFilter: STAFF? {names:STAFF.n, from:STAFF.from||null, keys:STAFF.keys||null, unfiltered:[...new Set(unfiltered)]} : null, blocks, shipments, returns, board, inbound: inb? {at:rows.F._at||null, batches:inb, daily:inbDaily} : null, orders: ordG, capacity, generatedAt:A.gen, lastLog:A.lastLog, lastOrder:A.lastOrder, builtAt:new Date().toISOString(),
  D:{week, bands, hour, pay, period, rates, daily, o2c, upo, status, state, dwell, sect, insp, diff, sup, car, pick, st, inv},
  K:{avg:r1(avg), sd:r1(sd), per, statusNames, onShelf:Dd.onShelf, rowsStock:Dd.rowsStock, rowsTotal:Dd.rowsTotal, diffOpen:Dd.diffOpen, diffTotal:Dd.diffTotal,
     nfOpen:Dd.nfOpen, nfTotal:Dd.nfTotal, retOpen:Dd.retOpen, lateOpen:E.lateOpen, supStarted:E.supStarted} };
fs.writeFileSync(path.join(DIR,'data.json'), JSON.stringify(data));
const tpl=fs.readFileSync(path.join(DIR,'template.html'),'utf8');
const embedded=JSON.stringify(data).replace(/</g,'\\u003c');
fs.writeFileSync(path.join(DIR,'wms-pulse.html'), tpl.replace('<script id="pulse-data">window.PULSE=null;</script>', ()=>'<script id="pulse-data">window.PULSE='+embedded+';</script>'));
console.log('WMS Pulse built: data from '+data.generatedAt+' · '+week.length+' workers (7d) · '+bands.length+' (30d) · avg '+r1(avg)+' sd '+r1(sd)
  +' · inbound '+(inb? inb.length+' batches' : 'not included (block F missing)')
  +' · orders '+(ordG? ordG.done.length+' checked out today, '+ordG.wait.length+' waiting' : 'not included (block G missing)')
  +' · capacity '+(capacity? capacity.vol.length+' days, '+(capacity.ops? capacity.ops.length+' operators' : 'no operators (I missing)')+(capacity.sameDay? '' : ', no same-day (J missing)') : 'not included (block H missing)')
  +' · board '+(!board? 'not included (block M missing)' : boardStale? 'STALE (block M from '+board.gen+')' : 'from '+board.gen)
  +(blocks.M&&blocks.M.error? ' · block M failed at '+blocks.M.failedAt+': '+blocks.M.error : '')+' → pulse/data.json, pulse/wms-pulse.html');
