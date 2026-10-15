/* =========================================================================
   KAMPANJA — plani, rrjedha live, raporti orar/ditor, alarmet, checklist-at, prompt-i AI
   Numrat e kampanjës (parashikimi, baseline, kampanjat e kaluara, SKU) vijnë nga skedari
   lokal campaign.local.json (git-ignored) ose shkruhen te Cilësimet — asgjë nga WMS nuk
   është e shkruar në kod. Të dhënat live merren nga sync-u ekzistues i agjentit
   (wmsPrepared / wmsCheckin / wmsStats). "Porosi të hyra" futen në raportin orar
   (agjenti s'ka endpoint për porositë e krijuara).
   Loaded after shared.js and before app.js (ROUTES in app.js references renderCampaign).
   =======================================================================*/
const CAMP_DEFAULT = {
  name:'Kampanja', start:'', end:'', manager:'', warehouse:'',
  launchTime:'13:00', cutoff:'17:00', paceDeadline:'',   // paceDeadline: afati për ritmin e kërkuar (bosh = cut-off)
  shifts:[{name:'Turni 1',start:'07:00',end:'14:30'},{name:'Turni 2',start:'14:30',end:'22:30'}],
  tables:7, ordersPerHour:20, shiftHours:8, reservePct:15, whSharePct:85, unitsPerOrder:1.6,
  preDayOrders:0, highPct:25, triggerPct:7,
  alarmL2:90, alarmL3:75, sysDownMin:15,
  kpi:{backlogEnd:300, claimToPackMin:10, accuracy:99.5, cleanupBy:''},
  couriers:'', pickups:'', courierCap:0, packSets:0,
  days:[],              // {date, forecast, workload?, outbound, s1, s2, inbound, highTotal, curve:'launch'|'normal', note}
  curveLaunch:[], curveLaunchHour:13, curveNormal:[],
  context:{baseline:[], past:[], lesson:[], productivity:[], capacity:[], skus:[], verify:[]},
  checks:{}
};
function campCfg(){
  if(!Store.db.campaign) Store.db.campaign=JSON.parse(JSON.stringify(CAMP_DEFAULT));
  const c=Store.db.campaign;
  Object.keys(CAMP_DEFAULT).forEach(k=>{ if(c[k]===undefined) c[k]=JSON.parse(JSON.stringify(CAMP_DEFAULT[k])); });
  Object.keys(CAMP_DEFAULT.context).forEach(k=>{ if(!Array.isArray(c.context[k])) c.context[k]=[]; });
  Object.keys(CAMP_DEFAULT.kpi).forEach(k=>{ if(c.kpi[k]===undefined) c.kpi[k]=CAMP_DEFAULT.kpi[k]; });
  return c;
}
const campToday=()=>fmtLocalDate(new Date());
function campMin(hhmm){ if(!hhmm) return null; const p=String(hhmm).split(':'); return (+p[0])*60+(+(p[1]||0)); }
function campHHMM(min){ min=Math.max(0,Math.round(min)); return String(Math.floor(min/60)%24).padStart(2,'0')+':'+String(min%60).padStart(2,'0'); }
const campFmt=n=>(n==null||isNaN(n))?'—':Math.round(n).toLocaleString('de-DE');
function campDays(){ return campCfg().days.slice().sort((a,b)=>a.date<b.date?-1:1); }
function campDay(date){ return campDays().find(d=>d.date===date)||null; }
function campOpsHours(){ const s=campCfg().shifts; if(!s.length) return 0;
  const a=Math.min(...s.map(x=>campMin(x.start))), b=Math.max(...s.map(x=>campMin(x.end))); return (b-a)/60; }
function campDayName(date){ return ['E diel','E hënë','E martë','E mërkurë','E enjte','E premte','E shtunë'][dobj(date).getDay()]; }
/* staffing calc: workload = ½ today + ½ yesterday (orders for the warehouse), unless overridden */
function campCalc(date){
  const c=campCfg(), days=campDays(), i=days.findIndex(d=>d.date===date); if(i<0) return null;
  const d=days[i], share=num(c.whSharePct,85)/100;
  const wh=d.forecast!=null&&d.forecast!==''?Math.round(num(d.forecast)*share):null;
  const prevWh=i>0?(days[i-1].forecast!=null&&days[i-1].forecast!==''?Math.round(num(days[i-1].forecast)*share):null):Math.round(num(c.preDayOrders)*share);
  const workload=d.workload!=null&&d.workload!==''?num(d.workload):(wh!=null?Math.round(wh/2+(prevWh||0)/2):null);
  const perPerson=num(c.ordersPerHour,20)*num(c.shiftHours,8);
  const outboundCalc=workload!=null&&perPerson>0?Math.ceil(workload/perPerson*(1+num(c.reservePct)/100)-1e-9):null;
  const tablesCap=Math.round(num(c.tables)*num(c.ordersPerHour)*campOpsHours());
  const total=num(d.outbound)+num(d.inbound);
  return {d, wh, prevWh, workload, outboundCalc, tablesCap, overCap:workload!=null&&tablesCap>0&&workload>tablesCap,
    total, units:workload!=null?Math.round(workload*num(c.unitsPerOrder,1.6)):null,
    shiftOver:Math.max(num(d.s1),num(d.s2))>num(c.tables)?Math.max(num(d.s1),num(d.s2))-num(c.tables):0};
}
/* hourly intake curve (weights per hour 0–23). Launch day: past-campaign launch curve shifted to the launch hour (SUPOZIM). */
function campCurve(day){
  const c=campCfg(), flat=Array.from({length:24},(_,h)=>(h>=7&&h<23)?1:0.2);
  const normal=(c.curveNormal&&c.curveNormal.length===24)?c.curveNormal.map(num):flat;
  if(day&&day.curve==='launch'&&c.curveLaunch&&c.curveLaunch.length===24){
    const L=Math.floor(campMin(c.launchTime||'13:00')/60), L0=num(c.curveLaunchHour,13);
    return Array.from({length:24},(_,h)=>h<L?num(c.curveLaunch[Math.min(h,L0-1)]):num(c.curveLaunch[Math.min(23,L0+(h-L))]));
  }
  return normal;
}
function campExpectedBy(day,min){
  if(!day||day.forecast==null||day.forecast==='') return null;
  const w=campCurve(day), tot=w.reduce((a,b)=>a+b,0); if(!tot) return null;
  const H=Math.floor(min/60); let s=0; for(let hh=0;hh<Math.min(H,24);hh++) s+=w[hh]; if(H<24) s+=w[H]*((min%60)/60);
  return num(day.forecast)*s/tot;
}
function campEntries(date){ return Store.col('campHourly').filter(r=>r.date===date).sort((a,b)=>campMin(a.time)-campMin(b.time)); }
function campDailyRec(date){ return Store.col('campDaily').find(r=>r.date===date)||null; }
function campBacklogStart(date){
  const rec=campDailyRec(date); if(rec&&rec.backlogStart!=null&&rec.backlogStart!=='') return num(rec.backlogStart);
  const prev=Store.col('campDaily').filter(r=>r.date<date&&r.backlogEnd!=null&&r.backlogEnd!=='').sort((a,b)=>a.date<b.date?1:-1)[0];
  return prev?num(prev.backlogEnd):null;
}
/* evaluate one hourly entry: expected vs actual, backlog, required vs real pace, alarm level */
function campEval(e,date){
  const c=campCfg(), day=campDay(date), list=campEntries(date), i=list.findIndex(x=>x.id===e.id), prev=i>0?list[i-1]:null;
  const t=campMin(e.time), expected=campExpWin(day,date,t);
  const dev=expected?((num(e.ordersIn)-expected)/expected*100):null;
  const bStart=campBacklogStart(date);
  const backlogCalc=(bStart!=null&&e.ordersIn!=null&&e.completed!=null)?bStart+num(e.ordersIn)-num(e.completed):null;
  const backlog=(e.backlog!=null&&e.backlog!=='')?num(e.backlog):backlogCalc;
  const conflict=(e.backlog!=null&&e.backlog!==''&&backlogCalc!=null&&Math.abs(num(e.backlog)-backlogCalc)>Math.max(20,backlogCalc*0.1));
  const cut=campMin(c.cutoff), end=Math.max(...c.shifts.map(s=>campMin(s.end))), first=Math.min(...c.shifts.map(s=>campMin(s.start)));
  const dl=campMin(c.paceDeadline||c.cutoff), left=(t<dl?dl-t:end-t)/60;
  const required=(backlog!=null&&left>0)?backlog/left:null;
  let real=null;
  if(e.completed!=null&&e.completed!==''){
    if(prev&&prev.completed!=null&&prev.completed!==''&&t>campMin(prev.time)) real=(num(e.completed)-num(prev.completed))/((t-campMin(prev.time))/60);
    else if(t>first) real=num(e.completed)/((t-first)/60);
  }
  const ratio=(real!=null&&required)?real/required*100:null;
  const prevEval=prev?campEvalLite(prev,date):null;
  let level=1, why='Ritmi në rregull';
  if(num(e.sysDownMin)>=num(c.sysDownMin,15)){ level=3; why='Sistem/pajisje kyçe jashtë funksionit ≥ '+c.sysDownMin+' min'; }
  else if(ratio!=null&&ratio<num(c.alarmL3,75)){ level=3; why='Ritmi real < '+c.alarmL3+'% e të kërkuarit'; }
  else if(ratio!=null&&ratio<num(c.alarmL2,90)&&prevEval&&prevEval.ratio!=null&&prevEval.ratio<num(c.alarmL2,90)){ level=2; why='Ritmi < '+c.alarmL2+'% në dy kontrolle radhazi'; }
  else if(ratio!=null&&ratio<num(c.alarmL2,90)){ level=1; why='Kujdes: ritmi < '+c.alarmL2+'% (një kontroll)'; }
  else if(ratio==null){ why='Mungon ritmi (duhen "të përfunduara" dhe backlog)'; }
  return {expected, dev, backlog, backlogCalc, conflict, required, real, ratio, level, why, afterCut:t>=dl,
    staffNeeded:required!=null?Math.ceil(required/num(c.ordersPerHour,20)):null,
    trigger:expected!=null?expected*(1+num(c.triggerPct,7)/100):null};
}
function campEvalLite(e,date){ // pace ratio only (no recursion into previous levels)
  const c=campCfg(), list=campEntries(date), i=list.findIndex(x=>x.id===e.id), prev=i>0?list[i-1]:null, t=campMin(e.time);
  const bStart=campBacklogStart(date);
  const backlog=(e.backlog!=null&&e.backlog!=='')?num(e.backlog):((bStart!=null&&e.ordersIn!=null&&e.completed!=null)?bStart+num(e.ordersIn)-num(e.completed):null);
  const cut=campMin(c.cutoff), end=Math.max(...c.shifts.map(s=>campMin(s.end))), first=Math.min(...c.shifts.map(s=>campMin(s.start)));
  const dl=campMin(c.paceDeadline||c.cutoff), left=(t<dl?dl-t:end-t)/60, required=(backlog!=null&&left>0)?backlog/left:null;
  let real=null;
  if(e.completed!=null&&e.completed!==''){
    if(prev&&prev.completed!=null&&prev.completed!==''&&t>campMin(prev.time)) real=(num(e.completed)-num(prev.completed))/((t-campMin(prev.time))/60);
    else if(t>first) real=num(e.completed)/((t-first)/60);
  }
  return {ratio:(real!=null&&required)?real/required*100:null};
}
function campLevelBadge(l){ return l===3?'<span class="badge b-crit">🔴 Niveli 3</span>':l===2?'<span class="badge b-imp">🟠 Niveli 2</span>':'<span class="badge b-ok">🟢 Niveli 1</span>'; }
/* live WMS figures for a date (from the agent sync) */
function campWms(date){
  const prepared=Store.col('wmsPrepared').filter(r=>r.date===date).reduce((a,r)=>a+num(r.preparedOrders),0);
  const chk=Store.col('wmsCheckin').filter(r=>r.date===date);
  const snaps=Store.col('wmsStats').filter(s=>s.at&&fmtLocalDate(new Date(s.at))===date).sort((a,b)=>a.at<b.at?-1:1);
  return {prepared, checkedIn:chk.reduce((a,r)=>a+num(r.checkedIn),0), checkedOut:chk.reduce((a,r)=>a+num(r.checkedOut),0),
    snap:snaps[snaps.length-1]||null, snaps, operators:new Set(Store.col('wmsPrepared').filter(r=>r.date===date&&num(r.preparedOrders)>0).map(r=>r.operator)).size};
}
/* WMS hour by hour (pulse/data → campaign.hours, block C campH, refreshed hourly 07–22): orders created / checked out, units out / in,
   warehouse 01, local time. The campaign counts from the launch (start date + launchTime, e.g. 14.10.2026 16:00, the lead 14.10.2026):
   the launch day from that hour, the following days whole (00–24). Expected orders of a window = forecast curve from its start. */
