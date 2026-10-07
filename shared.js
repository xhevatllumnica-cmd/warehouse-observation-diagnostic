/* ============================================================================
   WODS shared module — pure functions over the app database, usable from BOTH
   the browser (window.WODS, loaded before app.js) and Node (require('./shared.js')
   from wms-agent.js). Nothing here touches the DOM or localStorage.

   Contents:
     · small text/date helpers
     · WMS import (stats / prepared / check-in / flow) — same dedupe rules as before
     · wmsDayFacts(db,date)          → the WMS figures of one day
     · wmsAutoObservations(db,date)  → rule-based findings from WMS figures, shaped as
                                        Daily Observation records (fact / hypothesis / validation)
     · buildDailyNarrative(db,date)  → the narrative daily report (HTML + plain text)
   ==========================================================================*/
(function(root, factory){
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.WODS = mod;
})(typeof self !== 'undefined' ? self : this, function(){
'use strict';

/* ------------------------------------------------------------------ helpers */
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v,d)=>{ const n=parseFloat(v); return isNaN(n)?(d||0):n; };
const uid = p => (p||'id')+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const nowISO = ()=> new Date().toISOString();
const p2 = n => ('0'+n).slice(-2);
const localDate = t => { t=t||new Date(); return t.getFullYear()+'-'+p2(t.getMonth()+1)+'-'+p2(t.getDate()); };
const localTime = t => { t=t||new Date(); return p2(t.getHours())+':'+p2(t.getMinutes()); };
const dobj = s => { const p=(s||'').split('-').map(Number); return new Date(p[0],(p[1]||1)-1,p[2]||1); };
const fmtDateAl = d => { const p=(d||'').split('-'); return p.length===3?`${p[2]}.${p[1]}.${p[0]}`:d; };
const AL_DAYS=['E diel','E hënë','E martë','E mërkurë','E enjte','E premte','E shtunë'];
const slAl = items => { items=items.filter(Boolean); if(!items.length) return ''; if(items.length===1) return items[0]; return items.slice(0,-1).join(', ')+' dhe '+items[items.length-1]; };
const fs1 = (s,max)=>{ max=max||190; s=String(s||'').replace(/\s+/g,' ').trim(); if(!s) return '';
  const parts=s.split(/(?<=[.!?])\s+(?=[A-ZÇË“"(\d])/); let r=parts[0].trim();
  if(r.length>max) r=r.slice(0,max-1).replace(/\s+\S*$/,'')+'…'; return r; };
const lc1 = s => { s=String(s||''); return (s.length>1 && s[1]!==s[1].toUpperCase()) ? s[0].toLowerCase()+s.slice(1) : s; };
const trimEnd = s => String(s||'').replace(/[.;:,\s]+$/,'');
const stripHyp = s => String(s||'').replace(/^\s*hipotez[^\s(:]*\s*(\([^)]*\))?\s*[:\-–]\s*/i,'');
const stripTags = html => String(html||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");

const PHASES = [
  {n:1, name:'Observe & Understand', from:1, to:10},
  {n:2, name:'Map & Measure',        from:11,to:20},
  {n:3, name:'Stabilize',            from:21,to:25},
  {n:4, name:'Improve & Report',     from:26,to:30},
];
const col = (db,name)=> db[name] || (db[name]=[]);
const cfg = db => db.config || (db.config={});
const workDays = db => { const w=cfg(db).workDays; return (Array.isArray(w)&&w.length)? w : [1,2,3,4,5]; };
function isWorkDay(db, dateStr){ if(!dateStr) return false; if(!workDays(db).includes(dobj(dateStr).getDay())) return false; return !(cfg(db).holidays||[]).includes(dateStr); }
function workingDaysCount(db,start,end){ if(!start||!end||end<start) return 0; let n=0, t=dobj(start); const e=dobj(end);
  for(; t<=e; t.setDate(t.getDate()+1)){ if(isWorkDay(db, localDate(t))) n++; } return n; }
function dayNumber(db, date){ return Math.min(30, Math.max(1, workingDaysCount(db, cfg(db).startDate, date))); }
function phaseFor(db, date){ const a=cfg(db).activePhases; const day=dayNumber(db,date);
  if(Array.isArray(a)&&a.length){ const objs=a.slice().sort((x,y)=>x-y).map(n=>PHASES.find(p=>p.n===n)).filter(Boolean); if(objs.length) return {n:objs.map(o=>o.n).join('+'), name:objs.map(o=>o.name).join(' + ')}; }
  return PHASES.find(p=>day>=p.from&&day<=p.to) || PHASES[3]; }
const procName = (db,id)=>{ const p=col(db,'processes').find(x=>x.id===id); return p?p.name:''; };
const procIdByName = (db,name)=>{ const p=col(db,'processes').find(x=>x.name===name); return p?p.id:''; };

/* ------------------------------------------------------------- WMS imports */
/* (same semantics as the previous in-app functions: key = date|operator, update on change, count dups) */
function importStats(db, obj, meta){ meta=meta||{};
  const rec={ id:uid('wst'), at:nowISO(), date:(meta.date||localDate()),
    invoiceProductsCheckedIn:num(obj.invoiceProductsCheckedIn), invoiceProductsProcessed:num(obj.invoiceProductsProcessed),
    invoiceProductsToCheckIn:num(obj.invoiceProductsToCheckIn), ordersReadyToUnmap:num(obj.ordersReadyToUnmap),
    ordersInProcessing:num(obj.ordersInProcessing), source:'WMS', sourceRef:meta.sourceRef||'', importedAt:nowISO() };
  col(db,'wmsStats').unshift(rec); return rec; }
function syncLog(db, operation, meta, rows, ins, upd, dups, t0){
  col(db,'wmsSyncLog').unshift({ id:uid('slog'), at:nowISO(), operation, dateRange:(meta&&meta.dateRange)||'',
    retrieved:rows.length, inserted:ins, updated:upd, duplicates:dups, warnings:0, errors:0, durationMs:Date.now()-t0, status:'VALID' }); }
function importPrepared(db, rows, meta){ meta=meta||{}; const t0=Date.now(); const c=col(db,'wmsPrepared');
  const key=r=>['WMS',r.date,r.operator].join('|'); let ins=0,upd=0,dups=0;
  (rows||[]).forEach(raw=>{
    const rec={ date:(raw.date||'').slice(0,10), operator:(raw.operator||raw.Name||'').toString().trim(),
      preparedOrders:num(raw.preparedOrders!=null?raw.preparedOrders:raw.PreparedOrders), source:'WMS', sourceRef:meta.sourceRef||'', importedAt:nowISO() };
    if(!rec.date||!rec.operator) return;
    const k=key(rec); const ex=c.find(x=>key(x)===k);
    if(ex){ if(ex.preparedOrders!==rec.preparedOrders){ ex.preparedOrders=rec.preparedOrders; ex.importedAt=rec.importedAt; upd++; } else dups++; }
    else { rec.id=uid('wp'); c.unshift(rec); ins++; } });
  syncLog(db,'Prepared orders import',meta,rows||[],ins,upd,dups,t0);
  return {inserted:ins,updated:upd,dups}; }
function importCheckin(db, rows, meta){ meta=meta||{}; const t0=Date.now(); const c=col(db,'wmsCheckin');
  const key=r=>['WMS',r.date,r.operator].join('|'); let ins=0,upd=0,dups=0;
  (rows||[]).forEach(raw=>{
    const rec={ date:(raw.date||'').slice(0,10), operator:(raw.operator||'').toString().trim(),
      checkedIn:num(raw.checkedIn!=null?raw.checkedIn:raw.CheckedIn), checkedOut:num(raw.checkedOut!=null?raw.checkedOut:raw.CheckedOut),
      source:'WMS', sourceRef:meta.sourceRef||'', importedAt:nowISO() };
    if(!rec.date||!rec.operator) return;
    const k=key(rec); const ex=c.find(x=>key(x)===k);
    if(ex){ if(ex.checkedIn!==rec.checkedIn || ex.checkedOut!==rec.checkedOut){ ex.checkedIn=rec.checkedIn; ex.checkedOut=rec.checkedOut; ex.importedAt=rec.importedAt; upd++; } else dups++; }
    else { rec.id=uid('wc'); c.unshift(rec); ins++; } });
  syncLog(db,'Products checked in import',meta,rows||[],ins,upd,dups,t0);
  return {inserted:ins,updated:upd,dups}; }
function importFlow(db, daily, meta){ meta=meta||{}; const c=col(db,'wmsFlow');
  (daily||[]).forEach(raw=>{ const date=(raw.date||'').slice(0,10); if(!date) return;
    const rec={ date, checkedIn:num(raw.checkedIn), checkedOut:num(raw.checkedOut), source:'WMS', sourceRef:meta.sourceRef||'', importedAt:nowISO() };
    const ex=c.find(x=>x.date===date);
    if(ex){ ex.checkedIn=rec.checkedIn; ex.checkedOut=rec.checkedOut; ex.importedAt=rec.importedAt; } else { rec.id=uid('wf'); c.unshift(rec); } }); }

/* ------------------------------------------------------ WMS figures per day */
const GENERIC_RE = /\btemp\b|\bacc\b|pa operator|admin@|\btest\b/i;
function wmsDayFacts(db, d){
  const prep=col(db,'wmsPrepared').filter(r=>r.date===d);
  const chk=col(db,'wmsCheckin').filter(r=>r.date===d);
  const flow=col(db,'wmsFlow').find(f=>f.date===d);
  const snaps=col(db,'wmsStats').filter(s=>s.date===d).sort((a,b)=>a.at<b.at?-1:1);
  if(!prep.length && !chk.length && !flow && !snaps.length) return null;
  const byOp={}; prep.forEach(r=>byOp[r.operator]=(byOp[r.operator]||0)+num(r.preparedOrders));
  const ops=Object.entries(byOp).sort((a,b)=>b[1]-a[1]);
  const total=ops.reduce((a,x)=>a+x[1],0);
  const ciByOp={}, coByOp={}; chk.forEach(r=>{ ciByOp[r.operator]=(ciByOp[r.operator]||0)+num(r.checkedIn); coByOp[r.operator]=(coByOp[r.operator]||0)+num(r.checkedOut); });
  const ciOps=Object.entries(ciByOp).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
  const coOps=Object.entries(coByOp).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
  // baseline: previous working days with Prepared data
  const wd=workDays(db); const pb={};
  col(db,'wmsPrepared').forEach(r=>{ if(r.date<d && wd.includes(dobj(r.date).getDay())) pb[r.date]=(pb[r.date]||0)+num(r.preparedOrders); });
  const pbv=Object.values(pb); const prepAvg=pbv.length? Math.round(pbv.reduce((a,b)=>a+b,0)/pbv.length) : null;
  const ci = flow?num(flow.checkedIn):(chk.length?Object.values(ciByOp).reduce((a,b)=>a+b,0):null);
  const co = flow?num(flow.checkedOut):(chk.length?Object.values(coByOp).reduce((a,b)=>a+b,0):null);
  const generic=ops.filter(o=>GENERIC_RE.test(o[0])); const genericPrep=generic.reduce((a,x)=>a+x[1],0);
  const genericEvents=chk.filter(r=>GENERIC_RE.test(r.operator)).reduce((a,r)=>a+num(r.checkedIn)+num(r.checkedOut),0);
  return { date:d, prep:total, ops, prepAvg, prepDays:pbv.length, ciOps, coOps,
    checkedIn:ci, checkedOut:co, outRate: ci>0? Math.round(co/ci*100) : null,
    generic, genericPrep, genericEvents, first:snaps[0]||null, last:snaps[snaps.length-1]||null, isWorkDay:isWorkDay(db,d) };
}

/* ------------------------------------------- rule-based findings → observations */
/* Each finding becomes a Daily Observation record: FACT in `what`, suspicion in `cause`, a concrete check in
   `validationAction`. Deduped by analysisKey (WMSAUTO-<date>-<rule>) so re-runs never duplicate. */
function wmsAutoObservations(db, d, time){
  const W=wmsDayFacts(db,d); if(!W) return [];
  time=time||'21:30';
  const P={picking:procIdByName(db,'Picking'), checkin:procIdByName(db,'Check-in'), checkout:procIdByName(db,'Packing/Check-out')};
  const base={ date:d, time, location:'WMS (të dhëna sistemi) — i gjithë depoja', source:'WMS auto-analysis', auto:true, analysisDate:d,
    interruption:false, rework:false, error:false, interruptionDetail:'', reworkDetail:'', errorDetail:'', waitingMin:'', processingMin:'', attachments:[],
    evidenceLink:'https://wms.gjirafamall.com/', validationStatus:'Pending validation', validationResult:'', status:'Observed' };
  const out=[]; const add=(rule,o)=>out.push(Object.assign({}, base, o, {analysisKey:'WMSAUTO-'+d+'-'+rule}));
  const fmt=fmtDateAl(d);

  // R1 · same-day flow: check-out vs check-in
  if(W.checkedIn!=null && W.checkedIn>=100 && W.outRate!=null && W.outRate<75){
    add('flow',{ processId:P.checkout, subProcess:'Bilanci ditor produkte: check-out kundrejt check-in', type: W.outRate<50?'Bottleneck':'Delay / Waiting', severity: W.outRate<50?'Critical':'Important',
      staffText:'Ekipi inbound + outbound', ref:`ProductLogs ${fmt}: Checked in ${W.checkedIn} · Check out ${W.checkedOut}`,
      what:`Më ${fmt} u bënë check-in ${W.checkedIn} produkte dhe check-out ${W.checkedOut} (${W.outRate}%). Diferenca ${W.checkedIn-W.checkedOut} produkte mbeten në depo në fund të ditës.`,
      expected:'Vëllimi i check-out përafron atë të check-in brenda ditës (Out/In ≈ 100%) — porosia e sotme dërgohet sot.',
      actual:`Dolën vetëm ${W.outRate}% e produkteve që hynë.`,
      evidence:'System record: WMS /Warehouse/ProductLogs, LogType «Checked in» vs «Check out», dita kalendarike.',
      impact:`+${W.checkedIn-W.checkedOut} produkte shtohen stokut në pritje; backlog-u i porosive rritet në vend që të ulet.`,
      cause:'HIPOTEZË (e pakonfirmuar): kapaciteti i picking/check-out është nën atë të pranimit; ose një pjesë e check-in është stok pa porosi; ose check-out nuk skanohet për çdo dërgim.',
      validationMethod:'Check system data', validationAction:'Krahaso për 3 ditë porositë e dërguara fizikisht (lista e transportuesit) me eventet «Check out». Ndaj porositë «in processing» sipas moshës dhe statusit (pret stok / gati për picking).', followUpDate:nextWorkDay(db,d,2) });
  }
  // R2 · prepared orders vs baseline
  if(W.prep>0 && W.prepAvg!=null && W.prepDays>=2 && W.isWorkDay){
    const diff=Math.round((W.prep-W.prepAvg)/W.prepAvg*100);
    if(diff<=-15) add('prep-low',{ processId:P.picking, subProcess:'Porosi të përgatitura nën mesataren', type:'Delay / Waiting', severity: diff<=-30?'Critical':'Important',
      staffText: W.ops.slice(0,5).map(o=>o[0]).join(', '), ref:`GetPreparedOrders ${fmt}: ${W.prep} porosi`,
      what:`Më ${fmt} u përgatitën ${W.prep} porosi, ${Math.abs(diff)}% nën mesataren e ${W.prepDays} ditëve të mëparshme të punës (${W.prepAvg}). ${W.ops.length} llogari me porosi; më të lartat: ${W.ops.slice(0,3).map(o=>`${o[0]} ${o[1]}`).join(', ')}.`,
      expected:`Output ditor në nivelin e mesatares (~${W.prepAvg}) ose mbi, drejt targetit 1000/ditë.`, actual:`${W.prep} porosi (${diff}%).`,
      evidence:'System record: WMS /Order/GetPreparedOrders për operator, agreguar për ditën.',
      impact:`~${W.prepAvg-W.prep} porosi më pak se një ditë normale — kalojnë për nesër.`,
      cause:'HIPOTEZË: mungesë operatorësh në turn, ndërprerje nga pranimi i madh, ose mungesë porosish gati për picking (pritje stoku).',
      validationMethod:'Compare shifts', validationAction:'Merr rosterin e ditës (kush mungoi / u zhvendos). Krahaso me numrin e porosive të vendosura atë ditë. Pyet team lead-in çfarë e ndali picking-un.', followUpDate:nextWorkDay(db,d,1) });
    else if(diff>=15) add('prep-high',{ processId:P.picking, subProcess:'Porosi të përgatitura mbi mesataren', type:'Observed Current Practice', severity:'Improvement',
      staffText: W.ops.slice(0,5).map(o=>o[0]).join(', '), ref:`GetPreparedOrders ${fmt}: ${W.prep} porosi`,
      what:`Më ${fmt} u përgatitën ${W.prep} porosi, ${diff}% mbi mesataren e ${W.prepDays} ditëve të mëparshme të punës (${W.prepAvg}). Më të lartat: ${W.ops.slice(0,3).map(o=>`${o[0]} ${o[1]}`).join(', ')}.`,
      expected:`~${W.prepAvg} porosi/ditë (mesatarja).`, actual:`${W.prep} porosi (+${diff}%).`,
      evidence:'System record: WMS /Order/GetPreparedOrders për operator.',
      impact:'Tregon që kapaciteti për output më të lartë ekziston — duhet kuptuar çfarë e mundësoi.',
      cause:'HIPOTEZË: më shumë porosi gati në fillim të turnit, më pak ndërprerje, ose operator shtesë në picking.',
      validationMethod:'Interview operator', validationAction:'Pyet pickers-at dhe team lead-in çfarë ishte ndryshe sot (porosi gati, staf, ndërprerje). Shëno kushtet që të përsëriten.', followUpDate:nextWorkDay(db,d,1) });
  }
  // R3 · picking concentration on 2 people
  if(W.prep>=200 && W.ops.length>=3){ const [a,b]=W.ops; const share=Math.round((a[1]+b[1])/W.prep*100);
    if(share>=60) add('pick-conc',{ processId:P.picking, subProcess:'Përqendrimi i picking te 2 operatorë', type:'Resource issue', severity:'Important',
      staffText: W.ops.slice(0,6).map(o=>o[0]).join(', '), ref:`GetPreparedOrders ${fmt}`,
      what:`Më ${fmt}, ${a[0]} (${a[1]}) dhe ${b[0]} (${b[1]}) përgatitën ${share}% e ${W.prep} porosive. Të tjerët: ${W.ops.slice(2,7).map(o=>`${o[0]} ${o[1]}`).join(', ')}.`,
      expected:'Ngarkesa e picking e shpërndarë; asnjë person > 30% e output-it ditor.', actual:`2 persona = ${share}%.`,
      evidence:'System record: Prepared orders për operator/ditë.',
      impact:'Mungesa e njërit prej të dyve = rënie e menjëhershme e output-it; varësi nga individë.',
      cause:'HIPOTEZË: vetëm 2–3 pickers me kohë të plotë; pjesa tjetër bën check-out/paketim ose s\'është trajnuar për picking.',
      validationMethod:'Interview operator', validationAction:'Plotëso Staff Capability Matrix për picking. Vëzhgo 1 orë zonën e picking: sa persona picking aktiv njëkohësisht.', followUpDate:nextWorkDay(db,d,2) });
  }
  // R4 · check-in concentration
  if(W.checkedIn>=200 && W.ciOps.length>=2){ const a=W.ciOps[0]; const share=Math.round(a[1]/W.checkedIn*100);
    if(share>=60) add('ci-conc',{ processId:P.checkin, subProcess:'Check-in i mbajtur nga një operator', type:'Resource issue', severity:'Important',
      staffText: W.ciOps.slice(0,4).map(o=>o[0]).join(', '), ref:`ProductLogs «Checked in» ${fmt}`,
      what:`Më ${fmt}, ${a[0]} bëri ${a[1]} nga ${W.checkedIn} check-in (${share}%). ${W.ciOps.length>1?`Pas tij: ${W.ciOps.slice(1,4).map(o=>`${o[0]} ${o[1]}`).join(', ')}.`:''}`,
      expected:'Check-in i mbuluar nga ≥3 operatorë të trajnuar për turn.', actual:`Një person = ${share}% e pranimit.`,
      evidence:'System record: ProductLogs evente «Checked in» për operator.',
      impact:'Single point of failure në inbound — mungesa e tij ndal ose ngadalëson pranimin.',
      cause:'HIPOTEZË: numër i kufizuar stacionesh/skanerësh check-in ose vetëm pak përdorues me të drejta check-in në WMS.',
      validationMethod:'Physical inspection', validationAction:'Numëro stacionet check-in aktive dhe skanerët. Kontrollo në WMS sa përdorues kanë rol check-in.', followUpDate:nextWorkDay(db,d,2) });
  }
  // R5 · generic / shared accounts
  if((W.prep>0 && W.genericPrep/W.prep>=0.10) || W.genericEvents>=30){
    const gp=W.generic.map(o=>`«${o[0]}» ${o[1]} porosi`).join(', ');
    add('generic',{ processId:P.picking, subProcess:'Punë nën llogari gjenerike / të përbashkëta', type:'Process deviation', severity:'Important',
      staffText: W.generic.map(o=>o[0]).join(', ')||'(pa operator)', ref:`GetPreparedOrders + ProductLogs ${fmt}`,
      what:`Më ${fmt}, punë e regjistruar nën llogari pa emër personi: ${gp||'—'}${W.prep?` (${Math.round(W.genericPrep/W.prep*100)}% e porosive të përgatitura)`:''}${W.genericEvents?`; ${W.genericEvents} evente check-in/out nën llogari gjenerike ose pa operator`:''}.`,
      expected:'Çdo veprim në WMS i lidhur me një person të identifikuar.', actual:'Një pjesë e punës nuk mund t\'i atribuohet një personi.',
      evidence:'System record: kolona Name (Prepared) dhe UpdatedByName (ProductLogs).',
      impact:'Gabimet nën këto llogari nuk gjurmohen te personi; produktiviteti individual dhe cost-per-order maten të paplota.',
      cause:'HIPOTEZË: llogari të përkohshme për staf të ri/sezonal të pazëvendësuara, ose login i përbashkët në një stacion fiks.',
      validationMethod:'Interview operator', validationAction:'Pyet team lead-in kush punoi nën këto llogari (rosteri). Kërko llogari personale nga IT/HQ.', followUpDate:nextWorkDay(db,d,1) });
  }
  // R6 · backlog at close
  if(W.last){ const ip=num(W.last.ordersInProcessing), rd=num(W.last.ordersReadyToUnmap); const first=W.first&&W.first!==W.last?num(W.first.ordersInProcessing):null;
    if(ip>0 || rd>0) add('close',{ processId:P.checkout, subProcess:'Mbyllja e ditës — porosi të mbetura në WMS', type:'Observed Current Practice', severity: rd>50||(first!=null&&ip>=first)?'Important':'Improvement',
      staffText:'Turni i mbylljes', ref:`GetDashboardStats ${fmt} ${localTime(new Date(W.last.at))}`,
      what:`Në ${localTime(new Date(W.last.at))} më ${fmt}, WMS tregonte ${ip} porosi në procesim${first!=null?` (${ip-first>=0?'+':'−'}${Math.abs(ip-first)} që nga matja e parë e ditës në ${localTime(new Date(W.first.at))})`:''} dhe ${rd} porosi gati për përfundim.${W.prep?` Gjatë ditës u përgatitën ${W.prep} porosi.`:''}`,
      expected:'Dita mbyllet me «ready to complete» në zero dhe backlog-un e ditës të përfunduar.', actual:`${rd} porosi gati të papërfunduara; ${ip} në procesim kalojnë për nesër.`,
      evidence:'System record: snapshot-et GetDashboardStats të ditës.',
      impact: first!=null&&ip>=first ? 'Backlog-u nuk u ul gjatë ditës — puna e ditës mbuloi vetëm hyrjet e reja.' : 'Carry-over për ditën tjetër; hapi i fundit (complete/unmap) mbetet pas.',
      cause:'HIPOTEZË: hapi i fundit bëhet nga një person tjetër/më vonë; ose porositë «in processing» presin stok që s\'ka mbërritur.',
      validationMethod:'Check system data', validationAction:'Ndaj porositë «in processing» sipas moshës (0–1 / 2–3 / >3 ditë) dhe arsyes së pritjes. Pyet kush e bën «complete» dhe kur.', followUpDate:nextWorkDay(db,d,1) });
  }
  return out;
}
function nextWorkDay(db, d, n){ let t=dobj(d); let k=0; while(k<(n||1)){ t.setDate(t.getDate()+1); if(isWorkDay(db,localDate(t))) k++; } return localDate(t); }

/* ------------------------------------------------------------- day metrics */
function dayMetrics(db,date){
  const obs=col(db,'observations').filter(o=>o.date===date);
  const meas=col(db,'measurements').filter(m=>m.date===date);
  let oInt=0,oRew=0,err=0,withHyp=0,validated=0,pending=0;
  obs.forEach(o=>{ if(o.interruption)oInt++; if(o.rework)oRew++; if(o.error)err++; if(o.cause)withHyp++;
    if(o.validationStatus==='Validated')validated++; if(o.validationStatus==='Pending validation')pending++; });
  let mInt=0,mRew=0,procSec=0,waitSec=0;
  meas.forEach(m=>{ mInt+=m.interruptions||0; mRew+=m.rework||0; procSec+=m.processingSec||0; waitSec+=m.waitingSec||0; });
  const waitMin=waitSec/60 + obs.reduce((a,o)=>a+num(o.waitingMin,0),0);
  const procMin=procSec/60 + obs.reduce((a,o)=>a+num(o.processingMin,0),0);
  const total=waitMin+procMin, activity=obs.length+meas.length;
  const neg=oInt+mInt+oRew+mRew+err;
  return { date, obsN:obs.length, measN:meas.length, activity, interruptions:oInt+mInt, rework:oRew+mRew, errors:err,
    withHyp, validated, pending, waitMin, procMin, waitShare: total>0? waitMin/total*100 : null,
    neg, negRate: activity>0? neg/activity : 0, problems: col(db,'problems').filter(p=>p.dateIdentified===date).length };
}
function priorBaseline(db,d){
  const dates=[...new Set([...col(db,'observations').map(o=>o.date), ...col(db,'measurements').map(m=>m.date)])].filter(x=>x&&x<d);
  const days=dates.map(x=>dayMetrics(db,x)).filter(m=>m.activity>0);
  if(!days.length) return null;
  const ws=days.filter(m=>m.waitShare!=null);
  return { n:days.length, negRate: days.reduce((a,m)=>a+m.negRate,0)/days.length, waitShare: ws.length? ws.reduce((a,m)=>a+m.waitShare,0)/ws.length : null };
}

/* --------------------------------------------------------- daily narrative */
/* Returns {html, text, stats}. html is the narrative block only (the app appends its own detail tables). */
function buildDailyNarrative(db, d, opts){
  opts=opts||{}; const h=esc;
  const rows=col(db,'observations').filter(o=>o.date===d).slice().sort((a,b)=>(a.time||'')<(b.time||'')?-1:1);
  const W=wmsDayFacts(db,d);
  if(!rows.length && !W) return {html:'', text:'', empty:true};
  const byType={}, byProc={}, bySev={}, procRows={};
  let withHyp=0,validated=0,pending=0;
  rows.forEach(o=>{ byType[o.type||'—']=(byType[o.type||'—']||0)+1;
    const pn=procName(db,o.processId)||'I pacaktuar'; byProc[pn]=(byProc[pn]||0)+1; (procRows[pn]=procRows[pn]||[]).push(o);
    if(o.severity) bySev[o.severity]=(bySev[o.severity]||0)+1;
    if(o.cause) withHyp++; if(o.validationStatus==='Validated') validated++; if(o.validationStatus==='Pending validation') pending++; });
  const topType=Object.entries(byType).sort((a,b)=>b[1]-a[1]);
  const topProc=Object.entries(byProc).sort((a,b)=>b[1]-a[1]);
  const nProc=Object.keys(byProc).length;
  const sevRank={Critical:0,Important:1,Improvement:2,Minor:3};
  const bySevRank=(a,b)=>((sevRank[a.severity]!=null?sevRank[a.severity]:9)-(sevRank[b.severity]!=null?sevRank[b.severity]:9));
  const M=dayMetrics(db,d), B=priorBaseline(db,d);
  const dayN=dayNumber(db,d), ph=phaseFor(db,d);
  const wdOff=!isWorkDay(db,d);

  // 1 · context
  const ctx=[];
  ctx.push(`<b>${AL_DAYS[dobj(d).getDay()]}, ${h(fmtDateAl(d))}</b> — ${wdOff?'ditë jashtë kalendarit të punës, ':''}dita e punës ${dayN}/30 e vëzhgimit, faza ${h(String(ph.n))} (${h(ph.name)}).`);
  if(W){
    if(W.prep){ let s=`Sipas WMS, gjatë ditës u përgatitën <b>${W.prep} porosi</b>`;
      if(W.prepAvg!=null && W.prepDays>=1){ const diff=Math.round((W.prep-W.prepAvg)/W.prepAvg*100); s+=`, ${Math.abs(diff)<=5?'në nivelin e':(diff<0?`${Math.abs(diff)}% nën`:`${diff}% mbi`)} mesataren e ${W.prepDays} ditëve të mëparshme të punës (${W.prepAvg})`; }
      if(W.ops.length>=2){ const a=W.ops[0], b=W.ops[1]; const share=Math.round((a[1]+b[1])/W.prep*100); s+=`; ngarkesën e mbajtën kryesisht ${h(a[0])} (${a[1]}) dhe ${h(b[0])} (${b[1]}), ${share}% e totalit`; }
      else if(W.ops.length===1) s+=` — të gjitha nga ${h(W.ops[0][0])}`;
      ctx.push(s+'.'); }
    if(W.checkedIn!=null){ let s=`Në rrjedhën e produkteve, <b>${W.checkedIn}</b> u bënë check-in dhe <b>${W.checkedOut}</b> check-out`;
      if(W.outRate!=null) s+=` — pra ${W.outRate}% e asaj që hyri, doli po atë ditë${W.outRate<75?'; pjesa tjetër shtohet stokut në pritje':''}`;
      if(W.ciOps.length===1) s+=`. Pranimin e bëri vetëm ${h(W.ciOps[0][0])} (${W.ciOps[0][1]})`;
      else if(W.ciOps.length>=2){ const a=W.ciOps[0], b=W.ciOps[1]; const combPct=W.checkedIn?Math.round((a[1]+b[1])/W.checkedIn*100):null;
        s+=`. Pranimin e mbajtën kryesisht ${h(a[0])} (${a[1]}${W.checkedIn?`, ${Math.round(a[1]/W.checkedIn*100)}%`:''}) dhe ${h(b[0])} (${b[1]}${W.checkedIn?`, ${Math.round(b[1]/W.checkedIn*100)}%`:''})${combPct!=null?` — ${combPct}% e totalit`:''}`; }
      ctx.push(s+'.'); }
    if(W.last){ let s=`Në ${opts.closing?'mbyllje të turnit':'matjen e fundit të ditës'} (${localTime(new Date(W.last.at))}), WMS tregonte <b>${num(W.last.ordersInProcessing)} porosi në procesim</b>`;
      if(W.first && W.first!==W.last && num(W.first.ordersInProcessing)!==num(W.last.ordersInProcessing)){ const dlt=num(W.last.ordersInProcessing)-num(W.first.ordersInProcessing); s+=` (${dlt<0?'−':'+'}${Math.abs(dlt)} që nga matja e parë e ditës)`; }
      s+=` dhe ${num(W.last.ordersReadyToUnmap)} gati për përfundim.`; ctx.push(s); }
  }
  const sevWords=[]; if(bySev.Critical) sevWords.push(`${bySev.Critical} kritike`); if(bySev.Important) sevWords.push(`${bySev.Important} të rëndësishme`); if(bySev.Improvement) sevWords.push(`${bySev.Improvement} për përmirësim`); if(bySev.Minor) sevWords.push(`${bySev.Minor} të vogla`);
  const nAuto=rows.filter(o=>o.auto).length;
  if(rows.length) ctx.push(`Në ditar u regjistruan <b>${M.obsN} vëzhgime</b>${nAuto?` (${nAuto} nga analiza automatike e shifrave WMS)`:''}${M.measN?` dhe ${M.measN} matje`:''} në ${nProc} proces${nProc!==1?'e':''}${sevWords.length?` — ${slAl(sevWords)}`:''}${M.obsN>=3&&topType.length?`; pjesa më e madhe e tipit “${h(topType[0][0])}”`:''}.`);
  else ctx.push(`Në ditar nuk u regjistruan vëzhgime për këtë ditë — raporti mbështetet vetëm te shifrat e WMS.`);

  // 2 · what was seen
  const seen=Object.entries(procRows).sort((a,b)=>b[1].length-a[1].length).map(([pn,list])=>{
    list=list.slice().sort(bySevRank);
    const items=list.map(o=>{ const t=trimEnd(o.subProcess? fs1(o.subProcess,110) : fs1(o.what,170)); return h(lc1(t))+(o.severity==='Critical'?' <span class="etag et-hyp" style="margin-left:2px">kritike</span>':''); });
    return `<b>${h(pn)}</b> (${list.length}): ${items.join('; ')}.`; });

  // 3 · what it means
  const impacts=rows.filter(o=>o.impact).sort(bySevRank).map(o=>trimEnd(fs1(o.impact,200)));
  let meaning='';
  if(impacts.length){ meaning=`Ndikimi kryesor: ${h(impacts[0])}.`; if(impacts.length>1) meaning+=` Përtej kësaj, ${h(slAl(impacts.slice(1,4).map(lc1)))}${impacts.length>4?`, si dhe ${impacts.length-4} efekte të tjera të shënuara në ditar`:''}.`; }
  if(M.waitMin||M.procMin) meaning+=` Koha e matur: ${Math.round(M.procMin)} min punë aktive dhe ${Math.round(M.waitMin)} min pritje${M.waitShare!=null?` (pritja ${Math.round(M.waitShare)}% e ciklit)`:''}.`;
  const fb=[]; if(M.interruptions)fb.push(`${M.interruptions} ndërprerje`); if(M.rework)fb.push(`${M.rework} ripërpunim${M.rework===1?'':'e'}`); if(M.errors)fb.push(`${M.errors} gabim${M.errors===1?'':'e'}`);
  if(fb.length) meaning+=` U regjistruan edhe ${slAl(fb)}.`;

  // 4 · hypotheses & next steps
  let next='';
  if(withHyp){ next=`Për ${withHyp===rows.length?'të gjitha':withHyp+' nga '+rows.length} vëzhgimet është ngritur një shkak i mundshëm — `;
    next+= validated? `${validated} ${validated===1?'është validuar':'janë validuar'}, ${pending} ${pending===1?'pret':'presin'} ende validim.` : `asnjë ende i konfirmuar; të gjitha mbeten hipoteza deri sa të validohen.`; }
  else if(rows.length) next='Nuk u ngritën hipoteza — hyrjet e ditës janë vëzhgime faktike.';
  const plan=rows.filter(o=>o.validationAction && (!o.validationStatus||o.validationStatus==='Pending validation')).sort((a,b)=>(a.followUpDate||'9')<(b.followUpDate||'9')?-1:1).slice(0,6);
  if(plan.length){ const byDate={}; plan.forEach(o=>{ const k=o.followUpDate?fmtDateAl(o.followUpDate):'pa datë'; (byDate[k]=byDate[k]||[]).push(`${h(lc1(trimEnd(fs1(o.validationAction,150))))}${procName(db,o.processId)?` <span class="faint">(${h(procName(db,o.processId))})</span>`:''}`); });
    next+=` Hapat e validimit: `+Object.entries(byDate).map(([k,a])=>`<b>deri më ${h(k)}</b> — ${a.join('; ')}`).join('; ')+'.'; }
  const valRes=rows.filter(o=>o.validationResult).map(o=>trimEnd(fs1(o.validationResult,160)));
  if(valRes.length) next+=` Rezultate validimi të regjistruara sot: ${h(slAl(valRes.map(lc1)))}.`;

  // 5 · trend (journal-based, plus WMS output trend when available)
  let trendSentence='';
  if(W && W.prep && W.prepAvg!=null && W.prepDays>=2){ const diff=Math.round((W.prep-W.prepAvg)/W.prepAvg*100);
    trendSentence+=`Output-i i WMS (${W.prep} porosi) është ${Math.abs(diff)<=5?'në nivelin e':(diff<0?`${Math.abs(diff)}% nën`:`${diff}% mbi`)} mesataren e ditëve të mëparshme${W.outRate!=null?`, me ${W.outRate}% të produkteve të hyra që dolën po atë ditë`:''}. `; }
  if(!B){ trendSentence+=`Në ditar kjo është ndër ditët e para me të dhëna — baza krahasuese po ndërtohet dhe ende s'mund të flitet për përmirësim apo keqësim; shifrat e sotme janë pikënisja për ditët në vijim.`; }
  else { let score=0; const cmp=[];
    if(B.negRate>0 || M.negRate>0){ if(M.negRate<=B.negRate*0.85) score++; else if(M.negRate>=B.negRate*1.15) score--; cmp.push(`tregues negativë për njësi aktiviteti ${M.negRate.toFixed(2)} sot kundrejt ${B.negRate.toFixed(2)} më parë`); }
    if(M.waitShare!=null && B.waitShare!=null){ if(M.waitShare<=B.waitShare-5) score++; else if(M.waitShare>=B.waitShare+5) score--; cmp.push(`pesha e pritjes ${Math.round(M.waitShare)}% kundrejt ${Math.round(B.waitShare)}%`); }
    const verd = score>0 ? 'vërehet një <b>trend përmirësimi</b>' : score<0 ? 'vërehet një <b>trend keqësimi</b> që kërkon vëmendje' : 'gjendja është kryesisht <b>e qëndrueshme</b>, pa një trend të qartë';
    trendSentence+=`Krahasuar me ${B.n} ditë${B.n!==1?'t':'n'} e mëparshme me të dhëna në ditar${cmp.length?` (${slAl(cmp)})`:''}, ${verd}.`; }

  // 6 · closing
  const crit=rows.filter(o=>o.severity==='Critical').sort(bySevRank);
  let closing='';
  if(crit.length){ const c=crit[0]; const cz=c.cause? lc1(trimEnd(fs1(stripHyp(c.cause),170))) : '';
    closing=`Çështja që peshon më shumë sot është <b>${h(lc1(trimEnd(fs1(c.subProcess||c.what,120))))}</b>${procName(db,c.processId)?` te ${h(procName(db,c.processId))}`:''}${cz?`; hipoteza e punës: ${h(cz)}`:''}${/…$/.test(cz)?' ':'. '}`; }
  else if(topProc.length && rows.length>=2) closing=`Vëmendja e ditës u përqendrua te procesi <b>${h(topProc[0][0])}</b>. `;
  let rec;
  if(M.waitShare!=null && M.waitShare>=50 && topProc.length) rec=`Përqendrohu te reduktimi i kohës së pritjes, veçanërisht te “${h(topProc[0][0])}”, ku duket humbja kryesore e kohës.`;
  else if((M.errors+M.rework)>=Math.max(2,Math.round(M.activity/2)) && topProc.length) rec=`Fut kontrolle cilësie te “${h(topProc[0][0])}” për të ulur gabimet dhe ripërpunimet.`;
  else if(pending>0) rec=`Asnjë ndryshim operacional para validimit — ${pending===1?'hipoteza e hapur validohet':'hipotezat e hapura ('+pending+') validohen'} së pari me hapat e mësipërm.`;
  else if(!rows.length && W) rec=`Plotëso ditarin me çka u pa në terren — shifrat e WMS tregojnë vëllimin, jo shkakun.`;
  else rec=`Vazhdo mbledhjen sistematike të matjeve dhe vëzhgimeve për të forcuar bazën krahasuese.`;

  const sec=(t,body)=>body?`<p style="margin:10px 0 0"><b style="color:var(--accent)">${t}.</b> ${body}</p>`:'';
  const title = opts.title || 'Raport ditor · përmbledhje narrative e turnit';
  const html=`<div class="report" style="padding:14px 16px;margin-bottom:12px;line-height:1.75">
      <div style="font-weight:700;color:var(--accent);font-size:12px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px">${h(title)}</div>
      <p style="margin:0">${ctx.join(' ')}</p>
      ${sec('Çka u vu re', seen.join(' '))}
      ${sec('Çfarë do të thotë kjo', meaning)}
      ${sec('Hipotezat dhe hapat e radhës', next)}
      ${sec('Trendi', trendSentence)}
      <p style="margin:10px 0 0"><b style="color:var(--accent)">Përfundimi.</b> ${closing}<span class="etag et-rec">rekomandim</span> ${rec}</p>
      <p class="meta" style="margin:10px 0 0">Raporti bazohet vetëm në të dhënat e futura (vëzhgime, matje${W?' dhe shifrat WMS të ditës':''}) dhe ruan ndarjen fakt–hipotezë; përfundimet kërkojnë validim.${opts.generatedAt?` Gjeneruar automatikisht më ${h(fmtDateAl(opts.generatedAt.slice(0,10)))} ${h(localTime(new Date(opts.generatedAt)))}.`:''}</p></div>`;
  return { html, text: stripTags(html.replace(/<\/p>/g,'\n\n').replace(/<\/div>/g,'\n')).replace(/\n{3,}/g,'\n\n').trim(), empty:false,
    stats:{obs:rows.length, auto:nAuto, pending, validated, critical:bySev.Critical||0, prep:W?W.prep:null, outRate:W?W.outRate:null} };
}

/* ------------------------------------------------------------ weekly report */
const AL_DAYS_SHORT=['Die','Hën','Mar','Mër','Enj','Pre','Sht'];
function addDaysIso(iso,n){ const d=dobj(iso); d.setDate(d.getDate()+n); return localDate(d); }
/* Monday-based week containing `date` */
function weekBounds(date){ const d=dobj(date); const dow=(d.getDay()+6)%7; const ws=addDaysIso(localDate(d),-dow); return {start:ws, end:addDaysIso(ws,6)}; }
/* week 1 = the week that contains config.startDate */
function weekNumber(db, weekStart){ const s=cfg(db).startDate; if(!s) return null; const w0=weekBounds(s).start; return Math.round((dobj(weekStart)-dobj(w0))/(7*86400000))+1; }
function datesBetween(a,b){ const out=[]; for(let d=a; d<=b; d=addDaysIso(d,1)) out.push(d); return out; }
function wmsWeekFacts(db, ws, we){
  const days=datesBetween(ws,we).map(d=>({d, W:wmsDayFacts(db,d)}));
  const withData=days.filter(x=>x.W);
  if(!withData.length) return null;
  const prepDays=withData.filter(x=>x.W.prep>0);
  const prepTotal=prepDays.reduce((a,x)=>a+x.W.prep,0);
  const prepWork=prepDays.filter(x=>x.W.isWorkDay);
  const avgWork=prepWork.length? Math.round(prepWork.reduce((a,x)=>a+x.W.prep,0)/prepWork.length) : null;
  const best=prepDays.slice().sort((a,b)=>b.W.prep-a.W.prep)[0]||null;
  const worst=prepWork.slice().sort((a,b)=>a.W.prep-b.W.prep)[0]||null;
  const flowDays=withData.filter(x=>x.W.checkedIn!=null);
  const ci=flowDays.reduce((a,x)=>a+x.W.checkedIn,0), co=flowDays.reduce((a,x)=>a+x.W.checkedOut,0);
  const outRate=ci>0? Math.round(co/ci*100) : null;
  const worstFlow=flowDays.filter(x=>x.W.checkedIn>=100).sort((a,b)=>(a.W.outRate||0)-(b.W.outRate||0))[0]||null;
  // operators over the week
  const byOp={}; col(db,'wmsPrepared').forEach(r=>{ if(r.date>=ws&&r.date<=we) byOp[r.operator]=(byOp[r.operator]||0)+num(r.preparedOrders); });
  const ops=Object.entries(byOp).sort((a,b)=>b[1]-a[1]);
  const ciByOp={}; col(db,'wmsCheckin').forEach(r=>{ if(r.date>=ws&&r.date<=we) ciByOp[r.operator]=(ciByOp[r.operator]||0)+num(r.checkedIn); });
  const ciOps=Object.entries(ciByOp).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
  const generic=ops.filter(o=>GENERIC_RE.test(o[0])); const genericPrep=generic.reduce((a,x)=>a+x[1],0);
  // backlog snapshots: first and last of the week
  const snaps=col(db,'wmsStats').filter(s=>s.date>=ws&&s.date<=we).sort((a,b)=>a.at<b.at?-1:1);
  return { ws, we, days, withData, prepTotal, prepDaysN:prepDays.length, prepWorkN:prepWork.length, avgWork, best, worst, ci, co, outRate, flowDaysN:flowDays.length, worstFlow,
    ops, ciOps, generic, genericPrep, firstSnap:snaps[0]||null, lastSnap:snaps[snaps.length-1]||null };
}
function pct(a,b){ return b? Math.round((a-b)/b*100) : null; }
function pctWord(p){ if(p==null) return ''; if(Math.abs(p)<=3) return 'në të njëjtin nivel'; return (p<0? `${Math.abs(p)}% më pak` : `${p}% më shumë`); }
/* Narrative weekly report for the Monday-based week containing `date`. Returns {html,text,stats,weekStart,weekEnd,weekNo}. */
function buildWeeklyNarrative(db, date, opts){
  opts=opts||{}; const h=esc;
  const {start:ws, end:we}=weekBounds(date);
  const wk=weekNumber(db,ws);
  const rows=col(db,'observations').filter(o=>o.date>=ws&&o.date<=we);
  const meas=col(db,'measurements').filter(m=>m.date>=ws&&m.date<=we);
  const probs=col(db,'problems').filter(p=>p.dateIdentified>=ws&&p.dateIdentified<=we);
  const F=wmsWeekFacts(db,ws,we);
  const Fp=wmsWeekFacts(db,addDaysIso(ws,-7),addDaysIso(we,-7));
  if(!rows.length && !meas.length && !F) return {html:'',text:'',empty:true, weekStart:ws, weekEnd:we, weekNo:wk};
  const startD=cfg(db).startDate; const firstWork=[ws,we].map(x=>x); // range shown in day numbers
  const dayFrom=startD? Math.max(1,dayNumber(db, ws<startD?startD:ws)) : null, dayTo=startD? dayNumber(db, we) : null;
  const ph=phaseFor(db, we<localDate()?we:localDate());
  const sevRank={Critical:0,Important:1,Improvement:2,Minor:3};
  const bySevRank=(a,b)=>((sevRank[a.severity]!=null?sevRank[a.severity]:9)-(sevRank[b.severity]!=null?sevRank[b.severity]:9));
  const sec=(t,body)=>body?`<p style="margin:10px 0 0"><b style="color:var(--accent)">${t}.</b> ${body}</p>`:'';

  // 1 · week in numbers
  const ctx=[];
  ctx.push(`<b>Java ${wk!=null?wk:'—'} e vëzhgimit, ${h(fmtDateAl(ws))} – ${h(fmtDateAl(we))}</b>${dayFrom?` — ditët e punës ${dayFrom}–${Math.min(30,dayTo)}/30`:''}, faza ${h(String(ph.n))} (${h(ph.name)}).`);
  if(F){
    if(F.prepTotal){ let s=`Gjatë javës WMS regjistroi <b>${F.prepTotal} porosi të përgatitura</b> në ${F.prepDaysN} ditë me të dhëna`;
      if(F.avgWork!=null) s+=`, mesatarisht <b>${F.avgWork}/ditë pune</b>`;
      if(Fp && Fp.avgWork!=null && F.avgWork!=null){ const p=pct(F.avgWork,Fp.avgWork); s+=` — ${pctWord(p)} se java e kaluar (${Fp.avgWork}/ditë)`; }
      if(F.best) s+=`. Dita më e fortë: ${AL_DAYS_SHORT[dobj(F.best.d).getDay()]} ${h(fmtDateAl(F.best.d))} me ${F.best.W.prep}`;
      if(F.worst && F.worst.d!==(F.best&&F.best.d)) s+=`; më e dobëta e ditëve të punës: ${AL_DAYS_SHORT[dobj(F.worst.d).getDay()]} ${h(fmtDateAl(F.worst.d))} me ${F.worst.W.prep}`;
      ctx.push(s+'.'); }
    if(F.flowDaysN){ let s=`Në rrjedhën e produkteve hynë <b>${F.ci}</b> (check-in) dhe dolën <b>${F.co}</b> (check-out)`;
      if(F.outRate!=null) s+=` — ${F.outRate}% e asaj që hyri doli brenda ditës`;
      if(Fp && Fp.outRate!=null && F.outRate!=null) s+=` (java e kaluar ${Fp.outRate}%)`;
      if(F.worstFlow && F.worstFlow.W.outRate!=null && F.worstFlow.W.outRate<60) s+=`; dita më kritike ${AL_DAYS_SHORT[dobj(F.worstFlow.d).getDay()]} ${h(fmtDateAl(F.worstFlow.d))} me vetëm ${F.worstFlow.W.outRate}%`;
      ctx.push(s+'.'); }
    if(F.lastSnap){ let s=`Backlog-u në WMS: <b>${num(F.lastSnap.ordersInProcessing)} porosi në procesim</b> në matjen e fundit të javës (${h(fmtDateAl(F.lastSnap.date))} ${localTime(new Date(F.lastSnap.at))})`;
      if(F.firstSnap && F.firstSnap!==F.lastSnap && F.firstSnap.date!==F.lastSnap.date){ const d=num(F.lastSnap.ordersInProcessing)-num(F.firstSnap.ordersInProcessing); s+=`, ${d<0?'−':'+'}${Math.abs(d)} kundrejt matjes së parë (${h(fmtDateAl(F.firstSnap.date))})`; }
      ctx.push(s+`; ${num(F.lastSnap.ordersReadyToUnmap)} gati për përfundim.`); }
    if(F.ops.length>=2 && F.prepTotal){ const a=F.ops[0], b=F.ops[1]; const share=Math.round((a[1]+b[1])/F.prepTotal*100);
      let s=`Ngarkesën e picking e mbajtën kryesisht <b>${h(a[0])}</b> (${a[1]}) dhe <b>${h(b[0])}</b> (${b[1]}) — ${share}% e javës, nga ${F.ops.length} llogari me porosi`;
      if(F.genericPrep) s+=`; ${Math.round(F.genericPrep/F.prepTotal*100)}% e porosive u regjistruan nën llogari gjenerike (${F.generic.map(o=>h(o[0])).join(', ')})`;
      if(F.ciOps.length===1) s+=`. Pranimin e bëri vetëm ${h(F.ciOps[0][0])} (${F.ciOps[0][1]})`;
      else if(F.ciOps.length>=2){ const ca=F.ciOps[0], cb=F.ciOps[1]; const combPct=F.ci?Math.round((ca[1]+cb[1])/F.ci*100):null;
        s+=`. Pranimin e mbajtën ${h(ca[0])} (${ca[1]}${F.ci?`, ${Math.round(ca[1]/F.ci*100)}%`:''}) dhe ${h(cb[0])} (${cb[1]}${F.ci?`, ${Math.round(cb[1]/F.ci*100)}%`:''})${combPct!=null?` — ${combPct}% e javës`:''}`; }
      ctx.push(s+'.'); }
  } else ctx.push('Për këtë javë nuk ka shifra WMS të sinkronizuara — përmbledhja mbështetet vetëm te ditari.');

  // 2 · day by day (compact table)
  let dayTable='';
  if(F){ const tr=F.days.map(x=>{ const W=x.W; const dow=dobj(x.d).getDay(); const off=!isWorkDay(db,x.d);
      const obsN=rows.filter(o=>o.date===x.d).length;
      return `<tr${off?' style="opacity:.75"':''}><td>${AL_DAYS_SHORT[dow]} ${h(fmtDateAl(x.d))}${off?' <span class="faint">·off</span>':''}</td>
        <td style="text-align:right">${W&&W.prep?`<b>${W.prep}</b>`:'<span class="faint">—</span>'}</td>
        <td style="text-align:right">${W&&W.checkedIn!=null?W.checkedIn:'<span class="faint">—</span>'}</td>
        <td style="text-align:right">${W&&W.checkedOut!=null?W.checkedOut:'<span class="faint">—</span>'}</td>
        <td style="text-align:right">${W&&W.outRate!=null?`<b style="color:${W.outRate>=90?'var(--ok)':(W.outRate>=60?'var(--warn)':'var(--crit)')}">${W.outRate}%</b>`:'<span class="faint">—</span>'}</td>
        <td style="text-align:right">${W&&W.last?num(W.last.ordersInProcessing):'<span class="faint">—</span>'}</td>
        <td style="text-align:right">${obsN||'<span class="faint">—</span>'}</td></tr>`; }).join('');
    dayTable=`<div style="overflow:auto;margin-top:10px"><table class="tbl" style="font-size:12.5px"><thead><tr><th>Dita</th><th style="text-align:right">Porosi</th><th style="text-align:right">Check-in</th><th style="text-align:right">Check-out</th><th style="text-align:right">Out/In</th><th style="text-align:right">Në procesim</th><th style="text-align:right">Vëzhgime</th></tr></thead><tbody>${tr}</tbody></table></div>`; }

  // 3 · what was observed
  const bySev={}, byProc={}; rows.forEach(o=>{ if(o.severity) bySev[o.severity]=(bySev[o.severity]||0)+1; const pn=procName(db,o.processId)||'I pacaktuar'; byProc[pn]=(byProc[pn]||0)+1; });
  const topProc=Object.entries(byProc).sort((a,b)=>b[1]-a[1]);
  const nAuto=rows.filter(o=>o.auto).length;
  let seen='';
  if(rows.length){
    const sevWords=[]; if(bySev.Critical) sevWords.push(`${bySev.Critical} kritike`); if(bySev.Important) sevWords.push(`${bySev.Important} të rëndësishme`); if(bySev.Improvement) sevWords.push(`${bySev.Improvement} për përmirësim`); if(bySev.Minor) sevWords.push(`${bySev.Minor} të vogla`);
    seen=`Në ditar u regjistruan <b>${rows.length} vëzhgime</b>${nAuto?` (${nAuto} nga analiza automatike WMS)`:''}${sevWords.length?` — ${slAl(sevWords)}`:''}${topProc.length?`, më së shumti te ${slAl(topProc.slice(0,3).map(([k,c])=>`<b>${h(k)}</b> (${c})`))}`:''}.`;
    const crit=rows.filter(o=>o.severity==='Critical').sort((a,b)=>a.date<b.date?-1:1);
    if(crit.length) seen+=` Kritike: ${crit.slice(0,4).map(o=>`${h(fmtDateAl(o.date))} — ${h(lc1(trimEnd(fs1(o.subProcess||o.what,120))))}`).join('; ')}${crit.length>4?`; dhe ${crit.length-4} të tjera`:''}.`;
    const flags={i:rows.filter(o=>o.interruption).length, r:rows.filter(o=>o.rework).length, e:rows.filter(o=>o.error).length};
    const fw=[]; if(flags.i) fw.push(`${flags.i} ndërprerje`); if(flags.r) fw.push(`${flags.r} ripërpunim${flags.r===1?'':'e'}`); if(flags.e) fw.push(`${flags.e} gabim${flags.e===1?'':'e'}`);
    if(fw.length) seen+=` U shënuan ${slAl(fw)}.`;
  } else seen='Në ditar nuk ka vëzhgime për këtë javë.';
  if(meas.length){ const procS=meas.reduce((a,m)=>a+(m.processingSec||0),0), waitS=meas.reduce((a,m)=>a+(m.waitingSec||0),0); const tot=procS+waitS;
    const mp={}; meas.forEach(m=>{ const pn=procName(db,m.processId)||'—'; mp[pn]=(mp[pn]||0)+1; }); const mpTop=Object.entries(mp).sort((a,b)=>b[1]-a[1]);
    seen+=` U kryen <b>${meas.length} matje</b>${mpTop.length?` (${slAl(mpTop.slice(0,3).map(([k,c])=>`${h(k)} ${c}`))})`:''}: ${Math.round(procS/60)} min punë aktive dhe ${Math.round(waitS/60)} min pritje${tot?` — pritja zë ${Math.round(waitS/tot*100)}% të ciklit të matur`:''}.`; }
  if(probs.length) seen+=` Në regjistrin e bottleneck-eve u shtuan ${probs.length} problem${probs.length===1?'':'e'}.`;

  // 4 · hypotheses & validation
  const withHyp=rows.filter(o=>o.cause).length, validated=rows.filter(o=>o.validationStatus==='Validated').length, notConf=rows.filter(o=>o.validationStatus==='Not confirmed').length, pending=rows.filter(o=>o.validationStatus==='Pending validation').length;
  const allPending=col(db,'observations').filter(o=>o.validationStatus==='Pending validation' && o.date<=we);
  const overdue=allPending.filter(o=>o.followUpDate && o.followUpDate<=we);
  let hyp='';
  if(withHyp||allPending.length){
    hyp=`Këtë javë u ngritën ${withHyp} hipoteza; ${validated?`${validated} u validua${validated===1?'':'n'}`:'asnjë nuk u validua ende'}${notConf?`, ${notConf} nuk u konfirmua${notConf===1?'':'n'}`:''}${pending?`, ${pending} pres${pending===1?'in':'in'} validim`:''}.`;
    if(allPending.length) hyp+=` Në total <b>${allPending.length} hipoteza të hapura</b> deri në fund të javës${overdue.length?`, nga të cilat ${overdue.length} me afat validimi të kaluar: ${overdue.slice(0,3).map(o=>`${h(lc1(trimEnd(fs1(o.subProcess||o.what,90))))} (${h(fmtDateAl(o.followUpDate))})`).join('; ')}${overdue.length>3?'; …':''}`:''}.`;
    const results=rows.filter(o=>o.validationResult).map(o=>trimEnd(fs1(o.validationResult,140)));
    if(results.length) hyp+=` Rezultate validimi: ${h(slAl(results.slice(0,3).map(lc1)))}.`;
  }

  // 5 · week-over-week trend
  let trend='';
  const tParts=[]; let score=0;
  if(F && Fp && F.avgWork!=null && Fp.avgWork!=null){ const p=pct(F.avgWork,Fp.avgWork); tParts.push(`porositë/ditë pune ${F.avgWork} kundrejt ${Fp.avgWork} (${p>0?'+':''}${p}%)`); if(p>=5) score++; else if(p<=-5) score--; }
  if(F && Fp && F.outRate!=null && Fp.outRate!=null){ tParts.push(`Out/In ${F.outRate}% kundrejt ${Fp.outRate}%`); if(F.outRate>=Fp.outRate+5) score++; else if(F.outRate<=Fp.outRate-5) score--; }
  const prevRows=col(db,'observations').filter(o=>o.date>=addDaysIso(ws,-7)&&o.date<=addDaysIso(we,-7));
  if(rows.length && prevRows.length){ const nr=r=>r.filter(o=>o.interruption||o.rework||o.error).length/r.length; const a=nr(rows), b=nr(prevRows);
    tParts.push(`vëzhgime me ndërprerje/ripërpunim/gabim ${Math.round(a*100)}% kundrejt ${Math.round(b*100)}%`); if(a<=b-0.1) score++; else if(a>=b+0.1) score--; }
  if(tParts.length){ const verd= score>0?'java tregon <b>përmirësim</b>':(score<0?'java tregon <b>keqësim</b> që kërkon vëmendje':'gjendja mbetet <b>e qëndrueshme</b>, pa trend të qartë');
    trend=`Krahasuar me javën e kaluar (${slAl(tParts)}), ${verd}.`; }
  else trend= Fp||prevRows.length ? 'Të dhënat e dy javëve nuk mjaftojnë për një krahasim të besueshëm.' : 'Kjo është java e parë me të dhëna — bëhet baza krahasuese për javët në vijim.';

  // 6 · closing & focus for next week
  const nextPh=phaseFor(db, addDaysIso(we,1));
  let focus=[];
  if(F && F.outRate!=null && F.outRate<75) focus.push('bilanci check-in/check-out — kupto ku mbeten produktet që hyjnë e s\'dalin');
  if(F && F.ops.length>=3 && F.prepTotal && (F.ops[0][1]+F.ops[1][1])/F.prepTotal>=0.6) focus.push('shpërndarja e picking përtej dy personave (trajnim / rotacion)');
  if(F && F.genericPrep && F.prepTotal && F.genericPrep/F.prepTotal>=0.1) focus.push('llogari personale për çdo operator në WMS');
  if(overdue.length) focus.push(`mbyllja e ${overdue.length} validimeve me afat të kaluar`);
  else if(allPending.length) focus.push(`validimi i ${Math.min(allPending.length,3)} hipotezave më të rëndësishme`);
  if(!meas.length) focus.push('matje me kronometër (Process Measurement) për të ndarë kohën e pritjes nga puna');
  const closing=`Fokusi për javën ${wk!=null?wk+1:'e ardhshme'}${nextPh.n!==ph.n?` (hyn faza ${h(String(nextPh.n))} — ${h(nextPh.name)})`:''}: ${focus.length?slAl(focus.slice(0,4)):'vazhdimi i vëzhgimeve dhe matjeve sistematike'}.`;

  const title=opts.title||`Raport javor · java ${wk!=null?wk:'—'} (${fmtDateAl(ws)} – ${fmtDateAl(we)})`;
  const html=`<div class="report" style="padding:14px 16px;margin-bottom:12px;line-height:1.75">
      <div style="font-weight:700;color:var(--accent);font-size:12px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px">${h(title)}</div>
      <p style="margin:0">${ctx.join(' ')}</p>
      ${dayTable}
      ${sec('Çka u vëzhgua', seen)}
      ${sec('Hipotezat dhe validimi', hyp)}
      ${sec('Trendi javë pas jave', trend)}
      <p style="margin:10px 0 0"><b style="color:var(--accent)">Përfundimi.</b> <span class="etag et-rec">fokus</span> ${closing}</p>
      <p class="meta" style="margin:10px 0 0">Raporti bazohet në shifrat WMS të javës dhe në ditar (vëzhgime, matje, probleme); ruan ndarjen fakt–hipotezë.${opts.generatedAt?` Gjeneruar automatikisht më ${h(fmtDateAl(opts.generatedAt.slice(0,10)))} ${h(localTime(new Date(opts.generatedAt)))}.`:''}</p></div>`;
  return { html, text: stripTags(html.replace(/<\/p>/g,'\n\n').replace(/<\/tr>/g,'\n').replace(/<\/t[dh]>/g,' | ').replace(/<\/div>/g,'\n')).replace(/\n{3,}/g,'\n\n').trim(), empty:false,
    weekStart:ws, weekEnd:we, weekNo:wk,
    stats:{obs:rows.length, auto:nAuto, meas:meas.length, critical:bySev.Critical||0, pending, prepTotal:F?F.prepTotal:null, avgWork:F?F.avgWork:null, outRate:F?F.outRate:null} };
}

/* Standalone printable HTML page for an archived report (written by the agent to /reports). */
function standaloneReportPage(title, innerHtml){
  return `<!DOCTYPE html><html lang="sq"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>:root{--accent:#2f81f7;--line:#e2e6ec}body{font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#1a1d23;line-height:1.7}
.report{border:1px solid var(--line);border-radius:10px;background:#fafbfc}.etag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:4px;margin-right:6px;background:#eef2f7;color:#334}
.et-hyp{background:#fdf0f5;color:#a2306a}.et-rec{background:#fff4e0;color:#8a5a00}.meta{color:#5c6470;font-size:13px}.faint{color:#8a93a0}</style></head><body>${innerHtml}</body></html>`;
}

return { esc, num, uid, nowISO, localDate, localTime, fmtDateAl, slAl, fs1, lc1, trimEnd, stripHyp, stripTags, PHASES,
  isWorkDay, workingDaysCount, dayNumber, phaseFor, procName, procIdByName, nextWorkDay,
  importStats, importPrepared, importCheckin, importFlow,
  wmsDayFacts, wmsAutoObservations, dayMetrics, priorBaseline, buildDailyNarrative,
  weekBounds, weekNumber, addDaysIso, wmsWeekFacts, buildWeeklyNarrative, standaloneReportPage };
});
