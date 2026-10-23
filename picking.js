/* =========================================================================
   PICKING (the warehouse lead, 14.10.2026) — the WMS pick sessions per day, shift and operator, picks per hour and
   units scanned / required. Source: WMS Pulse block E (pickH / pickS / pickSt — PickSession, PickSessionOrder,
   PickSessionItem, PickSessionScan; read-only SQL, refreshed every hour 07–22). The pick tables keep UTC: the query turns
   every time into local time. A pick = one PickSessionScan (one unit picked).
   People: from 01.09.2026 only the staff on "Orari i punës" (WODS.staffName — the same rule as every list); the shift of a
   person-day comes from the schedule (start before 12:00 → N1, otherwise N2; Saturday/Sunday → Weekend), someone not on
   the schedule that day by their first pick (before 14:00 → N1).
   Session status 2 = closed normally (most sessions); status 1 and 3 are shown as numbers — their meaning is not confirmed.
   =======================================================================*/
let pkDate=null, pkData=null, pkSched={};
async function renderPicking(v){
  if(!pkDate) pkDate=todayStr();
  v.innerHTML=pagehead('Picking','Mbledhja e porosive me sesione picking në WMS: <b>sipas ditës, ndërrimit dhe operatorit</b>, picks për orë dhe njësi të skanuara / të kërkuara. Burimi: WMS (tabelat e picking-ut), rifreskohet çdo orë 07–22. Vetëm stafi në Orarin e punës.','')
    + `<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <label class="small" style="display:flex;gap:6px;align-items:center">Data <input type="date" id="pkDate" value="${h(pkDate)}" max="${h(todayStr())}" style="width:auto;min-height:34px"></label>
        <button class="btn sm" id="pkToday">Sot</button><button class="btn sm" id="pkYday">Dje</button>
        <span class="small faint" id="pkAt" style="margin-left:auto"></span></div></div>
      <div id="pkBody"><div class="empty">Po lexohen të dhënat…</div></div>`;
  $('#pkDate').onchange=e=>{ if(e.target.value && e.target.value<=todayStr()){ pkDate=e.target.value; pkDraw(); } };
  $('#pkToday').onclick=()=>{ pkDate=todayStr(); $('#pkDate').value=pkDate; pkDraw(); };
  $('#pkYday').onclick=()=>{ const d=new Date(todayStr()+'T12:00:00'); d.setDate(d.getDate()-1); pkDate=fmtLocalDate(d); $('#pkDate').value=pkDate; pkDraw(); };
  if(!wmsOnAgent()){ $('#pkBody').innerHTML='<div class="empty">Hape app-in nga agjenti: http://localhost:8790/app.html</div>'; return; }
  try{ const j=await fetch('/pulse/data',{cache:'no-store'}).then(r=>r.json()); pkData=j.picking||null; }catch(e){ pkData=null; }
  if(!pkData){ $('#pkBody').innerHTML='<div class="empty">Të dhënat e picking-ut ende s\'janë lexuar nga WMS (blloku E i WMS Pulse) — vijnë me rifreskimin e radhës (çdo orë 07–22).</div>'; return; }
  $('#pkAt').textContent= pkData.at? 'WMS: '+new Date(pkData.at).toLocaleString() : '';
  pkDraw();
}
const pkWeekend=d=>{ const w=new Date(d+'T12:00:00').getDay(); return w===0||w===6; };
async function pkSchedFor(from, to){
  const key=from+'|'+to; if(pkSched[key]) return pkSched[key];
  try{ const j=await fetch('/schedule/days?from='+from+'&to='+to,{cache:'no-store'}).then(r=>r.json()); pkSched[key]=(j&&j.days)||{}; }catch(e){ pkSched[key]={}; }
  return pkSched[key];
}
/* the day's rows, the staff rule applied, merged by person (second accounts under the person's name) */
function pkPeople(date, sched){
  const day=sched[date]||null, norm=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  const name=fn=>{ const n=String(fn||'').replace(/\s+/g,' ').trim()||'(pa emër)'; return (window.WODS && WODS.staffName)? WODS.staffName(n, date) : n; };
  const P={}, out={excluded:0}; const get=n=>P[n]||(P[n]={name:n, s:0, s1:0, s2:0, s3:0, o:0, rq:0, sc:0, sec2:0, f:null, l:null, hours:{}});
  pkData.days.filter(r=>r.d===date).forEach(r=>{ const n=name(r.fn); if(!n){ out.excluded+=r.sc||0; return; } const p=get(n);
    ['s','s1','s2','s3','o','rq','sc','sec2'].forEach(k=>p[k]+=+r[k]||0); if(!p.f || r.f<p.f) p.f=r.f; if(!p.l || r.l>p.l) p.l=r.l; });
  pkData.hours.filter(r=>r.d===date).forEach(r=>{ const n=name(r.fn); if(!n) return; const p=get(n); p.hours[r.h]=(p.hours[r.h]||0)+(+r.n||0); });
  const sh=n=>{ if(pkWeekend(date)) return 'Weekend'; const k=day && Object.keys(day).find(x=>norm(x)===norm(n)), s=k&&day[k];
    if(s && !s.off){ const m=/^(\d{1,2})/.exec(s.start||''); return m && +m[1]<12? 'N1' : 'N2'; }
    const first=Math.min(...Object.keys(P[n].hours).map(Number)); return isFinite(first)? (first<14? 'N1' : 'N2') : (P[n].f && +P[n].f.slice(0,2)<14? 'N1' : 'N2'); };
  out.people=Object.values(P).map(p=>{ const hrs=Object.keys(p.hours).length, picks=Object.values(p.hours).reduce((a,b)=>a+b,0);
    return Object.assign(p, {shift:sh(p.name), activeH:hrs, picks, perHour: hrs? picks/hrs : null, avgMin: p.s2? p.sec2/p.s2/60 : null}); })
    .sort((a,b)=>b.picks-a.picks || b.o-a.o);
  return out;
}
const pkPct=(a,b)=> b? Math.round(a/b*100)+'%' : '—';
const pkR=x=> x==null? '—' : (Math.round(x*10)/10).toLocaleString();
async function pkDraw(){
  const box=$('#pkBody'); if(!box || !pkData) return;
  const from=(()=>{ const d=new Date(pkDate+'T12:00:00'); d.setDate(d.getDate()-13); return fmtLocalDate(d); })();
  const sched=await pkSchedFor(from, pkDate);
  const D=pkPeople(pkDate, sched), ppl=D.people;
  const sum=(arr,k)=>arr.reduce((a,p)=>a+(+p[k]||0),0);
  const T={picks:sum(ppl,'picks'), o:sum(ppl,'o'), s:sum(ppl,'s'), s2:sum(ppl,'s2'), s3:sum(ppl,'s3'), s1:sum(ppl,'s1'), rq:sum(ppl,'rq'), sc:sum(ppl,'sc'), h:sum(ppl,'activeH'), sec2:sum(ppl,'sec2')};
  if(!ppl.length){ box.innerHTML=`<div class="empty">Asnjë sesion picking më ${h(fmtDateAl(pkDate))}${D.excluded? ' nga stafi në orar ('+D.excluded+' njësi nga llogari jashtë orarit)' : ''}.</div>`+pkTrend(sched); return; }
  // by hour: the team's picks, and by shift
  const hrs=[...new Set(ppl.flatMap(p=>Object.keys(p.hours).map(Number)))].sort((a,b)=>a-b), byH={}; ppl.forEach(p=>Object.entries(p.hours).forEach(([k,n])=>byH[k]=(byH[k]||0)+n));
  const maxH=Math.max(1,...Object.values(byH));
  const shifts=['N1','N2','Weekend'].map(s=>{ const g=ppl.filter(p=>p.shift===s); return g.length? {s, n:g.length, ss:sum(g,'s'), o:sum(g,'o'), sc:sum(g,'sc'), rq:sum(g,'rq'), picks:sum(g,'picks'), h:sum(g,'activeH')} : null; }).filter(Boolean);
  box.innerHTML=`
    <div class="grid g-kpi" style="margin-bottom:12px">
      ${kpiCard(T.picks.toLocaleString(), 'Picks (njësi të skanuara)', T.h? pkR(T.picks/T.h)+' picks/orë për person' : '')}
      ${kpiCard(T.o.toLocaleString(), 'Porosi në sesione', T.s+' sesione · '+ppl.length+' pickers')}
      ${kpiCard(pkPct(T.sc,T.rq), 'Skanuar / kërkuar', T.sc.toLocaleString()+' / '+T.rq.toLocaleString()+' njësi')}
      ${kpiCard(T.s2+' / '+T.s, 'Sesione me status 2', (T.s3? 'status 3: '+T.s3+' · ' : '')+(T.s1? 'status 1 (hapur): '+T.s1+' · ' : '')+(T.s2? 'mesatarisht '+pkR(T.sec2/T.s2/60)+' min' : ''))}</div>
    <div class="card" style="margin-bottom:12px"><h3 style="margin-top:0">Sipas ndërrimit</h3><div class="tablewrap"><table><thead><tr><th>Ndërrimi</th><th>Pickers</th><th>Sesione</th><th>Porosi</th><th>Picks</th><th>Skanuar / kërkuar</th><th>Orë aktive</th><th>Picks / orë</th></tr></thead><tbody>
      ${shifts.map(x=>`<tr><td><b>${x.s}</b></td><td>${x.n}</td><td>${x.ss}</td><td>${x.o}</td><td>${x.picks}</td><td>${x.sc} / ${x.rq} <span class="faint">(${pkPct(x.sc,x.rq)})</span></td><td>${x.h}</td><td><b>${x.h? pkR(x.picks/x.h) : '—'}</b></td></tr>`).join('')}</tbody></table></div>
      <div class="hint">Ndërrimi i personit nga Orari i punës (fillim para 12:00 → N1, ndryshe N2; e shtunë/e diel → Weekend); pa orar → sipas pick-ut të parë.</div></div>
    <div class="card" style="margin-bottom:12px"><h3 style="margin-top:0">Sipas operatorit <span class="sub">${h(fmtDateAl(pkDate))}</span></h3><div class="tablewrap"><table><thead><tr><th>Operatori</th><th>Ndërrimi</th><th>Sesione (st. 2 / 3)</th><th>Porosi</th><th>Picks</th><th>Skanuar / kërkuar</th><th>Orë aktive</th><th>Picks / orë</th><th>Sesioni mes.</th><th>Sesionet</th></tr></thead><tbody>
      ${ppl.map(p=>`<tr><td><b>${h(p.name)}</b></td><td>${p.shift}</td><td data-sort="${p.s}">${p.s} <span class="faint small">(${p.s2} / ${p.s3})</span></td><td>${p.o}</td><td>${p.picks}</td>
        <td data-sort="${p.rq? p.sc/p.rq : 0}">${p.sc} / ${p.rq} <span class="faint">(${pkPct(p.sc,p.rq)})</span></td><td>${p.activeH}</td><td data-sort="${p.perHour||0}"><b>${pkR(p.perHour)}</b></td>
        <td data-sort="${p.avgMin||0}">${p.avgMin!=null? pkR(p.avgMin)+' min' : '—'}</td><td class="small">${h(p.f||'')}${p.l&&p.l!==p.f? '–'+h(p.l) : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="hint">Picks = njësi të skanuara gjatë picking-ut (çdo skanim një njësi). Picks / orë = picks ÷ orët me të paktën një skanim. Sesioni mes. = nga hapja te mbyllja (vetëm statusi 2) — një sesion i lënë hapur e zgjat. ${D.excluded? D.excluded+' njësi nga llogari jashtë orarit nuk numërohen.' : ''}</div></div>
    <div class="card" style="margin-bottom:12px"><h3 style="margin-top:0">Picks për orë <span class="sub">ekipi dhe secili operator</span></h3>
      <div style="display:flex;align-items:flex-end;gap:4px;height:120px;margin:8px 0 4px">${hrs.map(x=>`<div title="${String(x).padStart(2,'0')}:00 · ${byH[x]} picks" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
        <span class="small">${byH[x]}</span><div style="width:100%;background:var(--accent);border-radius:3px 3px 0 0;height:${Math.round(byH[x]/maxH*90)}%"></div></div>`).join('')}</div>
      <div style="display:flex;gap:4px">${hrs.map(x=>`<div class="small faint" style="flex:1;text-align:center">${String(x).padStart(2,'0')}</div>`).join('')}</div>
      <div class="tablewrap" style="margin-top:10px"><table class="heat"><thead><tr><th>Operatori</th>${hrs.map(x=>`<th>${String(x).padStart(2,'0')}</th>`).join('')}<th>Gjithsej</th></tr></thead><tbody>
      ${ppl.map(p=>`<tr><th style="text-align:left">${h(p.name)}</th>${hrs.map(x=>{ const n=p.hours[x]||0; return `<td style="background:rgba(17,91,146,${(n/maxH*0.85).toFixed(2)});color:${n/maxH>0.55?'#fff':'var(--text)'}">${n||''}</td>`; }).join('')}<td><b>${p.picks}</b></td></tr>`).join('')}</tbody></table></div></div>
    ${pkStations()}
    ${pkTrend(sched)}`;
}
function pkStations(){
  const rows=(pkData.stations||[]).filter(r=>r.d===pkDate).sort((a,b)=>b.sc-a.sc); if(!rows.length) return '';
  return `<div class="card" style="margin-bottom:12px"><h3 style="margin-top:0">Sipas stacionit</h3><div class="tablewrap"><table style="max-width:560px"><thead><tr><th>Stacioni</th><th>Sesione</th><th>Porosi</th><th>Njësi të skanuara</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${h(r.st||'(pa stacion)')}</td><td>${r.s}</td><td>${r.o}</td><td>${r.sc}</td></tr>`).join('')}</tbody></table></div><div class="hint">Të gjitha llogaritë (stacioni nuk e njeh personin).</div></div>`;
}
function pkTrend(sched){
  const days=[...new Set(pkData.days.map(r=>r.d))].filter(d=>d<=pkDate).sort().slice(-14).reverse(); if(!days.length) return '';
  return `<div class="card"><h3 style="margin-top:0">14 ditët e fundit</h3><div class="tablewrap"><table><thead><tr><th>Data</th><th>Pickers</th><th>Sesione</th><th>Porosi</th><th>Picks</th><th>Skanuar / kërkuar</th><th>Picks / orë</th></tr></thead><tbody>
    ${days.map(d=>{ const P=pkPeople(d, sched).people, s=k=>P.reduce((a,p)=>a+(+p[k]||0),0), hh=s('activeH');
      return `<tr><td data-sort="${d}"><a href="#" data-pkd="${d}">${h(fmtDateAl(d))}</a></td><td>${P.length}</td><td>${s('s')}</td><td>${s('o')}</td><td>${s('picks')}</td><td>${s('sc')} / ${s('rq')} <span class="faint">(${pkPct(s('sc'),s('rq'))})</span></td><td>${hh? pkR(s('picks')/hh) : '—'}</td></tr>`; }).join('')}</tbody></table></div>
    <div class="hint">Kliko një datë për detajet. Sesionet numërohen sipas ditës kur nisin; picks sipas orës së skanimit.</div></div>`;
}
document.addEventListener('click', e=>{ const a=e.target.closest && e.target.closest('[data-pkd]'); if(!a) return; e.preventDefault(); pkDate=a.dataset.pkd; const i=$('#pkDate'); if(i) i.value=pkDate; pkDraw(); window.scrollTo(0,0); });
