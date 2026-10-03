/* ============================================================================
   "Statistikat e WH" — warehouse statistics module (phase 1).
   WMS figures come from the agent (GET /stats/live, defined in wms-stats.js); App figures are computed here
   from the observation data the app already stores (measurements, observations, problems). Every block shows
   its definition, source (WMS / App / Kombinuar), period and refresh time. Loaded before app.js (ROUTES
   references renderStatsWH); it only uses app.js helpers at call time.
   ==========================================================================*/
'use strict';
let statsRange='7d', statsShift='', statsLast=null, statsDate='', statsSeq=0;
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

/* WMS Pulse — the database dashboard (pulse/template.html), fed by pulse/data.json which the scheduled
   "WMS Pulse refresh" task rebuilds from the WMS database; the page re-reads it every 5 minutes. */
function renderPulse(v){
  v.innerHTML = pagehead('WMS Pulse','Tabelat nga databaza e WMS-it (produktiviteti, pagesa për veprim, porositë, stoku, inbound). Rifreskohet automatikisht nga databaza; kjo faqe lexon versionin më të ri çdo 5 minuta.')
    + (wmsOnAgent()? '<iframe id="pulseFrame" src="/pulse/template.html?embed=1&theme=light" title="WMS Pulse" style="width:100%;height:calc(100vh - 150px);min-height:600px;border:1px solid var(--line);border-radius:10px;background:var(--bg)"></iframe>'
                   : '<div class="card"><div class="empty">Hape app-in nga http://localhost:8790.</div></div>');
}
/* Orari i punës — the schedule editor "Orari i Warehouse" (warehouse-schedule/, its own server on :3000) shown inside the
   app. The agent reads its monthly Excel export every 15 min (and on "Sinkronizo tani") into the plan behind the shift
   stats, Kapaciteti & Stafi and Insights. */