let campReal=null, campRealBusy=false;
function campRealLoad(){
  if(campRealBusy) return; campRealBusy=true;
  fetch('/pulse/data',{cache:'no-store'}).then(r=>r.json()).then(j=>{ campReal=(j&&j.campaign)||{hours:[]}; })
    .catch(()=>{ campReal={hours:[], error:true}; })
    .finally(()=>{ campRealBusy=false; if(location.hash==='#campaign') renderCampaign($('#view')); });
}
/* live cards (the lead, 15.10.2026) from the agent's /camp/live: POD done from the window start, orders past check-out
   still waiting for POD + WMS "Orders Ready To Complete" (now), the Flow (2h) tempo and the day's last backlog snapshot */
const campLiveData={}, campLiveBusy={};
function campLiveLoad(date){
  const key=date+'|'+campHHMM(campWinStart(date)), c=campLiveData[key];
  if(campLiveBusy[key] || (c && Date.now()-c.t<60000)) return c? c.v : null;
  campLiveBusy[key]=true;
  fetch('/camp/live?date='+date+'&from='+campHHMM(campWinStart(date)),{cache:'no-store'}).then(r=>r.json()).then(v=>{ campLiveData[key]={t:Date.now(), v}; })
    .catch(e=>{ campLiveData[key]={t:Date.now(), v:{error:String(e.message||e)}}; })
    .finally(()=>{ campLiveBusy[key]=false; if(location.hash==='#campaign' && campTab==='live') renderCampaign($('#view')); });
  return c? c.v : null;
}
function campWinStart(date){ const c=campCfg(); return date===c.start? (campMin(c.launchTime)||0) : 0; }   // minutes from 00:00
function campExpWin(day,date,min){ const a=campExpectedBy(day,campWinStart(date)), b=campExpectedBy(day,min);
  return a==null||b==null? null : Math.max(0,b-a); }
function campRealDay(date){
  const c=campCfg(); if(!campReal||!c.start||date<c.start) return null;
  const H=Math.floor(campWinStart(date)/60), rows=(campReal.hours||[]).filter(r=>r.d===date&&r.h>=H).sort((a,b)=>a.h-b.h);
  const s=k=>rows.reduce((a,r)=>a+num(r[k]),0);
  return {rows, from:H, cr:s('cr'), co:s('co'), cu:s('cu'), ci:s('ci'), has:rows.length>0};
}
function campRealCard(selDate){
  const c=campCfg(); if(!c.start) return '';
  if(!campReal){ campRealLoad(); return `<div class="card" style="margin-bottom:14px"><h3>Kampanja ditë pas dite (WMS)</h3><div class="hint">Duke ngarkuar…</div></div>`; }
  const today=campToday(), days=campDays().filter(d=>d.date>=c.start&&d.date<=today);
  if(!days.length) return '';
  let cumIn=0, cumOut=0;
  const rows=days.map(d=>{ const R=campRealDay(d.date)||{cr:0,co:0,cu:0,ci:0,has:false}, from=campWinStart(d.date);
    const exp=campExpWin(d, d.date, d.date===today? new Date().getHours()*60+new Date().getMinutes() : 1440), expDay=campExpWin(d, d.date, 1440);
    cumIn+=R.cr; cumOut+=R.co;
    return {d, R, from, exp, expDay, cumIn, cumOut}; });
  const T=k=>rows.reduce((a,r)=>a+num(r.R[k]),0);
  const pct=(a,b)=>b? Math.round(a/b*100)+'%' : '—';
  const sel=campRealDay(selDate), selDay=campDay(selDate);
  let cIn=0, cOut=0;
  const hourly=sel&&sel.has? sel.rows.map(r=>{ cIn+=num(r.cr); cOut+=num(r.co);
    const e=selDay? campExpWin(selDay, selDate, (r.h+1)*60) : null;
    return `<tr><td>${String(r.h).padStart(2,'0')}:00–${String(r.h+1).padStart(2,'0')}:00</td><td>${campFmt(r.cr)}</td><td>${campFmt(cIn)} ${e?`<span class="faint">/ ${campFmt(e)}</span>`:''}</td><td>${campFmt(r.co)}</td><td>${campFmt(cOut)}</td><td>${campFmt(r.cu)}</td><td>${campFmt(r.ci)}</td><td>${campFmt(cIn-cOut)}</td></tr>`; }).join('') : '';
  return `<div class="card" style="margin-bottom:14px"><h3>Kampanja ditë pas dite <span class="sub">WMS · nga ${h(fmtDateAl(c.start))} ora ${h(c.launchTime||'00:00')} · depo 01</span></h3>
    <div class="tablewrap"><table><thead><tr><th>Dita</th><th>Dritarja</th><th>Porosi të krijuara</th><th>Parashikimi</th><th>Porosi të dala<br><span class="sub">check-out i parë</span></th><th>Njësi check-out</th><th>Njësi check-in</th><th>Hyrë − dalë<br><span class="sub">kumulative nga nisja</span></th></tr></thead>
    <tbody>${rows.map(({d,R,from,exp,expDay,cumIn,cumOut})=>`<tr ${d.date===selDate?'style="outline:1px solid var(--accent)"':''}>
      <td><b>${h(campDayName(d.date))}</b> <span class="small muted">${h(fmtDateAl(d.date))}</span></td>
      <td>${h(campHHMM(from))}–24:00${d.date===today?' <span class="badge b-new">sot</span>':''}</td>
      <td><b>${campFmt(R.cr)}</b> ${exp?`<span class="small muted">(${pct(R.cr,exp)} e pritjes${d.date===today?' deri tani':''})</span>`:''}</td>
      <td>${campFmt(expDay)}</td><td>${campFmt(R.co)}</td><td>${campFmt(R.cu)}</td><td>${campFmt(R.ci)}</td><td>${campFmt(cumIn-cumOut)}</td></tr>`).join('')}
      <tr style="border-top:2px solid var(--line)"><td colspan="2"><b>Gjithsej nga nisja</b></td><td><b>${campFmt(T('cr'))}</b></td><td>${campFmt(rows.reduce((a,r)=>a+num(r.expDay),0))}</td><td><b>${campFmt(T('co'))}</b></td><td><b>${campFmt(T('cu'))}</b></td><td><b>${campFmt(T('ci'))}</b></td><td><b>${campFmt(T('cr')-T('co'))}</b></td></tr></tbody></table></div>
    ${hourly?`<h3 style="font-size:12.5px;margin:14px 0 4px">${h(campDayName(selDate))} ${h(fmtDateAl(selDate))} — orë pas ore nga ${h(campHHMM(campWinStart(selDate)))}</h3>
    <div class="tablewrap"><table><thead><tr><th>Ora</th><th>Krijuara</th><th>Kumulative <span class="sub">/ e pritur</span></th><th>Dala</th><th>Dala kumulative</th><th>Njësi check-out</th><th>Njësi check-in</th><th>Hyrë − dalë (dita)</th></tr></thead><tbody>${hourly}</tbody></table></div>`:''}
    <div class="hint" style="margin-top:8px">Burimi: WMS (Orders.CreatedOnUtc në orën lokale; check-out-i i parë i porosisë dhe njësitë ProductLogs 4/18; check-in ProductCheckIns), depo 01, rifreskim çdo orë 07–22${campReal.at?' · i fundit '+h(fmtTime(campReal.at)):''}. Dita e nisjes numërohet nga ora ${h(c.launchTime||'00:00')}, ditët pasuese 00:00–24:00. "Hyrë − dalë" është tregues i ngarkesës, jo backlog-u i saktë (porositë e krijuara para nisjes nuk përfshihen). Parashikimi = kurba e planit nga fillimi i dritares.</div></div>`;
}
function campPhase(date){
  const c=campCfg(); if(!c.start) return 'Pa plan';
  if(date<c.start){ return daysBetween(date,c.start)===1?'D-1 · Përgatitja':'Para kampanjës'; }
  if(date<=c.end) return 'Kampanja · dita '+(daysBetween(c.start,date)+1)+'/'+(daysBetween(c.start,c.end)+1);
  if(campDay(date)) return 'Pastrimi i backlog-ut';
  return 'Pas kampanjës';
}
function campCopy(text){
  const done=()=>toast('U kopjua');
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done,()=>campCopyFallback(text,done));
  else campCopyFallback(text,done);
}
function campCopyFallback(text,done){ const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); try{ document.execCommand('copy'); done(); }catch(e){ toast('Kopjimi dështoi'); } ta.remove(); }

/* checklists (generic — no WMS data) */
const CAMP_CHECK_D1=[
  ['Konfirmo me Marketing/Commercial orën e saktë të nisjes dhe orarin e email/push','WH Lead','09:00','Ora e nisjes e shënuar te Cilësimet'],
  ['Verifiko porositë e hapura pa check-out (statuset e paqarta në WMS); pastro backlog-un para nisjes','WH Lead + IT','10:00','Numri real i porosive të hapura i dokumentuar'],
  ['Cycle count i SKU-ve kryesore të kampanjës; korrigjo diferencat në WMS','Inventari','12:00','Stoku në sistem = stoku fizik për top SKU'],
  ['Materiali paketues: numëro stokun kundrejt nevojës + rezervë; konfirmo furnitorin emergjent','WH Lead','12:00','Setet ≥ nevoja e kampanjës; kontakti emergjent i konfirmuar'],
  ['Konfirmo me çdo kurier vëllimin ditor, marrjet shtesë dhe kontaktin për vonesa','Dispeçimi','12:00','Konfirmim me shkrim nga çdo kurier'],
  ['Testo arkat fiskale, skanerët, printerët, rrjetin dhe stacionet e WMS; pajisje rezervë gati','IT + WH Lead','13:00','Çdo tavolinë e testuar me një porosi prove'],
  ['Slotting: SKU-të kryesore afër tavolinave; zonë e veçantë për artikujt e rëndë','Shefi i stokut','14:00','Lokacionet e reja të skanuara në WMS'],
  ['Ndaj fizikisht SKU-të me rrezik ngatërrimi; etiketa dalluese','Shefi i stokut','14:00','Çdo variant në lokacion të veçantë'],
  ['Publiko planin e turneve; ndalo pushimet gjatë kampanjës; lista e rezervave me telefon','WH Lead + People and Culture','15:00','Çdo person e di turnin dhe rolin'],
  ['IT on-call dhe procedura manuale nëse WMS/printeri bie','IT','15:00','Emri dhe numri i IT on-call në tabelë'],
  ['Inbound: dritaret e pranimit me furnitorët, pa marrë njerëz nga outbound','Inbound','15:00','Orari i pranimeve i konfirmuar'],
  ['Dërgo planin e stafit dhe orët shtesë te menaxheri (kërkon miratim)','WH Lead','16:00','Miratimi i marrë'],
  ['Briefing i përgjithshëm me stafin për kampanjën','WH Lead','16:30','Të dy turnet të informuar'],
  ['Mbyll backlog-un e ditës — kampanja nis me 0 porosi të vonuara','Të gjithë','22:30','Backlog në fund = 0'],
];
const CAMP_CHECK_DAILY=[
  ['start','Fillimi i turnit',['Briefing 10-minutësh: objektivi i ditës, parashikimi, rolet, siguria','Të gjithë në pozicion; mungesat të mbuluara nga lista e rezervave','Tavolinat, arkat, skanerët dhe printerët funksionojnë','Lokacionet e top SKU-ve të rimbushura','Materiali paketues në çdo tavolinë','Kalimet dhe daljet emergjente të lira']],
  ['mid','Kontrolli në mes të turnit',['Raporti orar i plotësuar (të hyra / të përfunduara / backlog)','Ritmi real kundrejt të kërkuarit deri në cut-off','Rimbushja e lokacioneve dhe e materialit','Mungesat në raft të eskaluara te Commercial/CS','Pauzat e shkallëzuara sipas planit']],
  ['handover','Dorëzimi mes turneve',['Backlog-u dhe porositë problematike të dorëzuara me shkrim','Gjendja e pajisjeve dhe e materialeve','Mungesat e stokut dhe veprimet e hapura','Prioritetet e turnit të dytë (marrjet e kurierëve)']],
  ['close','Mbyllja e ditës',['Të gjitha porositë para cut-off të dorëzuara te kurieri/Showroom-i','Backlog-u në fund i numëruar dhe i regjistruar','Raporti ditor i plotësuar dhe i dërguar te menaxheri','Plani i stafit për nesër i konfirmuar','Zonat të pastra, materiali i rimbushur për nesër']],
];
const CAMP_CONTINGENCY=[
  ['Mungesë stafi','Mungojnë ≥ 2 persona në një turn','Aktivizo listën e rezervave; floater-i mbulon pozicionin kritik; rialoko nga inbound','WH Lead','30 min'],
  ['Volum mbi parashikim','Porositë ≥ pragu i skenarit të lartë','Aktivizo skenarin e lartë: turn i zgjatur/staf shtesë (kërkon miratim); njofto kurierët','WH Lead → Menaxheri','1 orë'],
  ['WMS / skanerët bien','Jashtë funksionit > pragu i alarmit','Procedura manuale (lista të printuara); IT on-call; prioritet porositë ekspres; rifutje pas rikthimit','IT + WH Lead','15 min'],
  ['Printeri / arka fiskale bie','Tavolinë jashtë funksionit','Kalo në pajisjen rezervë; rishpërndaj operatorët në tavolinat e tjera','WH Lead + IT','15 min'],
  ['Mospërputhje stoku','Short pick për top SKU','Verifikim brenda 10 min; njofto CS; kërko ndalimin e ofertës te Commercial','Shefi i stokut','30 min'],
  ['Bllokim hapësire','Zona e kurierëve/staging plot','Marrje shtesë nga kurieri; staging i përkohshëm; prioritet daljes para pranimeve','Dispeçimi','1 orë'],
  ['Vonesë kurieri','Marrja vonohet > 30 min','Telefono kurierin; kurier alternativ; njofto CS për vonesat','Dispeçimi','30 min'],
  ['Mungesë materiali paketues','Stoku < 1 ditë nevojë','Stok rezervë; furnitor emergjent; paketim alternativ i miratuar','WH Lead','2 orë'],
];

