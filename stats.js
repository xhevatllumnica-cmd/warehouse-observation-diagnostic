/* ============================================================================
   "Statistikat e WH" — warehouse statistics module (phase 1).
   WMS figures come from the agent (GET /stats/live, defined in wms-stats.js); App figures are computed here
   from the observation data the app already stores (measurements, observations, problems). Every block shows
   its definition, source (WMS / App / Kombinuar), period and refresh time. Loaded before app.js (ROUTES
   references renderStatsWH); it only uses app.js helpers at call time.
   ==========================================================================*/
'use strict';
let statsRange='7d', statsShift='', statsLast=null, statsDate='';
const STATS_WEEKDAYS=['Hën','Mar','Mër','Enj','Pre','Sht','Die'];

function statsStatus(v, th){
  if(v==null || !th) return 'st-na';
  if(th.higherIsBetter) return v>=th.green?'st-ok':v>=th.yellow?'st-warn':'st-crit';
  return v<=th.green?'st-ok':v<=th.yellow?'st-warn':'st-crit';
}
function statsFmtMin(m){ if(m==null) return '—'; if(m<60) return Math.round(m)+' min'; const hrs=m/60; return hrs<48? (Math.round(hrs*10)/10)+' orë' : (Math.round(hrs/24*10)/10)+' ditë'; }
function statsFmtSec(s){ if(s==null) return '—'; return s<90? Math.round(s)+' s' : (Math.round(s/6)/10)+' min'; }
function statsMedian(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y), m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function statsP90(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.floor(0.9*s.length))]; }
function statsCsv(name, header, rows){
  const esc=v=>{ const s=String(v==null?'':v); return /[",;\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  downloadFile(name+'-'+todayStr()+'.csv', '﻿'+[header,...rows].map(r=>r.map(esc).join(',')).join('\n'), 'text/csv;charset=utf-8');
}
function statsMeta(def, src, scope, refreshed){
  return `<div class="hint" style="margin-top:8px"><b>Definicioni:</b> ${def} · <b>Burimi:</b> ${src} · <b>Scope:</b> ${scope}${refreshed?' · <b>Freskuar:</b> '+h(new Date(refreshed).toLocaleString()):''}</div>`;
}
/* shift membership for app records (date + HH:MM), same rule as the agent: inside the shift's hours on its kind of day */
function statsShiftsFor(date, time){
  if(!date || !time) return [];
  const g=new Date(date+'T12:00:00').getDay(), weekend=(g===0||g===6), m=wmsTimeToMin(time);
  return Store.col('wmsShifts').filter(s=>s.active!==false && !!s.weekend===weekend).filter(s=>{ const a=wmsTimeToMin(s.start), b=wmsTimeToMin(s.end); return b>=a?(m>=a&&m<b):(m>=a||m<b); }).map(s=>s.name);
}

function renderStatsWH(v){
  const shifts=Store.col('wmsShifts').filter(s=>s.active!==false);
  v.innerHTML = pagehead('Statistikat e WH','Statistikat e depos kundrejt targeteve: vëllimi dhe throughput-i, pritja për mapim, produktiviteti dhe vëzhgimet nga terreni. Burimet: WMS (log-u i eventeve) dhe të dhënat e vëzhgimeve të këtij aplikacioni.',
      `<button class="btn no-print" id="statsPrint" title="Hap dritaren e printimit — zgjidh «Save as PDF»">🖨 Printo / PDF</button>`)
    + `<div class="card no-print" style="margin-bottom:14px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <label class="small">Periudha <select id="statsRange">${[['7d','7 ditët e fundit'],['14d','14 ditët e fundit'],['30d','30 ditët e fundit'],['day','Një ditë e caktuar…']].map(o=>`<option value="${o[0]}" ${statsRange===o[0]?'selected':''}>${o[1]}</option>`).join('')}</select></label>
        <label class="small" id="statsDateWrap" style="${statsRange==='day'?'':'display:none'}">Data <input type="date" id="statsDate" value="${h(statsDate||todayStr())}" max="${h(todayStr())}"></label>
        <label class="small">Depoja <select disabled title="Të dhënat live të agjentit janë të depos Prishtinë (verifikuar me SQL)"><option>1 · Prishtinë</option></select></label>
        <label class="small">Platforma <select disabled title="Log-u web i WMS-it s'e tregon platformën — filtri vjen në Fazën 2 me SQL"><option>Të dyja</option></select></label>
        <label class="small">Turni <select id="statsShift"><option value="">Të gjitha</option>${shifts.map(s=>`<option value="${h(s.name)}" ${statsShift===s.name?'selected':''}>${h(s.name)} ${h(s.start)}–${h(s.end)}${s.weekend?' (weekend)':''}</option>`).join('')}</select></label>
        <button class="btn sm" id="statsRefresh">↻ Rifresko</button>
      </div></div>
      <div id="statsBody"><div class="empty">Po ngarkohet…</div></div>`;
  $('#statsRange').onchange=e=>{ statsRange=e.target.value; $('#statsDateWrap').style.display=statsRange==='day'?'':'none'; if(statsRange==='day' && !statsDate) statsDate=todayStr(); loadStatsWH(); };
  $('#statsDate').onchange=e=>{ statsDate=e.target.value||todayStr(); loadStatsWH(); };
  $('#statsShift').onchange=e=>{ statsShift=e.target.value; loadStatsWH(); };
  $('#statsRefresh').onclick=()=>loadStatsWH();
  $('#statsPrint').onclick=()=>window.print();
  loadStatsWH();
}
async function loadStatsWH(){
  const body=$('#statsBody'); if(!body) return;
  body.innerHTML=`<div class="empty">Po ngarkohet… ${statsRange==='14d'||statsRange==='30d'?'(herën e parë periudhat e gjata marrin disa minuta; pastaj ruhen)':''}</div>`;
  let live=null, err=null;
  const q=statsRange==='day' ? 'date='+encodeURIComponent(statsDate||todayStr()) : 'range='+statsRange;
  if(!wmsOnAgent()) err='Hape app-in nga http://localhost:8790 që të lexohen të dhënat e WMS-it.';
  else try{ const r=await fetch('/stats/live?'+q+'&shift='+encodeURIComponent(statsShift),{cache:'no-store'}); live=await r.json();
    if(!r.ok||live.error){ err=live.error==='auth_expired'?'Sesioni i WMS ka skaduar — ngjit cookie-n e re te WMS Data & Performance.':(live.error||('HTTP '+r.status)); live=null; } }
  catch(e){ err='Agjenti s\'përgjigjet ('+e.message+').'; }
  if(live) statsLast=live;
  const shown=live||statsLast;
  body.innerHTML = (err?`<div class="hint" style="color:var(--warn);margin-bottom:10px">⚠ ${h(err)}${shown&&!live?' — po shfaqen të dhënat e fundit të ruajtura ('+h(new Date(shown.refreshedAt).toLocaleString())+').':''}</div>`:'')
    + renderStatsBody(shown);
  wireStatsBody(shown);
}

function statsAppData(from, to){
  const inP=d=>d && d>=from && d<=to;
  const procName=id=>{ const p=Store.get('processes',id); return p?p.name:'(pa proces)'; };
  const ms=Store.col('measurements').filter(m=>inP(m.date) && (!statsShift || statsShiftsFor(m.date,m.time).includes(statsShift)));
  const byProc={}; ms.forEach(m=>{ const k=procName(m.processId); (byProc[k]=byProc[k]||{tot:[],wait:[]}); if(num(m.totalSec)>0) byProc[k].tot.push(num(m.totalSec)); if(m.waitingSec!=null && m.waitingSec!=='') byProc[k].wait.push(num(m.waitingSec)); });
  const steps=Object.entries(byProc).map(([p,o])=>({process:p, n:o.tot.length, median:statsMedian(o.tot), p90:statsP90(o.tot), waitMedian:statsMedian(o.wait)})).filter(x=>x.n).sort((a,b)=>b.n-a.n);
  const obs=Store.col('observations').filter(o=>!o.auto && inP(o.date) && (!statsShift || statsShiftsFor(o.date,o.time).includes(statsShift)));
  const BOTTLENECK_TYPES=['Bottleneck','Delay / Waiting'];
  const bn=obs.filter(o=>BOTTLENECK_TYPES.includes(o.type));
  const group=(list,f)=>{ const m={}; list.forEach(o=>{ const ks=[].concat(f(o)); (ks.length?ks:['(pa të dhëna)']).forEach(k=>m[k]=(m[k]||0)+1); }); return Object.entries(m).sort((a,b)=>b[1]-a[1]); };
  const problems=Store.col('problems').filter(p=>inP(p.dateIdentified));
  return { steps, measurements:ms.length, bottlenecks:bn.length, observations:obs.length,
    bnByProcess:group(bn,o=>procName(o.processId)), bnByLocation:group(bn,o=>o.location||'(pa zonë)'), bnByShift:group(bn,o=>statsShiftsFor(o.date,o.time)),
    problems:problems.length, safety:obs.filter(o=>o.type==='Safety issue'||o.type==='Safety').length };
}

function renderStatsBody(d){
  if(!d) return `<div class="empty">S'ka të dhëna të WMS-it për t'u shfaqur.</div>`;
  const sc=d.scope, cfg=d.config||{}, th=cfg.thresholds||{}, t=d.throughput, pa=d.putaway, pr=d.productivity;
  const single=sc.days===1, period=single? h(fmtDateAl(sc.from)) : `${h(fmtDateAl(sc.from))} → ${h(fmtDateAl(sc.to))}`;
  const scope=`${h(sc.warehouse)} · ${h(sc.platform)} · ${period} · turni: ${h(sc.shift)}`;
  const app=statsAppData(sc.from, sc.to);
  const kpi=(val,lbl,foot,st,src)=>`<div class="card kpi ${st}"><div class="val">${val}</div><div class="lbl">${lbl}</div><div class="foot">${foot}${src?' · <b>'+src+'</b>':''}</div></div>`;
  const prevLbl=single?'ditës së mëparshme':'periudhës së kaluar';
  const diff=(a,b)=> (a==null||b==null||!b)?'':` (${a>=b?'+':''}${Math.round((a-b)/b*100)}% kundrejt ${prevLbl})`;
  const partialDay=single && t.byDay[0] && t.byDay[0].partial;
  const over24=pa.unmappedBuckets['>24h'];
  const cards=`<div class="grid g-kpi" style="margin-bottom:14px">
    ${single
      ? kpi(t.avgOrdersPerWorkday!=null?t.avgOrdersPerWorkday:'—', 'Porosi të dala këtë ditë', `target ${cfg.targetOrdersPerDay}${partialDay?' · dita ende në vazhdim':''}${diff(t.avgOrdersPerWorkday,t.prevAvgOrdersPerWorkday)}`, partialDay?'st-na':statsStatus(t.avgOrdersPerWorkday, th.ordersPerDay), 'WMS')
      : kpi(t.avgOrdersPerWorkday!=null?t.avgOrdersPerWorkday:'—','Porosi të dala / ditë pune', `target ${cfg.targetOrdersPerDay} · mesatare e ${t.workdaysCounted} ditëve të plota${diff(t.avgOrdersPerWorkday,t.prevAvgOrdersPerWorkday)}`, statsStatus(t.avgOrdersPerWorkday, th.ordersPerDay), 'WMS')}
    ${kpi('—','Same-day shipping', `porosi para cut-off ${h(cfg.cutoff)} të dala po atë ditë · target 100% · vjen në Fazën 2 (SQL)`, 'st-na', 'WMS')}
    ${kpi('—','Carryover', `porosi të ditës pa check-out deri në fund të ditës · target 0 · vjen në Fazën 2 (SQL)`, 'st-na', 'WMS')}
    ${kpi(statsFmtMin(pa.medianMin),'Pritja check-in → map (mediana)', `p90 ${statsFmtMin(pa.p90Min)} · ${single?'dita e mëparshme':'periudha e kaluar'} ${statsFmtMin(pa.prevMedianMin)}`, statsStatus(pa.medianMin, th.putawayMedianMin), 'WMS')}
    ${kpi(over24,'Njësi të pamapuara > 24 orë', `gjithsej ${pa.unmapped} të pamapuara nga check-in-et e periudhës`, statsStatus(over24, th.unmappedOver24h), 'WMS')}
    ${kpi(app.safety,'Vëzhgime sigurie', 'target 0 · regjistruar në Daily Observation', statsStatus(app.safety, th.safetyObs), 'App')}
  </div>`;
  const maxO=Math.max(1,...t.byDay.map(x=>x.orders));
  const daily=`<div class="card" style="margin-bottom:14px"><div style="display:flex;align-items:center"><h3 style="margin:0">5.1 Vëllimi — porosi dhe njësi të dala për ditë</h3><button class="btn sm ghost no-print" data-csv="daily" style="margin-left:auto">⬇ CSV</button></div>
    ${t.byDay.map(x=>barRow(`${fmtDateAl(x.date)} ${STATS_WEEKDAYS[(new Date(x.date+'T12:00:00').getDay()+6)%7]}${x.partial?' (sot, e pjesshme)':''}`, x.orders, Math.max(maxO,cfg.targetOrdersPerDay||0), x.weekend?'var(--faint)':'var(--accent)', `${x.orders} porosi · ${x.units} njësi`)).join('')}
    ${statsMeta('porosi të ndryshme me check-out (LogTypeId 4/18) në ditë; njësi = skanime check-out. Shiriti është në shkallë kundrejt targetit '+(cfg.targetOrdersPerDay||'')+'.','WMS · ProductLogs', scope, d.refreshedAt)}</div>`;
  const maxH=Math.max(1,...t.byHour.map(x=>x.ordersPerDay));
  const hourly=`<div class="card" style="margin-bottom:14px"><div style="display:flex;align-items:center"><h3 style="margin:0">5.1 Throughput sipas orës</h3><button class="btn sm ghost no-print" data-csv="hourly" style="margin-left:auto">⬇ CSV</button></div>
    ${t.byHour.map(x=>barRow(String(x.hour).padStart(2,'0')+':00', x.ordersPerDay, maxH, 'var(--ok)', `${x.ordersPerDay} porosi/ditë · ${x.unitsPerDay} njësi/ditë`)).join('')||'<div class="empty">—</div>'}
    ${statsMeta('mesatarja për ditë e porosive të dala (sipas orës së check-out-it të parë) dhe e njësive, për çdo orë.','WMS · ProductLogs', scope, d.refreshedAt)}</div>`;
  const hmax=Math.max(1,...t.heatmap.flat()), hrs=[...Array(24).keys()].filter(hh=>t.heatmap.some(r=>r[hh]));
  const heat=`<div class="card" style="margin-bottom:14px"><div style="display:flex;align-items:center"><h3 style="margin:0">5.1 Heatmap — ora × dita e javës</h3><button class="btn sm ghost no-print" data-csv="heatmap" style="margin-left:auto">⬇ CSV</button></div>
    <div style="overflow-x:auto"><table class="heat"><thead><tr><th></th>${hrs.map(hh=>`<th>${String(hh).padStart(2,'0')}</th>`).join('')}</tr></thead><tbody>
    ${t.heatmap.map((r,i)=>`<tr><th>${STATS_WEEKDAYS[i]}</th>${hrs.map(hh=>`<td style="background:rgba(61,155,255,${(r[hh]/hmax*0.85).toFixed(2)})">${r[hh]||''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${statsMeta('porosi të dala gjithsej në periudhë, sipas orës së check-out-it të parë dhe ditës së javës.','WMS · ProductLogs', scope, d.refreshedAt)}</div>`;
  const putaway=`<div class="card" style="margin-bottom:14px"><div style="display:flex;align-items:center"><h3 style="margin:0">5.3 Check-in → map</h3><button class="btn sm ghost no-print" data-csv="putaway" style="margin-left:auto">⬇ CSV</button></div>
    <table style="font-size:12.5px;max-width:560px"><tbody>
      <tr><td>Njësi të check-in-uara dhe të mapuara</td><td><b>${pa.pairs}</b></td></tr>
      <tr><td>Pritja — mediana / p90</td><td><b>${statsFmtMin(pa.medianMin)}</b> / ${statsFmtMin(pa.p90Min)}</td></tr>
      <tr><td>Mediana e periudhës së kaluar</td><td>${statsFmtMin(pa.prevMedianMin)}</td></tr>
      <tr><td>Ende të pamapuara (pa dalë në porosi)</td><td><b>${pa.unmapped}</b> — ${Object.entries(pa.unmappedBuckets).map(([k,v])=>h(k)+': '+v).join(' · ')}</td></tr>
    </tbody></table>
    ${statsMeta('koha nga check-in-i (LogTypeId 2) deri te mapimi i parë (7) i së njëjtës njësi fizike. «Të pamapuara» = njësi të check-in-uara në periudhë që s\'kanë as mapim, as hap dalës (3, 4, 9, 18, 27); mosha matet deri tani.','WMS · ProductLogs', scope, d.refreshedAt)}</div>`;
  const band={above:['b-ok','Mbi mesataren'],below:['b-crit','Nën mesataren'],average:['b-muted','Mesatare']};
  const prod=`<div class="card" style="margin-bottom:14px"><div style="display:flex;align-items:center"><h3 style="margin:0">5.4 Produktiviteti i punëtorëve</h3><button class="btn sm ghost no-print" data-csv="workers" style="margin-left:auto">⬇ CSV</button></div>
    <div style="overflow-x:auto"><table style="font-size:12.5px"><thead><tr><th>Operatori</th><th>Check-in</th><th>Map</th><th>Check-out</th><th>Ditë aktive</th><th>Op. të peshuara</th><th>Op./ditë</th><th>${single?'Dita e mëparshme':'Periudha e kaluar'}</th><th>Kategoria</th><th>Sinjale</th></tr></thead><tbody>
    ${pr.workers.map(w=>`<tr><td>${h(w.operator)}</td><td>${w.checkin}</td><td>${w.map}</td><td>${w.checkout}</td><td>${w.activeDays}</td><td>${w.weighted}</td><td><b>${w.perDay}</b></td>
      <td>${w.prevPerDay!=null?w.prevPerDay+(w.changePct!=null?` <span class="faint">(${w.changePct>=0?'+':''}${w.changePct}%)</span>`:''):'—'}</td>
      <td><span class="badge ${band[w.band][0]}">${band[w.band][1]}</span></td><td>${w.spike?'<span class="badge b-warn">Kulm</span> ':''}${w.declining?'<span class="badge b-crit">Në rënie</span>':''}</td></tr>`).join('')}
    </tbody></table></div>
    <div style="margin-top:12px"><b class="small">Sipas orës së ditës</b> <span class="faint small">(operacione të peshuara të ekipit për ditë)</span>
    ${(()=>{ const mx=Math.max(1,...pr.byHour.map(x=>x.weightedPerDay)); return pr.byHour.map(x=>barRow(String(x.hour).padStart(2,'0')+':00', x.weightedPerDay, mx, 'var(--imp)')).join(''); })()}</div>
    ${statsMeta(`1.0 × check-out (4/18) + 0.8 × check-in (2) + 0.6 × map (7), për ditë aktive; mesatarja e ekipit ${pr.teamAvgPerDay}. Mbi/nën = ±25% nga mesatarja; kulm = > mesatarja + 2 SD (SD ${pr.sdPerDay}); në rënie = −15% ose më shumë kundrejt periudhës së kaluar. Vetëm stafi i depos; skanimet nuk mbulojnë paketimin dhe punët e tjera.`,'WMS · ProductLogs', scope, d.refreshedAt)}</div>`;
  const tbl=(rows,c1)=>rows.length?`<table style="font-size:12.5px"><tbody>${rows.map(([k,vv])=>`<tr><td>${h(k)}</td><td><b>${vv}</b></td></tr>`).join('')}</tbody></table>`:'<div class="empty" style="font-size:12px">—</div>';
  const appScope=`${period} · turni: ${h(statsShift||'Të gjitha')}`;
  const appBlock=`<div class="card" style="margin-bottom:14px"><div style="display:flex;align-items:center"><h3 style="margin:0">5.10 Nga vëzhgimet</h3><button class="btn sm ghost no-print" data-csv="steps" style="margin-left:auto">⬇ CSV</button></div>
    <b class="small">Kohët e matura për hap</b> <span class="faint small">(${app.measurements} matje)</span>
    ${app.steps.length?`<table style="font-size:12.5px"><thead><tr><th>Hapi</th><th>Matje</th><th>Mediana</th><th>p90</th><th>Pritja (mediana)</th></tr></thead><tbody>${app.steps.map(s=>`<tr><td>${h(s.process)}</td><td>${s.n}</td><td>${statsFmtSec(s.median)}</td><td>${statsFmtSec(s.p90)}</td><td>${statsFmtSec(s.waitMedian)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty" style="font-size:12px">S\'ka matje në këtë periudhë.</div>'}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:12px">
      <div><b class="small">Bottleneck-e sipas hapit</b>${tbl(app.bnByProcess)}</div>
      <div><b class="small">Sipas zonës</b>${tbl(app.bnByLocation)}</div>
      <div><b class="small">Sipas turnit</b>${tbl(app.bnByShift)}</div>
    </div>
    <div class="small" style="margin-top:10px">Vëzhgime gjithsej: <b>${app.observations}</b> · bottleneck/vonesa: <b>${app.bottlenecks}</b> · probleme të reja në regjistër: <b>${app.problems}</b> · siguria: <b>${app.safety}</b></div>
    <div class="hint" style="margin-top:6px">Prezenca dhe vonesat e stafit <b>nuk regjistrohen</b> në aplikacion, prandaj s'ka statistikë për to. Near-miss s'ka fushë të veçantë: numërohen vëzhgimet e llojit «Safety issue».</div>
    ${statsMeta('matjet nga Process Measurement (koha totale dhe pritja për hap); bottleneck = vëzhgime manuale të llojit «Bottleneck» ose «Delay / Waiting» (pa ato të gjeneruara automatikisht nga WMS); turni nxirret nga ora e vëzhgimit (N1 dhe N2 mbivendosen 13:00–15:00).','App', appScope)}</div>`;
  const pending=`<div class="card" style="margin-bottom:14px"><h3>Në Fazën 2 (kërkojnë SQL-in e WMS-it)</h3>
    <div class="small">Same-day shipping (cut-off ${h(cfg.cutoff)}) · carryover ditor · backlog sipas statusit dhe moshës · porosi → check-out (mediana/p90) · porosi të krijuara sipas orës dhe platformës · PickSession · kostoja për porosi · inbound (Supplies) · saktësia e stokut (Inspects, StockDifferences) · stacionet · dërgesat në kohë · filtri i platformës.</div></div>`;
  const settings=`<details class="card no-print" style="margin-bottom:14px"><summary style="cursor:pointer"><b>Cilësimet e modulit</b> <span class="faint small">· cut-off, targeti, pragjet e KPI-ve</span></summary>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:10px">
      <label class="small">Cut-off same-day<input id="stCut" value="${h(cfg.cutoff)}"></label>
      <label class="small">Target porosi/ditë<input id="stTarget" type="number" value="${h(cfg.targetOrdersPerDay)}"></label>
      ${[['ordersPerDay','Porosi/ditë (jeshile ≥ / e verdhë ≥)'],['putawayMedianMin','Pritja për map, min (jeshile ≤ / e verdhë ≤)'],['unmappedOver24h','Të pamapuara > 24h (jeshile ≤ / e verdhë ≤)'],['safetyObs','Vëzhgime sigurie (jeshile ≤ / e verdhë ≤)']].map(([k,l])=>`<label class="small">${l}<div style="display:flex;gap:6px"><input data-thg="${k}" type="number" value="${h(th[k]&&th[k].green)}"><input data-thy="${k}" type="number" value="${h(th[k]&&th[k].yellow)}"></div></label>`).join('')}
    </div>
    <button class="btn primary sm" id="stSave" style="margin-top:8px">Ruaj</button> <span class="hint" id="stMsg"></span>
    <div class="hint" style="margin-top:6px">Turnet ndryshohen te WMS Data &amp; Performance → Shifts. Pragjet janë vlera fillestare — përshtati sipas depos.</div></details>`;
  const warn=d.reliable===false?`<div class="hint" style="color:var(--warn);margin-bottom:10px">⚠ Disa ditë nuk u lexuan të plota nga WMS — shifrat mund të jenë pak më të ulëta.</div>`:'';
  return warn + cards + daily + hourly + heat + putaway + prod + appBlock + pending + settings;
}

function wireStatsBody(d){
  if(!d) return;
  const t=d.throughput, pa=d.putaway, pr=d.productivity, app=statsAppData(d.scope.from, d.scope.to);
  const csv={
    daily:()=>statsCsv('wh-porosi-ditore',['Data','Porosi të dala','Njësi','Weekend','E pjesshme'], t.byDay.map(x=>[x.date,x.orders,x.units,x.weekend?'po':'jo',x.partial?'po':'jo'])),
    hourly:()=>statsCsv('wh-throughput-ora',['Ora','Porosi/ditë','Njësi/ditë'], t.byHour.map(x=>[String(x.hour).padStart(2,'0')+':00',x.ordersPerDay,x.unitsPerDay])),
    heatmap:()=>statsCsv('wh-heatmap',['Dita',...[...Array(24).keys()].map(x=>String(x).padStart(2,'0'))], t.heatmap.map((r,i)=>[STATS_WEEKDAYS[i],...r])),
    putaway:()=>statsCsv('wh-checkin-map',['Metrika','Vlera'], [['Njësi të mapuara',pa.pairs],['Mediana (min)',pa.medianMin],['p90 (min)',pa.p90Min],['Mediana periudha e kaluar (min)',pa.prevMedianMin],['Të pamapuara',pa.unmapped],...Object.entries(pa.unmappedBuckets).map(([k,v])=>['Të pamapuara '+k,v])]),
    workers:()=>statsCsv('wh-produktiviteti',['Operatori','Check-in','Map','Check-out','Ditë aktive','Op. të peshuara','Op./ditë','Periudha e kaluar','Ndryshimi %','Kategoria','Kulm','Në rënie'], pr.workers.map(w=>[w.operator,w.checkin,w.map,w.checkout,w.activeDays,w.weighted,w.perDay,w.prevPerDay,w.changePct,w.band,w.spike?'po':'',w.declining?'po':''])),
    steps:()=>statsCsv('wh-kohet-e-hapave',['Hapi','Matje','Mediana (s)','p90 (s)','Pritja mediana (s)'], app.steps.map(s=>[s.process,s.n,s.median,s.p90,s.waitMedian])),
  };
  $$('[data-csv]').forEach(b=>b.onclick=()=>csv[b.dataset.csv]());
  const save=$('#stSave'); if(save) save.onclick=async()=>{
    const thresholds={}; $$('[data-thg]').forEach(i=>{ const k=i.dataset.thg; thresholds[k]={green:Number(i.value), yellow:Number($(`[data-thy="${k}"]`).value)}; });
    try{ const r=await fetch('/stats/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cutoff:$('#stCut').value.trim(), targetOrdersPerDay:Number($('#stTarget').value), thresholds})});
      const j=await r.json(); if(!r.ok||j.error) throw new Error(j.error||('HTTP '+r.status));
      toast('Cilësimet u ruajtën'); if(statsLast) statsLast.config=j.config; loadStatsWH();
    }catch(e){ $('#stMsg').textContent='✗ '+e.message; }
  };
}