const fmtSyncAt=iso=>{ const d=new Date(iso), p=n=>String(n).padStart(2,'0'); return isNaN(d)? iso : p(d.getDate())+'.'+p(d.getMonth()+1)+' '+p(d.getHours())+':'+p(d.getMinutes()); };
function renderOrari(v){
  v.innerHTML = pagehead('Orari i punës','Orari mujor i stafit të depos — editohet këtu (Orari i Warehouse). Çdo ndryshim kalon automatikisht te statistikat e ndërrimeve, Kapaciteti & Stafi dhe Insights (sinkronizim çdo 15 minuta, ose menjëherë me «Sinkronizo tani»).',
      `<span class="no-print" style="display:flex;gap:6px"><button class="btn sm" id="orariSync">⟳ Sinkronizo tani</button><a class="btn sm ghost" id="orariOpen" target="_blank" rel="noopener">↗ Hape veç</a></span>`)
    + (wmsOnAgent()? `<div id="orariInfo" class="small faint" style="margin:-4px 0 10px">Po lexohet statusi…</div><div id="orariBody"></div>`
                   : '<div class="card"><div class="empty">Hape app-in nga http://localhost:8790.</div></div>');
  if(!wmsOnAgent()) return;
  $('#orariSync').onclick=()=>orariSync();
  orariLoad();
}
function orariInfoHTML(j, msg){
  const parts=[];
  if(msg) parts.push(msg);
  if(j.syncError) parts.push(`<span style="color:var(--warn)">⚠ ${h(j.syncError)}</span>`);
  else if(j.lastSync) parts.push('Sinkronizuar: <b>'+h(fmtSyncAt(j.lastSync))+'</b>');
  if(j.loaded) parts.push(`Plani: ${h(fmtDateAl(j.from))} → ${h(fmtDateAl(j.to))} · ${j.operators} operatorë`);
  if(j.syncUnmapped&&j.syncUnmapped.length) parts.push(`<span style="color:var(--warn)">pa përputhje me stafin e WMS-it: ${j.syncUnmapped.map(h).join(', ')}</span>`);
  return parts.join(' · ');
}
async function orariLoad(msg){
  let j={}; try{ j=await (await fetch('/schedule',{cache:'no-store'})).json(); }catch(e){ $('#orariInfo').textContent='Agjenti s\'përgjigjet.'; return; }
  const base=j.appUrl||'http://localhost:3000';
  $('#orariOpen').href=base+'/orari';
  $('#orariInfo').innerHTML=orariInfoHTML(j, msg);
  const body=$('#orariBody'); if(!body) return;
  // the editor runs as its own server: show it when it answers, otherwise say how to start it
  const up=await fetch(base+'/orari',{mode:'no-cors',cache:'no-store'}).then(()=>true,()=>false);
  if(!$('#orariBody')) return;
  body.innerHTML= up
    ? `<iframe id="orariFrame" src="${h(base)}/orari" title="Orari i Warehouse" style="width:100%;height:calc(100vh - 190px);min-height:600px;border:1px solid var(--line);border-radius:10px;background:#fff"></iframe>`
    : `<div class="card"><div class="empty">Editori i orarit (Orari i Warehouse) nuk po punon në ${h(base)}.<br>Plani i fundit i sinkronizuar mbetet në përdorim për statistikat.<br><span class="small">Nise me: <code>npm --prefix warehouse-schedule run dev</code> (në dosjen e projektit), pastaj rifresko këtë faqe.</span></div></div>`;
}
async function orariSync(){
  const b=$('#orariSync'); if(b){ b.disabled=true; b.textContent='⟳ Po sinkronizohet…'; }
  try{ const r=await fetch('/schedule/sync',{method:'POST'}); const j=await r.json();
    const msg= j.ok? '✓ '+j.months.filter(m=>m.days).map(m=>m.m+'/'+m.y+': '+m.days+' ditë').join(', ') : '';
    $('#orariInfo').innerHTML=orariInfoHTML(Object.assign({}, j.summary||{}, j.ok?{}:{syncError:j.error}), msg);
  }catch(e){ $('#orariInfo').textContent='Sinkronizimi dështoi ('+e.message+').'; }
  finally{ if(b){ b.disabled=false; b.textContent='⟳ Sinkronizo tani'; } }
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
  let live=null, err=null; const seq=++statsSeq;
  const q=statsRange==='day' ? 'date='+encodeURIComponent(statsDate||todayStr()) : 'range='+statsRange;
  if(!wmsOnAgent()) err='Hape app-in nga http://localhost:8790 që të lexohen të dhënat e WMS-it.';
  else try{ const r=await fetch('/stats/live?'+q+'&shift='+encodeURIComponent(statsShift),{cache:'no-store'}); live=await r.json();
    if(!r.ok||live.error){ err=live.error==='auth_expired'?'Sesioni i WMS ka skaduar — ngjit cookie-n e re te WMS Data & Performance.':(live.error||('HTTP '+r.status)); live=null; } }
  catch(e){ err='Agjenti s\'përgjigjet ('+e.message+').'; }
  if(seq!==statsSeq) return;   // a newer filter change is already loading
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
    ${t.heatmap.map((r,i)=>`<tr><th>${STATS_WEEKDAYS[i]}</th>${hrs.map(hh=>`<td style="background:rgba(17,91,146,${(r[hh]/hmax*0.85).toFixed(2)});color:${r[hh]/hmax>0.55?'#fff':'var(--text)'}">${r[hh]||''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
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

/* ============================================================================
   Shift statistics — rendered inside WMS Data & Performance → Shifts (GET /stats/shifts, wms-stats.js).
   Daily or weekly (Mon–Sun of the chosen date): per shift, each operator assigned to that shift, their output
   and scan-based timing signals, the team totals, plus a lead's view comparing N1 and N2.
   ==========================================================================*/
let shiftStatsDate='', shiftStatsMode='day', shiftStatsLast=null, shiftStatsSeq=0;
function shiftStatsHTML(){
  return `<div class="card" style="margin-top:14px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <h3 style="margin:0">Statistikat sipas ndërrimit</h3>
      <span style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn sm ${shiftStatsMode==='day'?'primary':''}" data-shmode="day">Ditore</button>
        <button class="btn sm ${shiftStatsMode==='week'?'primary':''}" data-shmode="week">Javore</button>
        <input type="date" id="shiftStatsDate" value="${h(shiftStatsDate||todayStr())}" max="${h(todayStr())}" style="width:auto;min-height:34px">
        <button class="btn sm" id="shiftStatsRefresh">↻</button>
        <button class="btn sm ghost" id="shiftStatsCsv">⬇ CSV</button>
      </span></div>
    <div id="shiftSchedBar" class="small" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span id="shiftSchedInfo" class="faint">Orari: po lexohet…</span>
      <label class="btn sm ghost" style="cursor:pointer">📅 Ngarko orarin (.xlsx)<input type="file" id="shiftSchedFile" accept=".xlsx" style="display:none"></label></div>
    <div id="shiftStatsBody" style="margin-top:10px"><div class="empty">Po ngarkohet…</div></div></div>`;
}
async function loadShiftSchedInfo(msg){
  const el=$('#shiftSchedInfo'); if(!el || !wmsOnAgent()) return;
  try{ const j=await (await fetch('/schedule',{cache:'no-store'})).json();
    el.innerHTML=(msg? msg+' · ' : '') + (j.loaded
      ? `Orari i planifikuar: <b>${h(fmtDateAl(j.from))} → ${h(fmtDateAl(j.to))}</b> · ${j.operators} operatorë · oraret ${Object.keys(j.slots||{}).map(h).join(', ')}${j.lastSync?' · <span class="faint">nga Orari i Warehouse, sinkronizuar '+h(fmtSyncAt(j.lastSync))+'</span>':j.lastFile?' · <span class="faint">'+h(j.lastFile)+'</span>':''} · <a href="#orari">✏️ Edito orarin</a>`
      : 'S\'ka orar të ngarkuar — ndërrimi i secilit nxirret nga skanimet. Plotëso orarin te <a href="#orari">Orari i punës</a> ose ngarko orarin mujor (.xlsx).');
  }catch(e){ el.textContent='Orari: agjenti s\'përgjigjet.'; }
}
function importShiftSchedule(file){
  const el=$('#shiftSchedInfo'); if(!file) return; if(el) el.textContent='Po ngarkohet orari…';
  const fr=new FileReader();
  fr.onload=async()=>{ try{
      const r=await fetch('/schedule/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:fr.result, name:file.name})}); const j=await r.json();
      if(!r.ok||j.error){ if(el) el.innerHTML=`<span style="color:var(--crit)">Orari s'u ngarkua: ${h(j.error||('HTTP '+r.status))}</span>`; return; }
      loadShiftSchedInfo(`✓ U ngarkuan ${j.days} ditë, ${j.operators.length} operatorë${j.unmapped&&j.unmapped.length?' · <span style="color:var(--warn)">pa përputhje: '+j.unmapped.map(h).join(', ')+'</span>':''}`);
      loadShiftStats();
    }catch(e){ if(el) el.textContent='Orari s\'u ngarkua ('+e.message+').'; } };
  fr.readAsDataURL(file);
}
function wireShiftStats(){
  $$('[data-shmode]').forEach(b=>b.onclick=()=>{ shiftStatsMode=b.dataset.shmode; $$('[data-shmode]').forEach(x=>x.classList.toggle('primary', x.dataset.shmode===shiftStatsMode)); loadShiftStats(); });
  const di=$('#shiftStatsDate'); if(di) di.onchange=e=>{ shiftStatsDate=e.target.value||todayStr(); loadShiftStats(); };
  const rf=$('#shiftStatsRefresh'); if(rf) rf.onclick=()=>loadShiftStats();
  const sf=$('#shiftSchedFile'); if(sf) sf.onchange=e=>{ importShiftSchedule(e.target.files[0]); e.target.value=''; };
  loadShiftSchedInfo();
  const cv=$('#shiftStatsCsv'); if(cv) cv.onclick=()=>{ const d=shiftStatsLast; if(!d) return;
    statsCsv('wh-nderrimet-'+d.mode+'-'+d.from, ['Ndërrimi','Operatori','Ditë','Check-in','Map','Check-out','Op. të peshuara','Op./ditë','Op./orë aktive','Skanimi i parë (mes.)','Skanimi i fundit (mes.)','Nisja pas fillimit (min, mes.)','Ditë me nisje >15 min','Ditë me mbarim >30 min para','Pushime >30 min','Minuta pushimi','Evente jashtë orarit'],
      d.shifts.flatMap(s=>s.operators.map(o=>[s.name,o.operator,o.days,o.checkin,o.map,o.checkout,o.weighted,o.perDay,o.perActiveHour,o.avgFirst,o.avgLast,o.avgLateMin,o.lateDays,o.earlyDays,o.idleCount,o.idleMin,o.outside])));
    if((d.absences||[]).length || (d.unplanned||[]).length)
      statsCsv('wh-prania-'+d.mode+'-'+d.from, ['Data','Operatori','Statusi','Ndërrimi / arsyeja','Evente','Skanimi i parë','Skanimi i fundit'],
        [...(d.absences||[]).map(a=>[a.date,a.operator,'Planifikuar, pa skanime',a.shift+' ('+a.hours+')','','','']),
         ...(d.unplanned||[]).map(u=>[u.date,u.operator,'Punë jashtë planit',u.reason,u.events,u.first,u.last])]); };
  loadShiftStats();
}
async function loadShiftStats(){
  const body=$('#shiftStatsBody'); if(!body) return;
  if(!wmsOnAgent()){ body.innerHTML='<div class="empty">Hape app-in nga http://localhost:8790.</div>'; return; }
  body.innerHTML=`<div class="empty">Po ngarkohet…${shiftStatsMode==='week'?' (java e parë mund të marrë deri në një minutë)':''}</div>`;
  const seq=++shiftStatsSeq;   // only the latest request may render — an older, slower response must not overwrite it
  try{ const r=await fetch('/stats/shifts?mode='+shiftStatsMode+'&date='+encodeURIComponent(shiftStatsDate||todayStr()),{cache:'no-store'}); const j=await r.json();
    if(seq!==shiftStatsSeq) return;
    if(!r.ok||j.error){ body.innerHTML=`<div class="empty">${h(j.error==='auth_expired'?'Sesioni i WMS ka skaduar — ngjit cookie-n e re më lart.':(j.error||('HTTP '+r.status)))}</div>`; return; }
    shiftStatsLast=j; body.innerHTML=renderShiftStatsHTML(j);
  }catch(e){ if(seq===shiftStatsSeq) body.innerHTML=`<div class="empty">Agjenti s'përgjigjet (${h(e.message)}).</div>`; }
}
const shiftLbl=(s,sep)=> s.name===s.start+'–'+s.end ? h(s.name) : h(s.name)+sep+h(s.start)+'–'+h(s.end);
function renderShiftStatsHTML(d){
  const week=d.mode==='week', period=week? `java ${h(fmtDateAl(d.from))} → ${h(fmtDateAl(d.to))}${d.days.length<7?' (deri sot)':''}` : h(fmtDateAl(d.from));
  const shifts=d.shifts.filter(s=>s.daysCovered>0);
  if(!shifts.length) return `<div class="empty">S'ka ndërrime aktive për ${period} (p.sh. weekend pa turn aktiv).</div>`;
  const fmtH=m=>m==null?'—':(m>=60? Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m' : m+' min');
  const shiftCard=s=>{
    const t=s.team, rows=s.operators;
    if(!rows.length) return `<div class="card" style="margin-bottom:12px"><h3>${shiftLbl(s," · ")}</h3><div class="empty">S'ka aktivitet të stafit në këtë ndërrim${t.plannedDays?` (planifikuar: ${t.plannedDays}${t.absentDays?', pa skanime: '+t.absentDays:''})`:''}.</div></div>`;
    const kp=(v,l)=>`<div class="card kpi"><div class="val">${v}</div><div class="lbl">${l}</div></div>`;
    const tr=o=>`<tr><td>${h(o.operator)}</td>${week?`<td>${o.days}</td>`:''}<td>${o.checkin}</td><td>${o.map}</td><td>${o.checkout}</td><td><b>${o.weighted}</b></td>${week?`<td>${o.perDay}</td>`:''}
      <td>${o.perActiveHour!=null?o.perActiveHour:'—'}</td><td>${h(o.avgFirst||'—')}</td><td>${h(o.avgLast||'—')}</td><td>${o.avgLateMin>15?`<span style="color:var(--warn)">${o.avgLateMin}</span>`:o.avgLateMin}</td>
      <td>${o.idleCount} · ${fmtH(o.idleMin)}</td><td>${o.outside||'—'}</td></tr>`;
    const totalRow=`<tr style="font-weight:700;border-top:2px solid var(--line2)"><td>Ekipi (${t.operators})</td>${week?`<td>${t.operatorDays}</td>`:''}<td>${t.checkin}</td><td>${t.map}</td><td>${t.checkout}</td><td>${t.weighted}</td>${week?`<td>${t.perOperatorDay}</td>`:''}<td colspan="4"></td><td>${fmtH(t.idleMin)}</td><td></td></tr>`;
    const mx=Math.max(1,...s.hourly.map(x=>x.weightedPerDay));
    return `<div class="card" style="margin-bottom:12px"><h3>${shiftLbl(s," · ")} <span class="sub">${period}</span></h3>
      <div class="grid g-kpi" style="margin-bottom:10px">
        ${t.plannedDays? kp(`${t.operatorDays} / ${t.plannedDays}`, (week?'Ditë-operatori prezent / planifikuar':'Prezent / planifikuar')+(t.absentDays?` · <span style="color:var(--warn)">${t.absentDays} pa skanime</span>`:'')) : kp(t.operators,'Operatorë'+(week?' · '+t.operatorDays+' ditë-operatori':''))}
        ${kp(t.weighted,'Op. të peshuara (ekipi)')}
        ${kp(t.perOperatorDay!=null?t.perOperatorDay:'—','Op. / operator / ditë')}
        ${kp(t.orders,'Porosi të dala gjatë orarit')}
        ${kp(t.lateStarts,'Nisje e skanimit > 15 min')}
        ${kp(fmtH(t.idleMin),'Pushime > 30 min pa skanim')}
      </div>
      <div style="overflow-x:auto"><table style="font-size:12.5px"><thead><tr><th>Operatori</th>${week?'<th>Ditë</th>':''}<th>Check-in</th><th>Map</th><th>Check-out</th><th>Op. të peshuara</th>${week?'<th>Op./ditë</th>':''}
        <th>Op./orë aktive</th><th>Skanimi i parë</th><th>Skanimi i fundit</th><th>Nisja (min pas ${h(s.start)})</th><th>Pushime >30 min</th><th>Jashtë orarit</th></tr></thead>
        <tbody>${rows.map(tr).join('')}${totalRow}</tbody></table></div>
      ${week && s.byDay.length>1?`<div style="margin-top:10px"><b class="small">Sipas ditës</b><table style="font-size:12px;max-width:520px"><thead><tr><th>Data</th><th>Operatorë${t.plannedDays?' (prezent / plan)':''}</th><th>Op. të peshuara</th><th>Porosi të dala</th></tr></thead><tbody>${s.byDay.map(b=>`<tr><td>${h(fmtDateAl(b.date))} ${STATS_WEEKDAYS[(new Date(b.date+'T12:00:00').getDay()+6)%7]}</td><td>${b.planned? b.operators+' / '+b.planned : b.operators}</td><td>${b.weighted}</td><td>${b.orders}</td></tr>`).join('')}</tbody></table></div>`:''}
      <div style="margin-top:10px"><b class="small">Ritmi sipas orës</b> <span class="faint small">(op. të peshuara të ekipit${week?' për ditë':''})</span>${s.hourly.map(x=>barRow(String(x.hour).padStart(2,'0')+':00', x.weightedPerDay, mx, 'var(--accent)')).join('')}</div>
    </div>`;
  };
  // lead's view: N1 vs N2 (workday shifts) side by side, plus automatic signals
  const wd=shifts.filter(s=>!s.weekend && s.operators.length);
  const cmpRows=[['Operatorë (ditë-operatori)',s=>`${s.team.operators} (${s.team.operatorDays})`],
    ...(wd.some(s=>s.team.plannedDays)? [['Prania sipas orarit',s=>s.team.plannedDays? `${s.team.operatorDays} / ${s.team.plannedDays} (${Math.round(s.team.operatorDays/s.team.plannedDays*100)}%)` : '—']] : []),['Op. të peshuara',s=>s.team.weighted],['Op. / operator / ditë',s=>s.team.perOperatorDay],
    ['Porosi të dala gjatë orarit',s=>s.team.orders],['Porosi / operator / ditë',s=>s.team.operatorDays? Math.round(s.team.orders/s.team.operatorDays*10)/10 : '—'],
    ['Check-in / Map / Check-out',s=>`${s.team.checkin} / ${s.team.map} / ${s.team.checkout}`],['Nisje e skanimit > 15 min',s=>s.team.lateStarts],['Mbarim > 30 min para orarit',s=>s.team.earlyEnds],
    ['Pushime > 30 min pa skanim',s=>fmtH(s.team.idleMin)],['Pjesa e operatorit kryesor',s=>s.team.topShare!=null? `${s.team.topShare}% (${h(s.team.topOperator)})` : '—']];
  /* Signals: when most of a shift shows the same pattern it's a team/process signal (one line), and a person is
     only flagged when they stand clearly apart from their own shift — otherwise the list drowns in noise. */
  const team=[], people=[];
  wd.forEach(s=>{ const avg=s.team.perOperatorDay||0, ops=s.operators, n=ops.length;
    const late=ops.map(o=>o.avgLateMin), idle=ops.map(o=>Math.round(o.idleMin/o.days));
    const lateMed=Math.round(statsMedian(late)||0), idleMed=Math.round(statsMedian(idle)||0);
    const nLate=late.filter(x=>x>45).length, nIdle=idle.filter(x=>x>90).length;
    if(s.team.topShare>=35 && n>=3) team.push(`<b>${h(s.name)}:</b> ${h(s.team.topOperator)} bën ${s.team.topShare}% të punës së peshuar — varësi e lartë nga një person; mungesa e tij/saj godet ndërrimin.`);
    if(n>=3 && nLate>=Math.ceil(n*0.6)) team.push(`<b>${h(s.name)}:</b> ${nLate} nga ${n} operatorë e nisin skanimin më shumë se 45 min pas ${h(s.start)} (mediana ${lateMed} min) — ora e parë e ndërrimit s'përdoret për punë me skaner. Kontrollo çfarë ndodh në fillim të turnit (takim, përgatitje, pritje për punë).`);
    if(n>=3 && nIdle>=Math.ceil(n*0.6)) team.push(`<b>${h(s.name)}:</b> ${nIdle} nga ${n} operatorë kanë mbi 1h 30m në ditë pa skanim në pushime > 30 min (mediana ${fmtH(idleMed)}) — pritje për punë, punë pa skaner ose mungesë rrjedhe.`);
    ops.forEach(o=>{ const oIdle=Math.round(o.idleMin/o.days);
      if(o.avgLateMin>45 && o.avgLateMin>lateMed+45) people.push(`<b>${h(s.name)} · ${h(o.operator)}:</b> skanimi i parë mesatarisht ${o.avgLateMin} min pas ${h(s.start)} — ${o.avgLateMin-lateMed} min më vonë se mediana e ndërrimit${week?' ('+o.lateDays+' nga '+o.days+' ditë)':''}.`);
      if(oIdle>90 && oIdle>idleMed+90) people.push(`<b>${h(s.name)} · ${h(o.operator)}:</b> ${fmtH(oIdle)} në ditë pa skanim në pushime > 30 min — dukshëm mbi medianën e ndërrimit (${fmtH(idleMed)}).`);
      if(o.outside>0.2*(o.events+o.outside) && o.outside>=20) people.push(`<b>${h(s.name)} · ${h(o.operator)}:</b> ${o.outside} evente jashtë orarit të ndërrimit — punë shtesë ose orar i ndryshëm nga ai i planifikuar.`);
      if(avg>0 && o.perDay<avg*0.5 && o.events>0) people.push(`<b>${h(s.name)} · ${h(o.operator)}:</b> ${o.perDay} op./ditë — nën gjysmën e mesatares së ndërrimit (${avg}); kontrollo nëse ka pasur detyra pa skaner.`);
    }); });
  const absBy={}; (d.absences||[]).forEach(a=>(absBy[a.operator]=absBy[a.operator]||[]).push(a));
  Object.entries(absBy).forEach(([n,l])=>people.push(`<b>${h(n)}:</b> planifikuar${l.length>1?' '+l.length+' ditë':''} (${l.map(a=>h(fmtDateAl(a.date))+' '+h(a.hours)).join(', ')}) pa asnjë skanim — mungesë e mundshme, ndërrim i pa regjistruar ose punë pa skaner.`));
  const unBy={}; (d.unplanned||[]).forEach(u=>(unBy[u.operator]=unBy[u.operator]||[]).push(u));
  Object.entries(unBy).forEach(([n,l])=>people.push(`<b>${h(n)}:</b> skanime jashtë planit — ${l.map(u=>h(fmtDateAl(u.date))+' '+h(u.first)+'–'+h(u.last)+' ('+h(u.reason)+', '+u.events+' ev.)').join('; ')}. Përditëso orarin nëse ka pasur ndërrim.`));
  const signals=[...team, ...people];
  if(wd.length>=2){ const [a,b]=wd, pa=a.team.perOperatorDay||0, pb=b.team.perOperatorDay||0;
    if(pa&&pb&&Math.abs(pa-pb)/Math.max(pa,pb)>=0.25){ const lo=pa<pb?a:b, hi=pa<pb?b:a; signals.push(`<b>${h(lo.name)}</b> prodhon ${Math.round((1-Math.min(pa,pb)/Math.max(pa,pb))*100)}% më pak për operator se <b>${h(hi.name)}</b> (${Math.min(pa,pb)} kundrejt ${Math.max(pa,pb)} op./operator/ditë) — kontrollo ndarjen e stafit dhe të punës mes ndërrimeve.`); } }
  const lead=wd.length? `<div class="card" style="margin-bottom:12px"><h3>Për WH Lead <span class="sub">${period}</span></h3>
      <div style="overflow-x:auto"><table style="font-size:12.5px;max-width:720px"><thead><tr><th></th>${wd.map(s=>`<th>${shiftLbl(s," ")}</th>`).join('')}</tr></thead>
        <tbody>${cmpRows.map(([l,f])=>`<tr><td>${l}</td>${wd.map(s=>`<td>${f(s)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div style="margin-top:10px"><b class="small">Sinjale</b>${signals.length?`<ul style="margin:6px 0 0 18px;padding:0;font-size:12.5px;line-height:1.6">${signals.map(x=>`<li>${x}</li>`).join('')}</ul>`:'<div class="small faint">Asnjë sinjal i veçantë.</div>'}</div>
    </div>` : '';
  const warn=d.reliable===false?`<div class="hint" style="color:var(--warn);margin-bottom:8px">⚠ Disa ditë nuk u lexuan të plota nga WMS.</div>`:'';
  const sch=d.schedule||{}, planned=sch.planDays&&sch.planDays.length;
  const schNote= planned && sch.missingDays.length
    ? `<div class="hint" style="color:var(--warn);margin-bottom:8px">⚠ Pa orar të planifikuar për ${sch.missingDays.map(x=>h(fmtDateAl(x))).join(', ')} — për këto ditë ndërrimi nxirret nga skanimet.</div>` : '';
  return warn + schNote + lead + shifts.map(shiftCard).join('')
    + `<div class="hint">${planned? 'Me orar të planifikuar: çdo operator vendoset në ndërrimin e vet sipas orarit (p.sh. 09:00–17:00); nisja dhe mbarimi maten kundrejt orarit të tij; «pa skanime» = i planifikuar pa asnjë skanim në WMS; «jashtë planit» = skanime ditën OFF, pa orar ose vetëm jashtë orarit. Ditët pa orar: ç' : 'Ç'}do operator caktohet në <b>një</b> ndërrim për ditë, sipas kur ka punuar (N1 07–13 dhe N2 15–21 vendosin; mbivendosja 13–15 jo). Performanca numëron vetëm eventet brenda orarit të ndërrimit; të tjerat janë «jashtë orarit». Op. të peshuara = 1.0 × check-out (4/18) + 0.8 × check-in (2) + 0.6 × map (7). Skanimi i parë/i fundit dhe pushimet &gt; 30 min janë <b>sinjale nga skanimet</b>, jo orari i ardhjes: një punëtor mund të jetë i pranishëm pa skanuar (paketim, pastrim, ndihmë). «Porosi të dala gjatë orarit» = porosi me check-out në orët e ndërrimit (13–15 numërohen te të dy). Burimi: WMS ProductLogs · Depo Prishtinë · vetëm stafi i depos · freskuar ${h(new Date(d.refreshedAt).toLocaleString())}.</div>`;
}