let campTab='live', campSel=null;
function campSelDate(){ if(campSel) return campSel; const t=campToday(), days=campDays();
  if(days.some(d=>d.date===t)) return t; const c=campCfg(); if(c.start&&t<c.start) return c.start; return days.length?days[days.length-1].date:t; }
function renderCampaign(v){
  const c=campCfg();
  const tabs=[['live','Pasqyra live'],['plan','Plani & stafi'],['hourly','Raporti orar'],['daily','Raporti ditor'],['alarms','Alarmet & rreziqet'],['checks','Checklist-at'],['prompt','Prompt-i AI'],['settings','Cilësimet']];
  v.innerHTML = pagehead(c.name||'Kampanja', `${c.start?h(fmtDateAl(c.start))+' – '+h(fmtDateAl(c.end)):'Pa plan të ngarkuar'} · ${h(campPhase(campToday()))}. Plani, rrjedha live nga WMS, raportet orare/ditore, alarmet dhe prompt-i për AI — në një vend.`,
      `<button class="btn" id="campXls">⬇ Excel</button>`)
    + `<div class="filters" id="campTabs">${tabs.map(t=>`<button class="btn ${campTab===t[0]?'primary':''}" data-ctab="${t[0]}">${t[1]}</button>`).join('')}</div>`
    + `<div id="campBody"></div>`;
  $$('#campTabs [data-ctab]').forEach(b=>b.onclick=()=>{ campTab=b.dataset.ctab; renderCampaign(v); });
  $('#campXls').onclick=campExportExcel;
  const body=$('#campBody');
  if(!c.days.length && campTab!=='settings' && campTab!=='checks' && campTab!=='alarms'){ campEmpty(body); return; }
  ({live:campLive, plan:campPlan, hourly:campHourly, daily:campDailyView, alarms:campAlarms, checks:campChecks, prompt:campPromptView, settings:campSettings}[campTab]||campLive)(body);
}
function campEmpty(box){
  box.innerHTML=`<div class="card"><h3>Ende s'ka plan kampanje</h3>
    <div class="hint" style="margin-bottom:10px">Ngarko planin lokal <b>campaign.local.json</b> (parashikimi, stafi, kampanjat e kaluara, SKU-të). Skedari mbetet vetëm në kompjuterin tënd dhe nuk shkon në GitHub.</div>
    <div class="btnrow"><button class="btn primary" id="campLoadLocal">⬇ Ngarko campaign.local.json</button>
    <label class="btn">📂 Zgjidh skedarin JSON<input type="file" id="campFile" accept="application/json" style="display:none"></label>
    <button class="btn" id="campGoSet">⚙ Ose plotëso te Cilësimet</button></div></div>`;
  $('#campLoadLocal').onclick=campLoadLocal;
  $('#campFile').onchange=campImportFile;
  $('#campGoSet').onclick=()=>{ campTab='settings'; renderCampaign($('#view')); };
}
function campApplyPlan(obj){
  if(!obj||typeof obj!=='object'||!Array.isArray(obj.days)) throw new Error('Skedari nuk ka "days"');
  const keepChecks=campCfg().checks;
  Store.db.campaign=Object.assign(JSON.parse(JSON.stringify(CAMP_DEFAULT)), obj, {checks:Object.assign({}, keepChecks, obj.checks||{})});
  campCfg(); Store.persist(); campSel=null;
}
function campLoadLocal(){
  fetch('campaign.local.json',{cache:'no-store'}).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(j=>{ campApplyPlan(j); toast('Plani u ngarkua'); renderCampaign($('#view')); })
    .catch(e=>toast('S\'u gjet campaign.local.json ('+(e.message||e)+') — përdor "Zgjidh skedarin JSON"'));
}
function campImportFile(e){ const f=e.target.files[0]; if(!f) return; const r=new FileReader();
  r.onload=()=>{ try{ campApplyPlan(JSON.parse(r.result)); toast('Plani u ngarkua'); renderCampaign($('#view')); }catch(err){ toast('Skedar i pavlefshëm: '+(err.message||err)); } }; r.readAsText(f); }

function campDayPicker(id){
  const sel=campSelDate();
  return `<select id="${id}">${campDays().map(d=>`<option value="${d.date}" ${d.date===sel?'selected':''}>${h(campDayName(d.date))} ${h(fmtDateAl(d.date))}${d.date===campToday()?' · sot':''}</option>`).join('')}</select>`;
}
function campWireDayPicker(id){ const s=$('#'+id); if(s) s.onchange=e=>{ campSel=e.target.value; renderCampaign($('#view')); }; }

