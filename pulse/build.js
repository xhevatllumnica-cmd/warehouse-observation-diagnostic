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
const DIR=__dirname, RAW=path.join(DIR,'raw'), GROUPS=['A','B','C','D','E'], OPTIONAL=['F','G','H','I','J','K'];   // F inbound (Inbound Flow), G orders (Order Flow), H/I/J capacity (Kapaciteti & Stafi), K shipments (Shipments)
const args=process.argv.slice(2), flag=f=>args.includes(f), opt=(f,d)=>{ const i=args.indexOf(f); return i>=0? args[i+1] : d; };

function fromTranscripts(maxAgeMin){
  const root=path.join(os.homedir(),'.claude','projects'), since=Date.now()-maxAgeMin*60000, found={};
  let files=[];
  for(const d of fs.readdirSync(root)){ const p=path.join(root,d); let st; try{ st=fs.statSync(p); }catch(e){ continue; } if(!st.isDirectory()) continue;
    for(const f of fs.readdirSync(p)){ if(!f.endsWith('.jsonl')) continue; const fp=path.join(p,f); const s=fs.statSync(fp); if(s.mtimeMs>=since) files.push(fp); } }
  for(const fp of files){
    const uses={};
    for(const line of fs.readFileSync(fp,'utf8').split('\n')){ if(!line) continue; let o; try{ o=JSON.parse(line); }catch(e){ continue; }
      const c=o.message&&o.message.content; if(!Array.isArray(c)) continue;
      for(const b of c){
        if(b.type==='tool_use' && /queryWMSDb/.test(b.name||'')){ const m=/\/\*pulse:([A-K])\*\//.exec((b.input&&b.input.query)||''); if(m) uses[b.id]={g:m[1], ts:Date.parse(o.timestamp)||0}; }
        if(b.type==='tool_result' && uses[b.tool_use_id]){
          const u=uses[b.tool_use_id]; let t=Array.isArray(b.content)? b.content.map(x=>x.text||'').join('') : String(b.content||'');
          // a large result is not inlined: Claude Code saves it to a file and the tool result names that file
          const saved=/saved to (\S+?\.txt)/.exec(t);
          if(saved){ try{ t=fs.readFileSync(saved[1],'utf8'); }catch(e){ continue; } } else if(b.is_error) continue;
          let j; try{ j=JSON.parse(t); }catch(e){ continue; }
          const row=j.rows&&j.rows[0]; if(!row) continue;
          if(!found[u.g] || found[u.g].ts<u.ts) found[u.g]={ts:u.ts, row};
        } } } }
  return found;
}

let rows={};
if(flag('--from-transcripts')){
  const f=fromTranscripts(+opt('--max-age',90));
  GROUPS.concat(OPTIONAL).forEach(g=>{ if(f[g]){ rows[g]=f[g].row; rows[g]._at=new Date(f[g].ts).toISOString(); fs.mkdirSync(RAW,{recursive:true}); fs.writeFileSync(path.join(RAW,g+'.json'), JSON.stringify(f[g].row)); } });
}
GROUPS.concat(OPTIONAL).forEach(g=>{ if(!rows[g]){ const p=path.join(RAW,g+'.json'); if(fs.existsSync(p)) rows[g]=JSON.parse(fs.readFileSync(p,'utf8')); } });
const missing=GROUPS.filter(g=>!rows[g]); if(missing.length){ console.error('Missing query results for groups: '+missing.join(', ')); process.exit(2); }
const J=v=> v==null? [] : typeof v==='string'? JSON.parse(v) : v;
const A=rows.A, B=rows.B, C=rows.C, Dd=rows.D, E=rows.E;
const PL={1:'GjirafaMall',2:'Gjirafa50'};
const r1=x=>Math.round(x*10)/10;

// productivity
const week=J(A.week).map(r=>[r.n, r.ci, r.mp, r.co, r.d, r1(r.co*1.0+r.ci*0.8+r.mp*0.6)]).sort((a,b)=>b[5]-a[5]);
const bandsRaw=J(A.bands).map(r=>[r.n, r1(+r.opd), r.d]);
const avg=bandsRaw.reduce((s,r)=>s+r[1],0)/Math.max(1,bandsRaw.length);
const sd=Math.sqrt(bandsRaw.reduce((s,r)=>s+(r[1]-avg)**2,0)/Math.max(1,bandsRaw.length));
const band=v=> v>avg+2*sd? 'Spike' : v>avg*1.25? 'Above' : v<avg*0.75? 'Below' : 'Average';
const bands=bandsRaw.map(r=>[...r, band(r[1])]);
const hour=J(A.hour).map(r=>[r.h, r.ci, r.mp, r.co]);
// pay
const per=J(B.per);
const period=J(B.period).map(r=>[r.c, r.r, r.q, r.cost, r.q? Math.round(r.cost/r.q*1e6)/1e6 : 0]);
const pay=J(B.pay).map(r=>[r.n, r.ci, r.mp, r.pk, r.co, r.hrs, r.cost]);
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
    hourly:J(rows.H.hourly), pay:J(rows.H.pay), std:J(rows.H.std), ops: rows.I? J(rows.I.ops) : null, opsAt: rows.I? rows.I._at||null : null,
    sameDay: rows.J? J(rows.J.sameDay) : null, sameDayAt: rows.J? rows.J._at||null : null } : null;

const shipments= rows.K? {at:rows.K._at||null, gen:rows.K.gen, stops:J(rows.K.stops), carriers:J(rows.K.carriers), trucks:J(rows.K.trucks)} : null;
const data={ version:1, shipments, inbound: inb? {at:rows.F._at||null, batches:inb, daily:inbDaily} : null, orders: ordG, capacity, generatedAt:A.gen, lastLog:A.lastLog, lastOrder:A.lastOrder, builtAt:new Date().toISOString(),
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
  +' · capacity '+(capacity? capacity.vol.length+' days, '+(capacity.ops? capacity.ops.length+' operators' : 'no operators (I missing)')+(capacity.sameDay? '' : ', no same-day (J missing)') : 'not included (block H missing)')+' → pulse/data.json, pulse/wms-pulse.html');