/* ---- Pasqyra live ---- */
function campLive(box){
  const c=campCfg(), date=campSelDate(), day=campDay(date), calc=campCalc(date), ents=campEntries(date), last=ents[ents.length-1];
  const ev=last?campEval(last,date):null, w=campWms(date), rec=campDailyRec(date);
  const nowMin=new Date().getHours()*60+new Date().getMinutes();
  const expNow=date===campToday()?campExpWin(day,date,nowMin):(date<campToday()?campExpWin(day,date,1440):null), rw=campRealDay(date);
  const isToday=date===campToday(), L=date<=campToday()&&wmsOnAgent()? campLiveLoad(date) : null, L0= L? '—' : '<span class="small muted">po lexohet…</span>';
  const kc=(val,lbl,foot,cls)=>`<div class="card kpi"><div class="val ${cls||''}">${val}</div><div class="lbl">${lbl}</div>${foot?`<div class="foot">${foot}</div>`:''}</div>`;
  const devCls=ev&&ev.dev!=null?(ev.dev>=num(c.triggerPct,7)?'warn':(ev.dev<=-20?'warn':'ok')):'';
  const verify=c.context.verify||[];
  box.innerHTML=`<div class="filters" style="align-items:center">${campDayPicker('campLiveDay')}
      <span class="badge b-new">${h(campPhase(date))}</span>
      ${ev?campLevelBadge(ev.level)+` <span class="small muted">${h(ev.why)}</span>`:'<span class="small muted">Ende s\'ka raport orar për këtë ditë</span>'}
      <span style="margin-left:auto" class="btnrow"><button class="btn sm primary" id="campAddH">＋ Raport orar</button>${wmsOnAgent()?'<button class="btn sm" id="campSync">⟳ Sync WMS</button>':''}</span></div>
    ${verify.length?`<div class="note warn"><b>Për t'u verifikuar:</b> ${verify.map(h).join(' · ')}</div>`:''}
    ${campRealCard(date)}
    <div class="grid g-kpi" style="margin-bottom:14px">
      ${last? kc(campFmt(last.ordersIn),'Porosi të hyra deri '+h(last.time), ev&&ev.expected!=null?'pritej '+campFmt(ev.expected)+(ev.dev!=null?' ('+(ev.dev>=0?'+':'')+Math.round(ev.dev)+'%)':''):'', devCls)
        : kc(rw&&rw.has?campFmt(rw.cr):'—','Porosi të hyra nga '+h(campHHMM(campWinStart(date)))+' (WMS)', expNow!=null?'pritej'+(date===campToday()?' deri tani':'')+' ~'+campFmt(expNow):'')}
      ${kc(campFmt(day&&day.forecast),'Parashikimi i ditës', calc&&calc.wh!=null?campFmt(calc.wh)+' për depon ('+c.whSharePct+'%)':'')}
      ${kc(L&&L.pod!=null?campFmt(L.pod):L0,'Të përfunduara (POD)', L&&L.pod!=null?'porosi me skanim POD nga '+h(campHHMM(campWinStart(date)))+' · Delivery Platform, stafi në orar':(L&&L.podError?'POD: '+h(L.podError):''))}
      ${kc(L&&L.pending!=null?campFmt(num(L.pending)+num(L.ready)):(isToday?L0:'—'),'Backlog tani', L&&L.pending!=null?'pa POD pas check-out: <b>'+campFmt(L.pending)+'</b> · Ready to Complete: <b>'+(L.ready!=null?campFmt(L.ready):'—')+'</b> · '+h(fmtTime(L.pendingAt||L.at)):(isToday?(L&&L.pendingError?'POD: '+h(L.pendingError):''):'vetëm për sot (real time)'), L&&L.pending!=null&&num(c.kpi.backlogEnd)&&num(L.pending)+num(L.ready)>num(c.kpi.backlogEnd)?'warn':'')}
      ${kc(L&&L.tempo&&L.tempo.ordersPerHour!=null?L.tempo.ordersPerHour+' porosi/orë':L0,'Ritmi real', L&&L.tempo&&L.tempo.ordersPerHour!=null?'<b>'+L.tempo.productsPerHour+'</b> produkte/orë · '+(L.tempo.window==='last2h'?'2 orët e fundit (si Flow 2h)':'mesatarja nga '+h(campHHMM(campWinStart(date)))+' deri te check-out-i i fundit'):(L&&L.tempoError?'WMS: '+h(L.tempoError):''))}
      ${kc(ev&&ev.staffNeeded!=null?ev.staffNeeded:'—','Persona outbound të nevojshëm tani', 'me '+c.ordersPerHour+' porosi/orë/person'+(last&&last.staff!=null?' · prezent: '+last.staff:''))}
      ${kc(calc?calc.total||'—':'—','Stafi i planifikuar', day?`outbound ${num(day.outbound)} (${num(day.s1)} / ${num(day.s2)}) · inbound ${num(day.inbound)}`:'')}
      ${(()=>{ const s=L&&L.backlogEnd, manual=rec&&rec.backlogEnd!=null&&rec.backlogEnd!=='';
        const val= s? num(s.pending) : manual? num(rec.backlogEnd) : null, goal=num(c.kpi.backlogEnd);
        const foot= s? 'pa POD pas check-out · '+(isToday?'deri tani ('+h(fmtTime(s.at))+')':'gjendja e fundit '+h(fmtTime(s.at)))+' · objektivi ≤ '+campFmt(goal)
          : manual? 'nga raporti ditor · objektivi ≤ '+campFmt(goal) : 'regjistrohet çdo 30 min që nga 15.10.2026 · objektivi ≤ '+campFmt(goal);
        return kc(val!=null?campFmt(val):(L||!isToday?'—':L0),'Backlog në fund të ditës', foot, val!=null&&goal? (val>goal?'warn':'ok') : ''); })()}
    </div>
    <div class="grid g-2">
      <div class="card"><h3>Porositë e hyra: reale kundrejt parashikimit <span class="sub">kumulative sipas orës</span></h3>${campChartSVG(day,ents,date)}
        <div class="hint">— vija blu: parashikimi · - - portokalli: pragu i skenarit të lartë (+${c.triggerPct}%) · vija e errët: porositë e krijuara në WMS · pikat jeshile: raportet orare.${campWinStart(date)?' Dita e nisjes numërohet nga ora '+h(campHHMM(campWinStart(date)))+' (parashikimi dhe WMS nga ajo orë).':''}${day&&day.curve==='launch'?' Kurba e ditës së nisjes është zhvendosur te ora '+h(c.launchTime)+' (SUPOZIM).':''}</div></div>
      <div class="card"><h3>Live nga WMS <span class="sub">${w.snap?'snapshot '+h(fmtTime(w.snap.at)):'pa snapshot sot'}</span></h3>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          ${kc(campFmt(w.prepared),'Porosi të përgatitura', w.operators?w.operators+' operatorë':'')}
          ${kc(campFmt(w.checkedOut),'Produkte check-out','')}
          ${kc(campFmt(w.checkedIn),'Produkte check-in','')}
          ${kc(w.snap?campFmt(w.snap.ordersInProcessing):'—','Orders in processing', w.snap?'Ready to complete: '+campFmt(w.snap.ordersReadyToUnmap):'')}
        </div>
        ${w.snaps.length>1?`<h3 style="font-size:12.5px;margin:12px 0 4px">Orders in processing gjatë ditës</h3>${w.snaps.slice(-10).map(s=>barRow(fmtTime(s.at),num(s.ordersInProcessing),Math.max(1,...w.snaps.map(x=>num(x.ordersInProcessing))),'var(--imp)')).join('')}`:''}
        <div class="hint" style="margin-top:8px">Burimi: agjenti WMS (/Order/GetPreparedOrders, ProductLogs, GetDashboardStats). Përdori si kontroll për raportin orar; mos i ngatërro njësitë (porosi ≠ produkte).</div></div>
    </div>
    ${calc?`<div class="card" style="margin-top:14px"><h3>Kapaciteti i ditës</h3>
      <div class="small" style="display:grid;gap:4px">
        <div>Ngarkesa: <b>${campFmt(calc.workload)}</b> porosi (~${campFmt(calc.units)} njësi për pikim) · Kapaciteti i ${c.tables} tavolinave: <b>${campFmt(calc.tablesCap)}</b>/ditë ${calc.overCap?'<span class="badge b-crit">kalon kufirin e tavolinave</span>':'<span class="badge b-ok">brenda kufirit</span>'}</div>
        <div>Outbound i planifikuar: <b>${num(day.outbound)}</b> · i llogaritur: <b>${calc.outboundCalc??'—'}</b> ${calc.outboundCalc!=null&&num(day.outbound)<calc.outboundCalc?'<span class="badge b-warn">nën llogaritjen</span>':''}${calc.shiftOver?` · <span class="badge b-warn">${calc.shiftOver} persona më shumë se tavolinat në një turn → picker-a të dedikuar ose tavolinë shtesë</span>`:''}</div>
        ${day.note?`<div class="muted">${h(day.note)}</div>`:''}
      </div></div>`:''}`;
  campWireDayPicker('campLiveDay');
  $('#campAddH').onclick=()=>campHourlyForm(null,date);
  const sb=$('#campSync'); if(sb) sb.onclick=()=>{ sb.disabled=true; sb.textContent='⟳ Duke sinkronizuar…'; wmsAgentSync(2,1).then(r=>{ toast(r.ok?'WMS u sinkronizua':'Sync dështoi: '+r.msg); renderCampaign($('#view')); }); };
}
function campChartSVG(day,ents,date){
  if(!day) return '<div class="empty">—</div>';
  const W=640,H=210,pl=44,pr=10,pt=10,pb=24, c=campCfg();
  // expected and WMS from the window start (launch day: from the launch time), cumulative
  const w0=campWinStart(date), exp=Array.from({length:25},(_,hh)=>hh*60<w0? 0 : (campExpWin(day,date,hh*60)||0));
  const R=campRealDay(date); let cum=0; const wms=R&&R.has? [[w0,0]].concat(R.rows.map(r=>{ cum+=num(r.cr); return [Math.min(1440,(r.h+1)*60), cum]; })) : [];
  const max=Math.max(1,...exp.map(v=>v*(1+num(c.triggerPct,7)/100)),...ents.map(e=>num(e.ordersIn)),...wms.map(p=>p[1]));
  const X=m=>pl+(m/1440)*(W-pl-pr), Y=v=>H-pb-(v/max)*(H-pt-pb);
  const line=(arr,f)=>arr.map((v,i)=>`${X(i*60).toFixed(1)},${Y(f(v)).toFixed(1)}`).join(' ');
  const grid=[0,0.25,0.5,0.75,1].map(f=>`<line x1="${pl}" x2="${W-pr}" y1="${Y(max*f)}" y2="${Y(max*f)}" style="stroke:var(--line)"/><text x="${pl-6}" y="${Y(max*f)+4}" text-anchor="end" style="fill:var(--faint);font-size:10px">${campFmt(max*f)}</text>`).join('');
  const xt=[0,6,9,12,15,18,21,24].map(hh=>`<text x="${X(hh*60)}" y="${H-6}" text-anchor="middle" style="fill:var(--faint);font-size:10px">${String(hh).padStart(2,'0')}</text>`).join('');
  const cut=campMin(c.cutoff);
  const pts=ents.filter(e=>e.ordersIn!=null&&e.ordersIn!=='').map(e=>`<circle cx="${X(campMin(e.time))}" cy="${Y(num(e.ordersIn))}" r="4" style="fill:var(--ok)"><title>${h(e.time)}: ${campFmt(e.ordersIn)}</title></circle>`).join('');
  const act=ents.filter(e=>e.ordersIn!=null&&e.ordersIn!=='').map(e=>`${X(campMin(e.time)).toFixed(1)},${Y(num(e.ordersIn)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${grid}${xt}
    <line x1="${X(cut)}" x2="${X(cut)}" y1="${pt}" y2="${H-pb}" style="stroke:var(--faint);stroke-dasharray:2 3"/><text x="${X(cut)+3}" y="${pt+10}" style="fill:var(--faint);font-size:10px">cut-off ${h(c.cutoff)}</text>
    <polyline points="${line(exp,v=>v*(1+num(c.triggerPct,7)/100))}" style="fill:none;stroke:var(--imp);stroke-width:1.5;stroke-dasharray:5 4"/>
    <polyline points="${line(exp,v=>v)}" style="fill:none;stroke:var(--accent);stroke-width:2"/>
    ${w0? `<line x1="${X(w0)}" x2="${X(w0)}" y1="${pt}" y2="${H-pb}" style="stroke:var(--accent);stroke-dasharray:2 3"/><text x="${X(w0)-3}" y="${pt+10}" text-anchor="end" style="fill:var(--accent);font-size:10px">nisja ${h(campHHMM(w0))}</text>` : ''}
    ${wms.length?`<polyline points="${wms.map(p=>X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' ')}" style="fill:none;stroke:var(--text);stroke-width:2"/>${wms.slice(1).map(p=>`<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="2.5" style="fill:var(--text)"><title>WMS deri ${campHHMM(p[0])}: ${campFmt(p[1])}</title></circle>`).join('')}`:''}
    ${act?`<polyline points="${act}" style="fill:none;stroke:var(--ok);stroke-width:2"/>`:''}${pts}</svg>`;
}

/* ---- Plani & stafi ---- */
function campPlan(box){
  const c=campCfg(), days=campDays();
  const rows=days.map(d=>{ const k=campCalc(d.date), rec=campDailyRec(d.date), ents=campEntries(d.date), last=ents[ents.length-1];
    const rw=campRealDay(d.date), inReal=rec&&rec.ordersIn!=null&&rec.ordersIn!==''?num(rec.ordersIn):(last?num(last.ordersIn):(rw&&rw.has?rw.cr:null));
    return {d,k,rec,inReal}; });
  const sum=f=>rows.reduce((a,r)=>a+num(f(r)),0);
  const ctx=(t,arr,tag)=>arr&&arr.length?`<div class="card"><h3>${t}</h3><div class="small" style="display:grid;gap:5px">${arr.map(x=>`<div><span class="etag ${tag||'et-fact'}">${tag==='et-hyp'?'supozim':tag==='et-rec'?'mësim':'fakt'}</span>${h(x)}</div>`).join('')}</div></div>`:'';
  box.innerHTML=`<div class="card" style="margin-bottom:14px"><h3>Parashikimi dhe stafi ditë për ditë <span class="sub">ngarkesa = ½ porositë e sotme + ½ të djeshmet · ${c.ordersPerHour} porosi/orë × ${c.shiftHours}h · +${c.reservePct}% rezervë</span></h3>
    <div class="tablewrap"><table><thead><tr><th>Dita</th><th>Porosi (parash.)</th><th>Për depon</th><th>Ngarkesa</th><th>Outbound<br><span class="sub">plan / llogaritur</span></th><th>${h((c.shifts[0]||{}).name||'T1')} / ${h((c.shifts[1]||{}).name||'T2')}</th><th>Inbound</th><th>Gjithsej</th><th>Skenari i lartë</th><th>Reale: hyrë</th><th>Përfunduar</th><th>Backlog fund</th><th>Staf real</th><th></th></tr></thead>
    <tbody>${rows.map(({d,k,rec,inReal})=>`<tr ${d.date===campToday()?'style="outline:1px solid var(--accent)"':''}>
      <td><b>${h(campDayName(d.date))}</b> <span class="small muted">${h(fmtDateAl(d.date))}</span></td>
      <td>${campFmt(d.forecast)}</td><td>${campFmt(k.wh)}</td>
      <td>${campFmt(k.workload)} ${k.overCap?'<span class="badge b-crit" title="Kalon kapacitetin e tavolinave">> '+campFmt(k.tablesCap)+'</span>':''}</td>
      <td><b>${num(d.outbound)}</b> / ${k.outboundCalc??'—'} ${k.outboundCalc!=null&&num(d.outbound)<k.outboundCalc?'<span class="badge b-warn">↓</span>':''}</td>
      <td>${num(d.s1)} / ${num(d.s2)} ${k.shiftOver?'<span class="badge b-warn" title="Më shumë persona se tavolina në një turn">+'+k.shiftOver+'</span>':''}</td>
      <td>${num(d.inbound)}</td><td><b>${k.total}</b></td><td>${d.highTotal?num(d.highTotal):'—'}</td>
      <td>${inReal!=null?campFmt(inReal)+(d.forecast?` <span class="small muted">(${Math.round(inReal/num(d.forecast)*100)}%)</span>`:''):'—'}</td>
      <td>${rec&&rec.completed!=null&&rec.completed!==''?campFmt(rec.completed):'—'}</td>
      <td>${rec&&rec.backlogEnd!=null&&rec.backlogEnd!==''?campFmt(rec.backlogEnd):'—'}</td>
      <td>${rec&&rec.staffActual!=null&&rec.staffActual!==''?num(rec.staffActual):'—'}</td>
      <td><button class="btn sm" data-cde="${d.date}">Edit</button></td></tr>`).join('')}
      <tr style="border-top:2px solid var(--line)"><td><b>Gjithsej</b></td><td><b>${campFmt(sum(r=>r.d.forecast))}</b></td><td><b>${campFmt(sum(r=>r.k.wh))}</b></td><td></td><td></td><td></td><td></td><td></td><td></td>
      <td><b>${campFmt(sum(r=>r.inReal))}</b></td><td><b>${campFmt(sum(r=>r.rec&&r.rec.completed))}</b></td><td></td><td></td><td></td></tr></tbody></table></div>
    <div class="btnrow" style="margin-top:8px"><button class="btn sm" id="campAddDay">＋ Ditë</button>
      <span class="hint">Kapaciteti i ${c.tables} tavolinave = ${c.tables} × ${c.ordersPerHour}/orë × ${campOpsHours()} orë = <b>${campFmt(num(c.tables)*num(c.ordersPerHour)*campOpsHours())}</b> porosi/ditë. Skenari i lartë = +${c.highPct}% volum.</span></div></div>
    <div class="grid g-2">
      ${ctx('Baseline (para kampanjës)',c.context.baseline)}
      ${ctx('Kampanjat e kaluara',c.context.past)}
      ${ctx('Mësimi kryesor',c.context.lesson,'et-rec')}
      ${ctx('Produktiviteti',c.context.productivity)}
      ${ctx('Kapaciteti fizik, stafi, kurierët',c.context.capacity)}
      ${ctx('SKU-të e kampanjës',c.context.skus)}
    </div>
    <div class="note">Materiali paketues: <b>${campFmt(c.packSets)}</b> sete · Kurierët: <b>${h(c.couriers||'—')}</b> · Marrjet: <b>${h(c.pickups||'—')}</b> · Kapaciteti/kurier: <b>${campFmt(c.courierCap)}</b> pako/ditë · Cut-off: <b>${h(c.cutoff)}</b></div>`;
  $$('#campBody [data-cde]').forEach(b=>b.onclick=()=>campDayForm(campDay(b.dataset.cde)));
  $('#campAddDay').onclick=()=>campDayForm(null);
}
function campDayForm(existing){
  const fields=[
    {name:'date',label:'Data',type:'date',required:true,row:'a',noToday:true},
    {name:'forecast',label:'Porosi gjithsej (parashikim)',type:'number',row:'a',hint:'Bosh për ditët e pastrimit'},
    {name:'workload',label:'Ngarkesa (opsionale)',type:'number',row:'a',hint:'Bosh = ½ sot + ½ dje'},
    {name:'outbound',label:'Outbound (plan)',type:'number',row:'b'},
    {name:'s1',label:'Turni 1',type:'number',row:'b'},
    {name:'s2',label:'Turni 2',type:'number',row:'b'},
    {name:'inbound',label:'Inbound (plan)',type:'number',row:'c'},
    {name:'highTotal',label:'Gjithsej në skenarin e lartë',type:'number',row:'c'},
    {name:'curve',label:'Kurba e porosive',type:'select',options:[{v:'normal',l:'Ditë normale'},{v:'launch',l:'Dita e nisjes'}],row:'c'},
    {name:'note',label:'Shënim',type:'textarea',rows:2},
  ];
  openForm({title:existing?'Dita '+fmtDateAl(existing.date):'Ditë e re', fields, values:existing||{curve:'normal'},
    onSave:vals=>{ const c=campCfg(); if(!vals.date){ toast('Data mungon'); return; }
      const i=c.days.findIndex(d=>d.date===(existing?existing.date:vals.date));
      if(i>=0) c.days[i]=Object.assign({},c.days[i],vals); else c.days.push(vals);
      Store.persist(); closeModal(); renderCampaign($('#view')); toast('U ruajt'); }});
  if(existing){ const foot=$('#modalRoot .foot'); const b=document.createElement('button'); b.className='btn danger'; b.textContent='Fshi'; b.style.marginRight='auto';
    b.onclick=()=>{ const c=campCfg(); c.days=c.days.filter(d=>d.date!==existing.date); Store.persist(); closeModal(); renderCampaign($('#view')); }; foot.prepend(b); }
}

/* ---- Raporti orar ---- */
function campHourly(box){
  const date=campSelDate(), ents=campEntries(date), c=campCfg();
  box.innerHTML=`<div class="filters" style="align-items:center">${campDayPicker('campHDay')}
      <button class="btn sm primary" id="campAddH">＋ Raport orar</button>
      <span class="hint">Kumulativet janë për ditën (nga 00:00${c.start&&campMin(c.launchTime)?'; dita e nisjes '+h(fmtDateAl(c.start))+' nga ora '+h(c.launchTime):''}). Backlog-u bosh llogaritet: backlog në fillim + të hyra − të përfunduara.</span></div>
    <div class="tablewrap"><table><thead><tr><th>Ora</th><th>Të hyra</th><th>Pritej</th><th>Dev.</th><th>Pikuar</th><th>Përfunduar</th><th>Dërguar</th><th>Backlog</th><th>Ritmi real</th><th>I kërkuar</th><th>%</th><th>Gabime</th><th>Staf</th><th>Alarmi</th><th></th></tr></thead>
    <tbody>${ents.length?ents.map(e=>{ const x=campEval(e,date); return `<tr>
      <td><b>${h(e.time)}</b>${e.source?` <span class="badge b-muted">${h(e.source)}</span>`:''}</td>
      <td>${campFmt(e.ordersIn)}</td><td class="muted">${campFmt(x.expected)}</td>
      <td>${x.dev!=null?`<span style="color:${x.dev>=num(c.triggerPct)?'var(--warn)':x.dev<=-20?'var(--warn)':'var(--ok)'}">${x.dev>=0?'+':''}${Math.round(x.dev)}%</span>`:'—'}</td>
      <td>${campFmt(e.picked)}</td><td>${campFmt(e.completed)}</td><td>${campFmt(e.dispatched)}</td>
      <td>${campFmt(x.backlog)}${x.conflict?` <span class="badge b-warn" title="Backlog i futur ndryshon nga llogaritja ${campFmt(x.backlogCalc)}">≠ ${campFmt(x.backlogCalc)}</span>`:''}</td>
      <td>${x.real!=null?Math.round(x.real)+'/h':'—'}</td><td>${x.required!=null?Math.round(x.required)+'/h':'—'}</td>
      <td>${x.ratio!=null?Math.round(x.ratio)+'%':'—'}</td><td>${campFmt(e.errors)}</td><td>${e.staff!=null&&e.staff!==''?num(e.staff):'—'}${x.staffNeeded!=null?` <span class="small muted">/ ${x.staffNeeded}</span>`:''}</td>
      <td title="${h(x.why)}">${campLevelBadge(x.level)}</td>
      <td><button class="btn sm" data-che="${e.id}">Edit</button> <button class="btn sm danger" data-chd="${e.id}">✕</button></td></tr>`+(e.note?`<tr><td></td><td colspan="14" class="small muted wrap">${h(e.note)}</td></tr>`:''); }).join(''):emptyRow(15,'Ende s\'ka raporte orare për këtë ditë.')}</tbody></table></div>
    <div class="note">Përkufizimet: <b>E përfunduar</b> = e paketuar, e etiketuar dhe në zonën e kurierit/Showroom-it · <b>E dërguar</b> = e dorëzuar fizikisht te kurieri ose Showroom-i · <b>Ritmi i kërkuar</b> = backlog ÷ orët deri në ${h(c.paceDeadline||c.cutoff)}${c.paceDeadline&&c.paceDeadline!==c.cutoff?' (afati i ritmit; cut-off '+h(c.cutoff)+')':' (cut-off)'}, pas tij deri në mbyllje · <b>Alarmi</b>: Niveli 2 kur ritmi &lt; ${c.alarmL2}% në dy kontrolle radhazi, Niveli 3 kur &lt; ${c.alarmL3}% ose sistemi bie ≥ ${c.sysDownMin} min.</div>`;
  campWireDayPicker('campHDay');
  $('#campAddH').onclick=()=>campHourlyForm(null,date);
  $$('#campBody [data-che]').forEach(b=>b.onclick=()=>campHourlyForm(Store.get('campHourly',b.dataset.che),date));
  $$('#campBody [data-chd]').forEach(b=>b.onclick=()=>{ const r=Store.get('campHourly',b.dataset.chd); confirmDelete('raportin e '+r.time,()=>{ Store.remove('campHourly',r.id); renderCampaign($('#view')); }); });
}
function campHourlyForm(existing,date){
  const w=campWms(date);
  const fields=[
    {name:'date',label:'Data',type:'date',required:true,row:'a',value:date},
    {name:'time',label:'Ora',type:'time',required:true,row:'a'},
    {name:'staff',label:'Staf prezent (outbound)',type:'number',row:'a'},
    {type:'section',label:'Kumulative për ditën',hint:'nga 00:00 deri tani'},
    {name:'ordersIn',label:'Porosi të hyra',type:'number',row:'b',required:true},
    {name:'picked',label:'Të pikuara',type:'number',row:'b'},
    {name:'completed',label:'Të përfunduara',type:'number',row:'b',hint:wmsOnAgent()||w.prepared?'WMS: '+campFmt(w.prepared)+' të përgatitura':''},
    {name:'dispatched',label:'Të dërguara',type:'number',row:'c'},
    {name:'backlog',label:'Backlog tani (opsional)',type:'number',row:'c',hint:w.snap?'WMS in processing: '+campFmt(w.snap.ordersInProcessing):'Bosh = llogaritet'},
    {name:'errors',label:'Gabime (pick/pack)',type:'number',row:'c'},
    {name:'sysDownMin',label:'Minuta me sistem/pajisje kyçe jashtë funksionit',type:'number',row:'d'},
    {name:'source',label:'Burimi',type:'select',options:['manual','WMS','WMS + manual'],row:'d'},
    {name:'note',label:'Shënim (ngushtica, veprimet)',type:'textarea',rows:2},
  ];
  openForm({title:existing?'Raporti orar '+existing.time:'Raport orar', fields, values:existing||{date, time:nowTime(), source:'manual'},
    extra:(w.prepared||w.snap)?`<div class="btnrow" style="margin-top:6px"><button class="btn sm" id="campFillWms" type="button">↧ Plotëso nga WMS (përgatitura → përfunduara)</button></div>`:'',
    onSave:vals=>{ if(existing) Store.update('campHourly',existing.id,vals); else Store.insert('campHourly',vals); campSel=vals.date; closeModal(); renderCampaign($('#view')); toast('Raporti u ruajt'); }});
  const fb=$('#campFillWms'); if(fb) fb.onclick=()=>{ if(w.prepared) $('#f_completed').value=w.prepared; $('#f_source').value='WMS + manual'; toast('Verifiko numrat para ruajtjes'); };
}

/* ---- Raporti ditor ---- */
function campDailyView(box){
  const date=campSelDate(), rec=campDailyRec(date), c=campCfg(), day=campDay(date), k=campCalc(date);
  const ents=campEntries(date), last=ents[ents.length-1], ev=last?campEval(last,date):null;
  const val=(f,alt)=>rec&&rec[f]!=null&&rec[f]!==''?rec[f]:alt;
  const inR=val('ordersIn',last?last.ordersIn:null), comp=val('completed',last?last.completed:null);
  const real=(a,b)=>a!=null&&b?Math.round(num(a)/num(b)*100)+'%':'—';
  box.innerHTML=`<div class="filters" style="align-items:center">${campDayPicker('campDDay')}
      <button class="btn sm primary" id="campEditD">${rec?'✎ Ndrysho raportin':'＋ Plotëso raportin ditor'}</button>
      <button class="btn sm" id="campTxt">📋 Teksti për menaxherin</button></div>
    <div class="grid g-2">
      <div class="card"><h3>Plan kundrejt realizimit</h3><div class="tablewrap"><table><thead><tr><th>Treguesi</th><th>Plani</th><th>Realizimi</th><th>%</th></tr></thead><tbody>
        <tr><td>Porosi të hyra</td><td>${campFmt(day&&day.forecast)}</td><td>${campFmt(inR)}</td><td>${real(inR,day&&day.forecast)}</td></tr>
        <tr><td>Porosi të përfunduara</td><td>${campFmt(k&&k.workload)}</td><td>${campFmt(comp)}</td><td>${real(comp,k&&k.workload)}</td></tr>
        <tr><td>Backlog në fund</td><td>≤ ${campFmt(c.kpi.backlogEnd)}</td><td>${campFmt(val('backlogEnd'))}</td><td>${val('backlogEnd')!=null?(num(val('backlogEnd'))<=num(c.kpi.backlogEnd)?'<span class="badge b-ok">OK</span>':'<span class="badge b-crit">mbi objektiv</span>'):'—'}</td></tr>
        <tr><td>Stafi</td><td>${k?k.total:'—'}</td><td>${val('staffActual')!=null?num(val('staffActual')):'—'}</td><td>${real(val('staffActual'),k&&k.total)}</td></tr>
        <tr><td>Saktësia pick/pack</td><td>≥ ${c.kpi.accuracy}%</td><td>${comp&&val('errors')!=null?(Math.round((1-num(val('errors'))/num(comp))*1000)/10)+'%':'—'}</td><td></td></tr>
      </tbody></table></div>
      <div class="hint" style="margin-top:6px">Backlog në fund = backlog në fillim (${campFmt(campBacklogStart(date))}) + të hyra − të përfunduara${campBacklogStart(date)!=null&&inR!=null&&comp!=null?' = <b>'+campFmt(campBacklogStart(date)+num(inR)-num(comp))+'</b>':''}. Alarmi i fundit: ${ev?campLevelBadge(ev.level):'—'}</div></div>
      <div class="card"><h3>Cilësia, siguria, pajisjet</h3><div class="small" style="display:grid;gap:6px">
        <div><b>Gabime:</b> ${campFmt(val('errors'))} ${val('rootCause')?'· shkaku: '+h(val('rootCause')):''}</div>
        <div><b>Siguria:</b> ${h(val('safety','—'))}</div>
        <div><b>Pajisjet / sistemi:</b> ${h(val('equipment','—'))}</div>
        <div><b>Përmbledhje:</b> ${h(val('summary','—'))}</div></div></div>
      <div class="card"><h3>3 prioritetet për nesër</h3><ol class="small">${[val('prio1'),val('prio2'),val('prio3')].filter(Boolean).map(p=>`<li>${h(p)}</li>`).join('')||'<li class="muted">—</li>'}</ol></div>
      <div class="card"><h3>Vendime që kërkojnë menaxhmentin</h3><div class="small">${h(val('decisions','—'))}</div></div>
    </div>`;
  campWireDayPicker('campDDay');
  $('#campEditD').onclick=()=>campDailyForm(rec,date,{ordersIn:inR,completed:comp});
  $('#campTxt').onclick=()=>{ const t=campDailyText(date); openModal('Raporti ditor — '+fmtDateAl(date),`<textarea id="campTxtArea" rows="18" style="font-family:ui-monospace,Consolas,monospace;font-size:12px">${h(t)}</textarea>`,
    `<button class="btn ghost" id="mcancel">Mbyll</button><button class="btn primary" id="campCopyT">📋 Kopjo</button>`); $('#mcancel').onclick=closeModal; $('#campCopyT').onclick=()=>campCopy($('#campTxtArea').value); };
}
function campDailyForm(rec,date,pre){
  const fields=[
    {type:'section',label:'Numrat e ditës'},
    {name:'backlogStart',label:'Backlog në fillim',type:'number',row:'a',hint:'Bosh = backlog-u në fund i ditës së kaluar'},
    {name:'ordersIn',label:'Porosi të hyra',type:'number',row:'a'},
    {name:'completed',label:'Porosi të përfunduara',type:'number',row:'a'},
    {name:'dispatched',label:'Porosi të dërguara',type:'number',row:'b'},
    {name:'backlogEnd',label:'Backlog në fund',type:'number',row:'b'},
    {name:'staffActual',label:'Stafi real (persona)',type:'number',row:'b'},
    {name:'errors',label:'Gabime pick/pack',type:'number',row:'c'},
    {name:'rootCause',label:'Shkaku rrënjësor i gabimeve',type:'select',options:['Njerëzor','Trajnim','Procedurë','Sistem','Organizim','I panjohur'],row:'c'},
    {type:'section',label:'Cilësia dhe mbyllja'},
    {name:'safety',label:'Siguria (incidente, rreziqe)',type:'text'},
    {name:'equipment',label:'Pajisjet dhe sistemi',type:'text'},
    {name:'summary',label:'Përmbledhje e ditës',type:'textarea',rows:2},
    {name:'prio1',label:'Prioriteti 1 për nesër',type:'text'},
    {name:'prio2',label:'Prioriteti 2 për nesër',type:'text'},
    {name:'prio3',label:'Prioriteti 3 për nesër',type:'text'},
    {name:'decisions',label:'Vendime që kërkojnë menaxhmentin',type:'textarea',rows:2},
  ];
  openForm({title:'Raporti ditor — '+fmtDateAl(date), fields, values:rec||{ordersIn:pre.ordersIn,completed:pre.completed},
    onSave:vals=>{ vals.date=date; if(rec) Store.update('campDaily',rec.id,vals); else Store.insert('campDaily',vals); closeModal(); renderCampaign($('#view')); toast('Raporti ditor u ruajt'); }});
}
function campDailyText(date){
  const c=campCfg(), rec=campDailyRec(date)||{}, day=campDay(date)||{}, k=campCalc(date)||{}, ents=campEntries(date), last=ents[ents.length-1]||{};
  const inR=rec.ordersIn!=null&&rec.ordersIn!==''?rec.ordersIn:last.ordersIn, comp=rec.completed!=null&&rec.completed!==''?rec.completed:last.completed;
  const pctOf=(a,b)=>a!=null&&a!==''&&b?' ('+Math.round(num(a)/num(b)*100)+'%)':'';
  const ev=ents.length?campEval(ents[ents.length-1],date):null;
  return [`RAPORTI DITOR — ${c.name} — ${campDayName(date)} ${fmtDateAl(date)}`, c.manager?`Për: ${c.manager}`:'', '',
    `1. PËRMBLEDHJE: ${rec.summary||'—'}`, '',
    '2. PLAN KUNDREJT REALIZIMIT',
    `- Porosi të hyra: ${campFmt(inR)} / plan ${campFmt(day.forecast)}${pctOf(inR,day.forecast)}`,
    `- Porosi të përfunduara: ${campFmt(comp)} / ngarkesa ${campFmt(k.workload)}${pctOf(comp,k.workload)}`,
    `- Të dërguara: ${campFmt(rec.dispatched)}`, '',
    '3. BACKLOG',
    `- Në fillim: ${campFmt(campBacklogStart(date))} · Në fund: ${campFmt(rec.backlogEnd)} (objektivi ≤ ${campFmt(c.kpi.backlogEnd)})`,
    `- Alarmi i fundit: ${ev?'Niveli '+ev.level+' — '+ev.why:'—'}`, '',
    '4. CILËSIA',
    `- Gabime pick/pack: ${campFmt(rec.errors)}${rec.rootCause?' · shkaku: '+rec.rootCause:''}${comp&&rec.errors!=null&&rec.errors!==''?' · saktësia '+(Math.round((1-num(rec.errors)/num(comp))*1000)/10)+'% (objektivi ≥ '+c.kpi.accuracy+'%)':''}`, '',
    '5. STAFI',
    `- Plan: ${k.total||'—'} (outbound ${num(day.outbound)}: ${num(day.s1)}/${num(day.s2)}, inbound ${num(day.inbound)}) · Real: ${rec.staffActual!=null&&rec.staffActual!==''?rec.staffActual:'—'}`, '',
    '6. SIGURIA DHE PAJISJET',
    `- Siguria: ${rec.safety||'—'}`, `- Pajisjet/sistemi: ${rec.equipment||'—'}`, '',
    '7. 3 PRIORITETET PËR NESËR', ...[rec.prio1,rec.prio2,rec.prio3].map((p,i)=>`${i+1}. ${p||'—'}`), '',
    '8. VENDIME QË KËRKOJNË MENAXHMENTIN', rec.decisions||'—'].filter((l,i)=>!(i===1&&!l)).join('\n');
}

/* ---- Alarmet & rreziqet ---- */
function campAlarms(box){
  const c=campCfg();
  const days=campDays().map(d=>{ const e=campEntries(d.date); const last=e[e.length-1]; return {d, ev:last?campEval(last,d.date):null, last}; });
  box.innerHTML=`<div class="card" style="margin-bottom:14px"><h3>Matrica e alarmeve <span class="sub">PROPOZIM për t'u konfirmuar · pragjet ndryshohen te Cilësimet</span></h3>
    <div class="tablewrap"><table><thead><tr><th>Niveli</th><th class="wrap">Kushti</th><th class="wrap">Kush njoftohet</th><th class="wrap">Veprimi</th><th>Afati</th><th class="wrap">Kthimi në normalitet</th></tr></thead><tbody>
      <tr><td>${campLevelBadge(1)}</td><td class="wrap">Ritmi real ≥ ${c.alarmL2}% e të kërkuarit</td><td class="wrap">Shefat e zonave</td><td class="wrap">Vazhdo; kontroll orar; rimbushje</td><td>çdo orë</td><td class="wrap">—</td></tr>
      <tr><td>${campLevelBadge(2)}</td><td class="wrap">Ritmi &lt; ${c.alarmL2}% në dy kontrolle radhazi</td><td class="wrap">WH Lead</td><td class="wrap">Floater te ngushtica; rialoko nga inbound; shty pauzat; thirr 1–2 nga rezervat</td><td>30 min</td><td class="wrap">Ritmi ≥ ${c.alarmL2}% në kontrollin e radhës</td></tr>
      <tr><td>${campLevelBadge(3)}</td><td class="wrap">Ritmi &lt; ${c.alarmL3}%, ose sistem/pajisje kyçe jashtë funksionit ≥ ${c.sysDownMin} min</td><td class="wrap">WH Lead → ${h(c.manager||'Menaxheri')}, Operations, IT, Customer Support</td><td class="wrap">Skenari i lartë / turn shtesë (kërkon miratim); procedura manuale; njofto CS për vonesat</td><td>15 min</td><td class="wrap">Dy kontrolle radhazi ≥ ${c.alarmL2}%</td></tr>
    </tbody></table></div></div>
    <div class="card" style="margin-bottom:14px"><h3>Gjendja sipas ditëve <span class="sub">nga raporti i fundit orar</span></h3>
      <div class="tablewrap"><table><thead><tr><th>Dita</th><th>Raporti i fundit</th><th>Niveli</th><th class="wrap">Arsyeja</th><th>Persona të nevojshëm</th></tr></thead><tbody>
      ${days.map(({d,ev,last})=>`<tr><td>${h(campDayName(d.date))} ${h(fmtDateAl(d.date))}</td><td>${last?h(last.time):'—'}</td><td>${ev?campLevelBadge(ev.level):'—'}</td><td class="wrap small">${ev?h(ev.why):'—'}</td><td>${ev&&ev.staffNeeded!=null?ev.staffNeeded:'—'}</td></tr>`).join('')||emptyRow(5,'—')}</tbody></table></div></div>
    <div class="card"><h3>Planet rezervë</h3><div class="tablewrap"><table><thead><tr><th>Rreziku</th><th class="wrap">Shkaktari</th><th class="wrap">Veprimi</th><th>Pronari</th><th>Afati</th></tr></thead><tbody>
      ${CAMP_CONTINGENCY.map(r=>`<tr><td><b>${h(r[0])}</b></td><td class="wrap small">${h(r[1])}</td><td class="wrap small">${h(r[2])}</td><td class="small">${h(r[3])}</td><td class="small">${h(r[4])}</td></tr>`).join('')}</tbody></table></div></div>`;
}

/* ---- Checklist-at ---- */
function campChecks(box){
  const c=campCfg(), date=campSelDate();
  const d1=c.start?fmtLocalDate(new Date(dobj(c.start).getTime()-86400000)):'';
  const item=(key,text,meta)=>{ const s=c.checks[key]; return `<label style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--line);cursor:pointer">
    <input type="checkbox" data-ck="${h(key)}" ${s&&s.done?'checked':''} style="width:auto;min-height:auto;margin-top:3px">
    <span style="flex:1"><span style="${s&&s.done?'text-decoration:line-through;color:var(--faint)':''}">${h(text)}</span>${meta?`<div class="hint">${meta}</div>`:''}</span>
    ${s&&s.done?`<span class="small muted">${h(fmtTime(s.at))}</span>`:''}</label>`; };
  const doneCount=keys=>keys.filter(k=>c.checks[k]&&c.checks[k].done).length;
  const d1keys=CAMP_CHECK_D1.map((_,i)=>'d1:'+i);
  box.innerHTML=`<div class="grid g-2">
    <div class="card"><h3>Checklist D-1 ${d1?'· '+h(fmtDateAl(d1)):''} <span class="sub">${doneCount(d1keys)}/${d1keys.length}</span></h3>
      ${CAMP_CHECK_D1.map((r,i)=>item('d1:'+i,r[0],`${h(r[1])} · ${h(r[2])} · <i>${h(r[3])}</i>`)).join('')}</div>
    <div class="card"><h3 style="flex-wrap:wrap">Checklist ditore ${campDays().length?campDayPicker('campCDay'):''}</h3>
      ${CAMP_CHECK_DAILY.map(([id,title,items])=>{ const keys=items.map((_,i)=>date+':'+id+':'+i);
        return `<div class="formsection">${h(title)}<span>${doneCount(keys)}/${keys.length}</span></div>${items.map((t,i)=>item(date+':'+id+':'+i,t)).join('')}`; }).join('')}</div>
  </div>
  <div class="card" style="margin-top:14px"><h3>Briefing-u 10-minutësh <span class="sub">lexoje në fillim të çdo turni</span></h3>
    <textarea id="campBrief" rows="12" style="font-size:13px">${h(campBriefText(date))}</textarea>
    <div class="btnrow" style="margin-top:8px"><button class="btn sm" id="campCopyBrief">📋 Kopjo</button></div></div>`;
  campWireDayPicker('campCDay');
  $$('#campBody [data-ck]').forEach(cb=>cb.onchange=()=>{ const k=cb.dataset.ck; if(cb.checked) c.checks[k]={done:true,at:nowISO(),by:Store.db.config.currentUser}; else delete c.checks[k]; Store.persist(); renderCampaign($('#view')); });
  $('#campCopyBrief').onclick=()=>campCopy($('#campBrief').value);
}
function campBriefText(date){
  const c=campCfg(), day=campDay(date), k=campCalc(date);
  return [`Mirëmëngjes / mirëmbrëma. Sot është ${campDayName(date).toLowerCase()} ${fmtDateAl(date)} — ${campPhase(date)}.`, '',
    `1. Objektivi i sotëm: presim rreth ${campFmt(day&&day.forecast)} porosi. Çdo porosi që vjen para orës ${c.cutoff} del sot.`,
    `2. Rolet: ${day?num(day.outbound)+' persona në outbound ('+num(day.s1)+' në turnin e parë, '+num(day.s2)+' në të dytin) dhe '+num(day.inbound)+' në inbound':'sipas planit të turneve'}. Floater-i shkon aty ku krijohet radhë.`,
    `3. Saktësia para shpejtësisë: skano çdo artikull. Kujdes me produktet që ngjajnë — kontrollo SKU-në, jo vetëm emrin.`,
    `4. Parfumet janë të thyeshme: material mbrojtës në çdo pako.`,
    `5. Mungesë në raft? Njofto menjëherë shefin e zonës — mos e lër porosinë anash.`,
    `6. Marrjet e kurierëve: ${c.pickups||'sipas orarit'}. Pakot gati 15 minuta para marrjes.`,
    `7. Pauzat me radhë — linja nuk ndalet kurrë.`,
    `8. Siguria: kalimet dhe daljet e lira, ngrije peshën me këmbë, kërko ndihmë për artikujt e rëndë.`,
    `9. Problem me pajisjen ose sistemin? Thuaje menjëherë — kemi procedurë rezervë.`, '',
    `Faleminderit — ia dalim bashkë.`].join('\n');
}

/* ---- Prompt-i AI ---- */
function campPromptView(box){
  const date=campSelDate();
  box.innerHTML=`<div class="card" style="margin-bottom:14px"><h3>Prompt-i i plotë i planit operativ <span class="sub">plotësohet automatikisht nga plani dhe të dhënat e app-it</span></h3>
      <textarea id="campPromptMain" rows="22" style="font-family:ui-monospace,Consolas,monospace;font-size:12px">${h(campPromptText())}</textarea>
      <div class="btnrow" style="margin-top:8px"><button class="btn primary" id="campCopyMain">📋 Kopjo prompt-in</button></div></div>
    <div class="card"><h3>Prompt FAZA 3 — numrat e ditës ${campDayPicker('campPDay')}</h3>
      <div class="hint" style="margin-bottom:6px">Dërgoje gjatë ditës (p.sh. çdo 2 orë): përmban raportet orare, të dhënat live nga WMS dhe planin e stafit.</div>
      <textarea id="campPromptDay" rows="16" style="font-family:ui-monospace,Consolas,monospace;font-size:12px">${h(campPromptDayText(date))}</textarea>
      <div class="btnrow" style="margin-top:8px"><button class="btn primary" id="campCopyDay">📋 Kopjo</button></div></div>`;
  campWireDayPicker('campPDay');
  $('#campCopyMain').onclick=()=>campCopy($('#campPromptMain').value);
  $('#campCopyDay').onclick=()=>campCopy($('#campPromptDay').value);
}
function campPromptText(){
  const c=campCfg(), days=campDays(), sh=c.shifts.map(s=>s.start+'–'+s.end).join(' / ');
  const L=(arr)=>arr&&arr.length?arr.map(x=>'- '+x).join('\n'):'- [plotëso te Cilësimet]';
  const tbl=['| Dita | Porosi gjithsej | Për depon | Ngarkesa | Outbound | Turni 1 / 2 | Inbound | Gjithsej |','|---|---:|---:|---:|---:|---|---:|---:|']
    .concat(days.map(d=>{ const k=campCalc(d.date); return `| ${campDayName(d.date)} ${fmtDateAl(d.date)} | ${campFmt(d.forecast)} | ${campFmt(k.wh)} | ${campFmt(k.workload)} | ${num(d.outbound)} | ${num(d.s1)} / ${num(d.s2)} | ${num(d.inbound)} | ${k.total} |`; })).join('\n');
  const tot=days.reduce((a,d)=>a+num(d.forecast),0), totWh=days.reduce((a,d)=>a+num(campCalc(d.date).wh),0);
  const over=days.filter(d=>campCalc(d.date).overCap).map(d=>campDayName(d.date).toLowerCase()+' ('+campFmt(campCalc(d.date).workload)+')');
  const highs=days.filter(d=>d.highTotal).map(d=>num(d.highTotal)).join(' / ');
  return `# PROMPT: PLANI OPERATIV I DEPOS — ${c.name.toUpperCase()}, ${fmtDateAl(c.start)}–${fmtDateAl(c.end)}

## 1. ROLI
Vepro si Warehouse Operations Manager me përvojë në e-commerce fulfillment gjatë fushatave me volum të lartë. Je asistenti operativ i WH Lead-it${c.warehouse?' në '+c.warehouse:''}. Më ndihmon të planifikoj, ekzekutoj, monitoroj dhe vlerësoj kampanjën nga ${fmtDateAl(c.start)} deri më ${fmtDateAl(c.end)}.${c.manager?' Unë raportoj te menaxheri im, '+c.manager+'.':''}
Sot është ${campDayName(campToday()).toLowerCase()}, ${fmtDateAl(campToday())} (${campPhase(campToday())}).
Të dhënat i mbaj te aplikacioni "Warehouse Observation & Diagnostic System" → seksioni Kampanja (Pasqyra live, Plani & stafi, Raporti orar, Raporti ditor, Alarmet, Checklist-at). Kur të dërgoj numra prej andej, përdor të njëjtat përkufizime dhe pragje.

## 2. KONTEKSTI (FAKTE NGA WMS)
Baseline:
${L(c.context.baseline)}

Kampanjat e kaluara:
${L(c.context.past)}
${c.context.lesson.length?'Mësimi:\n'+L(c.context.lesson):''}

Produktiviteti:
${L(c.context.productivity)}
- Norma e planifikimit: ${c.ordersPerHour} porosi/orë = ${num(c.ordersPerHour)*num(c.shiftHours)} porosi/person/turn ${c.shiftHours}h, +${c.reservePct}% rezervë.

Kapaciteti fizik, stafi dhe kurierët:
${L(c.context.capacity)}
- Turnet: ${sh}. Cut-off për dërgim të njëjtën ditë: ${c.cutoff}.
- Kurierët: ${c.couriers||'—'}. Marrjet: ${c.pickups||'—'}. Kapaciteti maksimal ~${campFmt(c.courierCap)} pako/ditë për kurier.

SKU-të e kampanjës:
${L(c.context.skus)}

Për t'u verifikuar:
${L(c.context.verify)}

## 3. PARASHIKIMI DHE STAFI (skenari bazë)
Rregull: ngarkesa e ditës = ½ e porosive të sotme + ½ e të djeshmeve (SUPOZIM, për t'u konfirmuar). Për depon: ${c.whSharePct}% e porosive.

${tbl}

- Gjithsej ~${campFmt(tot)} porosi (~${campFmt(totWh)} për depon). Skenari i lartë (+${c.highPct}%)${highs?' → stafi '+highs:''}.
- Aktivizimi i skenarit të lartë: kur porositë e hyra kalojnë parashikimin kumulativ me më shumë se ${c.triggerPct}% (ora e nisjes: ${c.launchTime}; rillogarite nëse ndryshon).
- Materiali paketues: ~${campFmt(c.packSets)} sete. Artikuj për porosi gjatë kampanjës: ${c.unitsPerOrder}.
- Kufiri fizik: ${c.tables} tavolina × ${c.ordersPerHour} porosi/orë × ${campOpsHours()} orë ≈ ${campFmt(num(c.tables)*num(c.ordersPerHour)*campOpsHours())} porosi/ditë.${over.length?' E kalojnë: '+over.join(', ')+'. Trajtoje si rrezikun kryesor të kapacitetit.':''}

## 4. OBJEKTIVAT (KPI) DHE PËRKUFIZIMET
1. 100% e porosive të ardhura para ${c.cutoff} i dorëzohen kurierit ose Showroom-it të njëjtën ditë.
2. Backlog në fund të ditës ≤ ${campFmt(c.kpi.backlogEnd)} porosi (vetëm porosi të ardhura pas ${c.cutoff}).
3. Saktësi picking/packing ≥ ${c.kpi.accuracy}%.
4. Koha mesatare nga claim deri te paketimi ≤ ${c.kpi.claimToPackMin} min.
5. Zero porosi "out of stock" pas konfirmimit për top SKU-të.
6. Zero incidente sigurie; zero orë të humbura për mungesë materiali paketues.
7. Backlog i pastruar plotësisht deri ${c.kpi.cleanupBy||'[afati]'} (vlerëso realizueshmërinë dhe propozo alternativë nëse nuk është realist).

Përkufizimet (përdori njëlloj në çdo raport):
- "E përfunduar" = e paketuar, e etiketuar dhe e vendosur në zonën e kurierit/Showroom-it.
- "E dërguar" = e dorëzuar fizikisht te kurieri ose në Showroom.
- Backlog në fund = Backlog në fillim + Porosi të reja − Porosi të përfunduara.
- Realizimi (%) = Rezultati real / Objektivi × 100.
- Ritmi i kërkuar = Porositë e mbetura / Orët deri në ${c.paceDeadline||c.cutoff}${c.paceDeadline&&c.paceDeadline!==c.cutoff?' (afati i ritmit, jo cut-off-i '+c.cutoff+': me ritmin deri në cut-off alarmi del Niveli 3 gjithë pasditen e ditës së nisjes)':''}.

## 5. RREGULLAT E PUNËS
1. Mos shpik të dhëna. Ndaj qartë FAKTIN, SUPOZIMIN dhe REKOMANDIMIN.
2. Kur mungon një numër, bëj supozim të arsyeshëm, shënoje "SUPOZIM" dhe vazhdo.
3. Kur gjen kontradiktë mes të dhënave, trego të dyja versionet dhe ndikimin e secilit.
4. Pyet vetëm për informacionin që e ndryshon realisht planin.
5. Siguria dhe saktësia janë mbi numrin e porosive.
6. Asnjë ndryshim në WMS ose procedura pa kontroll dhe miratim. Orët shtesë dhe ndryshimet e orarit shënohen "kërkon miratim".
7. Për çdo veprim: çka, kush (pronari), kur (afati), si verifikohet dhe çka bëhet nëse nuk realizohet.
8. Jep përparësi masave me ndikim të lartë dhe kosto të ulët.
9. Gabimet analizohen sipas shkakut rrënjësor (njerëzor, trajnim, procedurë, sistem, organizim), pa caktuar fajtor pa prova.

## 6. FUSHAT QË DUHET TË MBULOSH
1. Kapaciteti dhe stafi: verifiko llogaritjen, kufirin e ${c.tables} tavolinave dhe nevojën për picker-a të dedikuar ose tavolina shtesë; rolet, floater-i, pauzat, rezervat, ndalimi i pushimeve.
2. Fundjava: plan i veçantë bazuar në mësimin e kampanjave të kaluara.
3. Stoku dhe lokacionet: SKU-të kryesore afër tavolinave, rimbushje disa herë në ditë, zonë për artikujt e rëndë, ndarje fizike e SKU-ve që ngatërrohen, eskalimi i mungesave.
4. Inbound gjatë kampanjës pa i hequr njerëzit nga outbound-i.
5. Pajisjet dhe materialet: arkat fiskale, skanerët, printerët, rrjeti, stacionet e WMS-it; materiali paketues + rezervë; furnitor emergjent.
6. Kurierët dhe Showroom-i: shpërndarja e pakove, zona të ndara, plan nëse kurieri vonohet ose tejkalon kapacitetin.
7. Siguria: kalimet dhe daljet emergjente, ngritja e peshave, lodhja, ndihma e parë.
8. Monitorimi dhe alarmet: Niveli 2 kur ritmi real < ${c.alarmL2}% e të kërkuarit në dy kontrolle radhazi; Niveli 3 kur < ${c.alarmL3}% ose sistemi/pajisja kyçe bie mbi ${c.sysDownMin} min (PROPOZIM për t'u konfirmuar). Për çdo nivel: kush njoftohet, veprimi, afati, kushti për kthim.
9. Plane rezervë: mungesë stafi, volum mbi parashikim, rënie e WMS/skanerëve/printerëve/arkave, mospërputhje stoku, bllokim hapësire, vonesë kurieri.
10. Komunikimi dhe mbyllja: briefing, kontroll në mes të turnit, dorëzim mes turneve, raport ditor${c.manager?' për '+c.manager:''}, eskalim te Operations, Commercial/Marketing, Customer Support, IT dhe People and Culture; retrospektiva.

## 7. MËNYRA E PUNËS — NË FAZA
FAZA 1 (D-1): 10 veprimet më kritike; checklist D-1 me pronar, orë dhe kriter suksesi; verifikimi i kapacitetit dhe stafit për çdo ditë në dy variante të orës së nisjes; plani i turneve (dita, turni, rolet, numri, rezervat); teksti i briefing-ut 10-minutësh.
FAZA 2: matrica e alarmeve dhe planet rezervë; shabllonet e raportit orar, raportit ditor, kontrollit në mes të turnit dhe dorëzimit mes turneve.
FAZA 3 (gjatë kampanjës, sa herë të dërgoj numra nga app-i/WMS): niveli i alarmit (1/2/3), faza që krijon radhë, ritmi i kërkuar deri në cut-off dhe deri në 3 veprime të menjëhershme me pronar; në fund të ditës, raporti ditor dhe plani i stafit për nesër.
FAZA 4 (pas kampanjës): plani i pastrimit të backlog-ut; raporti përfundimtar (KPI kundrejt objektivave, krahasimi me kampanjat e kaluara, mësimet, plani i veprimit); agjenda e retrospektivës.

## 8. FORMATI
- Gjuha shqipe, profesionale dhe e qartë.
- Tabela për planet, KPI-të, alarmet dhe rreziqet. Checklist-e që mund të shënohen.
- Veprime konkrete dhe të zbatueshme menjëherë, pa teori të përgjithshme.`;
}
function campPromptDayText(date){
  const c=campCfg(), day=campDay(date)||{}, k=campCalc(date)||{}, ents=campEntries(date), w=campWms(date), rec=campDailyRec(date);
  const rows=ents.map(e=>{ const x=campEval(e,date); return `| ${e.time} | ${campFmt(e.ordersIn)} | ${campFmt(x.expected)} | ${campFmt(e.completed)} | ${campFmt(e.dispatched)} | ${campFmt(x.backlog)} | ${x.real!=null?Math.round(x.real):'—'} | ${x.required!=null?Math.round(x.required):'—'} | ${campFmt(e.errors)} | ${e.staff??'—'} | ${x.level} |`; });
  return `FAZA 3 — ${c.name}, ${campDayName(date)} ${fmtDateAl(date)} (${campPhase(date)})

Plani i ditës: ~${campFmt(day.forecast)} porosi (${campFmt(k.wh)} për depon), ngarkesa ${campFmt(k.workload)}. Stafi: outbound ${num(day.outbound)} (${num(day.s1)} / ${num(day.s2)}), inbound ${num(day.inbound)}, gjithsej ${k.total||'—'}. Cut-off ${c.cutoff}. Backlog në fillim: ${campFmt(campBacklogStart(date))}.

Raportet orare (kumulative):
| Ora | Të hyra | Pritej | Përfunduar | Dërguar | Backlog | Ritmi real/h | I kërkuar/h | Gabime | Staf | Alarmi |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')||'| — |'}

Live nga WMS: ${campFmt(w.prepared)} porosi të përgatitura (${w.operators} operatorë), ${campFmt(w.checkedOut)} produkte check-out, ${campFmt(w.checkedIn)} produkte check-in${w.snap?`, orders in processing ${campFmt(w.snap.ordersInProcessing)} (në ${fmtTime(w.snap.at)})`:''}.
${rec&&rec.summary?'Shënim: '+rec.summary:''}
${ents.filter(e=>e.note).map(e=>'- '+e.time+': '+e.note).join('\n')}

Jep: nivelin e alarmit (1/2/3), fazën që po krijon radhë, ritmin e kërkuar deri në ${c.paceDeadline||c.cutoff}, a duhet aktivizuar skenari i lartë (pragu +${c.triggerPct}% mbi parashikimin kumulativ) dhe deri në 3 veprime të menjëhershme me pronar e afat. Ndaj FAKTIN, SUPOZIMIN dhe REKOMANDIMIN.`;
}

/* ---- Cilësimet ---- */
function campSettings(box){
  const c=campCfg();
  const f=(name,label,type,val,hint)=>`<div class="field"><label>${h(label)}</label><input type="${type}" data-cs="${name}" value="${h(val==null?'':val)}" ${type==='number'?'step="any"':''}>${hint?`<div class="hint">${hint}</div>`:''}</div>`;
  const ta=(name,label,arr)=>`<div class="field"><label>${h(label)} <span class="faint">(një rresht = një pikë)</span></label><textarea data-cx="${name}" rows="4">${h((arr||[]).join('\n'))}</textarea></div>`;
  box.innerHTML=`<div class="grid g-2">
    <div class="card"><h3>Kampanja</h3>
      ${f('name','Emri','text',c.name)}<div class="row2">${f('start','Fillimi','date',c.start)}${f('end','Mbarimi','date',c.end)}</div>
      <div class="row2">${f('manager','Menaxheri (raportet)','text',c.manager)}${f('warehouse','Depoja','text',c.warehouse)}</div>
      <div class="row3">${f('launchTime','Ora e nisjes','time',c.launchTime)}${f('cutoff','Cut-off','time',c.cutoff)}${f('paceDeadline','Afati i ritmit','time',c.paceDeadline,'bosh = cut-off')}</div><div class="row2">${f('preDayOrders','Porosi dita para','number',c.preDayOrders,'për ngarkesën e ditës 1')}</div>
      <div class="row2">${f('shift1','Turni 1 (HH:MM-HH:MM)','text',(c.shifts[0]||{}).start+'-'+(c.shifts[0]||{}).end)}${f('shift2','Turni 2 (HH:MM-HH:MM)','text',(c.shifts[1]||{}).start+'-'+(c.shifts[1]||{}).end)}</div></div>
    <div class="card"><h3>Kapaciteti dhe normat</h3>
      <div class="row3">${f('tables','Tavolina check-out','number',c.tables)}${f('ordersPerHour','Porosi/orë/person','number',c.ordersPerHour)}${f('shiftHours','Orë/turn','number',c.shiftHours)}</div>
      <div class="row3">${f('reservePct','Rezerva %','number',c.reservePct)}${f('whSharePct','% për depon','number',c.whSharePct)}${f('unitsPerOrder','Artikuj/porosi','number',c.unitsPerOrder)}</div>
      <div class="row3">${f('highPct','Skenari i lartë +%','number',c.highPct)}${f('triggerPct','Pragu i aktivizimit +%','number',c.triggerPct,'mbi parashikimin kumulativ')}${f('packSets','Sete paketimi','number',c.packSets)}</div>
      <div class="row3">${f('couriers','Kurierët','text',c.couriers)}${f('pickups','Marrjet','text',c.pickups)}${f('courierCap','Pako/ditë/kurier','number',c.courierCap)}</div></div>
    <div class="card"><h3>KPI dhe alarmet</h3>
      <div class="row2">${f('kpi.backlogEnd','Backlog max në fund','number',c.kpi.backlogEnd)}${f('kpi.accuracy','Saktësia min %','number',c.kpi.accuracy)}</div>
      <div class="row2">${f('kpi.claimToPackMin','Claim → paketim (min)','number',c.kpi.claimToPackMin)}${f('kpi.cleanupBy','Backlog i pastruar deri','text',c.kpi.cleanupBy)}</div>
      <div class="row3">${f('alarmL2','Niveli 2: ritmi < %','number',c.alarmL2)}${f('alarmL3','Niveli 3: ritmi < %','number',c.alarmL3)}${f('sysDownMin','Niveli 3: sistemi jashtë (min)','number',c.sysDownMin)}</div></div>
    <div class="card"><h3>Plani lokal <span class="sub">vetëm në këtë kompjuter</span></h3>
      <div class="btnrow"><button class="btn" id="campLoadLocal">⬇ Ringarko campaign.local.json</button>
        <label class="btn">📂 Importo JSON<input type="file" id="campFile" accept="application/json" style="display:none"></label>
        <button class="btn" id="campExport">⬆ Eksporto planin (JSON)</button></div>
      <div class="hint" style="margin-top:8px">Ringarkimi zëvendëson planin (ditët, normat, kontekstin) por ruan raportet orare/ditore dhe checklist-at. Skedari <b>campaign.local.json</b> është në .gitignore.</div>
      <div class="hint" style="margin-top:6px">Kurbat e porosive sipas orës: ${c.curveLaunch.length===24?'dita e nisjes ✓':'dita e nisjes —'} · ${c.curveNormal.length===24?'ditë normale ✓':'ditë normale — (përdoret kurbë e sheshtë 07–23)'}</div></div>
  </div>
  <div class="card" style="margin-top:14px"><h3>Konteksti për prompt-in dhe planin</h3><div class="grid g-2">
    ${ta('baseline','Baseline',c.context.baseline)}${ta('past','Kampanjat e kaluara',c.context.past)}
    ${ta('lesson','Mësimi kryesor',c.context.lesson)}${ta('productivity','Produktiviteti',c.context.productivity)}
    ${ta('capacity','Kapaciteti fizik, stafi, kurierët',c.context.capacity)}${ta('skus','SKU-të e kampanjës',c.context.skus)}
    ${ta('verify','Për t\'u verifikuar',c.context.verify)}</div></div>
  <div class="btnrow" style="margin-top:12px"><button class="btn primary" id="campSave">💾 Ruaj cilësimet</button></div>`;
  $('#campLoadLocal').onclick=campLoadLocal;
  $('#campFile').onchange=campImportFile;
  $('#campExport').onclick=()=>downloadFile('campaign-plan-'+campToday()+'.json', JSON.stringify(Object.assign({},campCfg(),{checks:undefined}),null,2),'application/json');
  $('#campSave').onclick=()=>{
    $$('#campBody [data-cs]').forEach(el=>{ const k=el.dataset.cs, v=el.type==='number'?(el.value===''?null:num(el.value)):el.value.trim();
      if(k==='shift1'||k==='shift2'){ const p=v.split('-').map(s=>s.trim()); const i=k==='shift1'?0:1; c.shifts[i]=Object.assign({name:'Turni '+(i+1)},c.shifts[i]||{},{start:p[0]||'',end:p[1]||''}); return; }
      if(k.startsWith('kpi.')) c.kpi[k.slice(4)]=v; else c[k]=v; });
    $$('#campBody [data-cx]').forEach(el=>{ c.context[el.dataset.cx]=el.value.split('\n').map(s=>s.trim()).filter(Boolean); });
    Store.persist(); toast('Cilësimet u ruajtën'); renderCampaign($('#view'));
  };
}

/* ---- Excel ---- */
function campExportExcel(){
  const c=campCfg(), days=campDays();
  const sheets=[{name:'Plani', rows:[['Data','Dita','Porosi (parash.)','Për depon','Ngarkesa','Outbound plan','Outbound llogaritur','Turni 1','Turni 2','Inbound','Gjithsej','Skenari i lartë','Kalon tavolinat'],
    ...days.map(d=>{ const k=campCalc(d.date); return [d.date,campDayName(d.date),num(d.forecast),num(k.wh),num(k.workload),num(d.outbound),num(k.outboundCalc),num(d.s1),num(d.s2),num(d.inbound),k.total,num(d.highTotal),k.overCap?'PO':'JO']; })]}];
  sheets.push({name:'Raporti orar', rows:[['Data','Ora','Të hyra','Pritej','Pikuar','Përfunduar','Dërguar','Backlog','Ritmi real/h','I kërkuar/h','Ritmi %','Gabime','Staf','Alarmi','Burimi','Shënim'],
    ...Store.col('campHourly').slice().sort((a,b)=>(a.date+a.time)<(b.date+b.time)?-1:1).map(e=>{ const x=campEval(e,e.date);
      return [e.date,e.time,num(e.ordersIn),Math.round(num(x.expected)),num(e.picked),num(e.completed),num(e.dispatched),Math.round(num(x.backlog)),x.real!=null?Math.round(x.real):'',x.required!=null?Math.round(x.required):'',x.ratio!=null?Math.round(x.ratio):'',num(e.errors),e.staff??'',x.level,e.source||'',e.note||'']; })]});
  sheets.push({name:'Raporti ditor', rows:[['Data','Backlog fillim','Të hyra','Përfunduar','Dërguar','Backlog fund','Staf real','Gabime','Shkaku','Siguria','Pajisjet','Përmbledhje','Prioriteti 1','Prioriteti 2','Prioriteti 3','Vendime'],
    ...Store.col('campDaily').slice().sort((a,b)=>a.date<b.date?-1:1).map(r=>[r.date,campBacklogStart(r.date)??'',num(r.ordersIn),num(r.completed),num(r.dispatched),num(r.backlogEnd),num(r.staffActual),num(r.errors),r.rootCause||'',r.safety||'',r.equipment||'',r.summary||'',r.prio1||'',r.prio2||'',r.prio3||'',r.decisions||''])]});
  const xml=wmsExcelXml(sheets);
  downloadFile('Kampanja-'+(c.start||campToday())+'.xls','﻿'+xml,'application/vnd.ms-excel');
  toast('U eksportua në Excel');
}

/* refresh the live view every 2 min while it is open (no modal, live tab) so the WMS cards follow the agent sync */
setInterval(()=>{ try{ if((location.hash||'')==='#campaign' && campTab==='live' && !document.querySelector('#modalRoot .modal')) renderCampaign(document.querySelector('#view')); }catch(e){} }, 120000);
