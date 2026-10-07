/* =========================================================================
   PLANI I PËRMIRËSIMIT — the improvement plan, followed day by day: are the actions being applied in the field, and
   do the numbers move? The plan itself (actions, KPIs with a frozen baseline and weekly targets, weekly checkpoints,
   scenarios, missing data) lives in the Store — collections planActions, planChecks, planKpis and config.plan — so it
   stays local with the rest of the operational data. The KPI values come from WMS automatically: /bn/data metrics of
   the Bottleneck Register (query block D14 "KPI ditore" and D1/D3), refreshed at 07, 13 and 18; safety records come from
   the register (category "Siguri"). Effect of an action = the KPI after its start date against the frozen baseline and
   against the 5 working days before the start (same definition, Mon–Fri). Adherence = days marked "Po" (1) or
   "Pjesërisht" (½) out of the working days since the start. Loaded after shared.js and before app.js.
   =======================================================================*/
let planBn=null, planTab='today', planLoading=false;
const PLAN_RES=[['po','✓ Po','b-ok'],['pjes','◐ Pjesërisht','b-warn'],['jo','✕ Jo','b-crit']];
const PLAN_STATUS=['Pa filluar','Në zbatim','Zbatuar','Pezulluar'];
const planCfg=()=> (Store.db.config||{}).plan || null;
const planIso=d=>d.toISOString().slice(0,10);
const planAdd=(iso,n)=>{ const d=new Date(iso+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return planIso(d); };
const planWd=iso=>{ const w=new Date(iso+'T12:00:00Z').getUTCDay(); return w>=1&&w<=5; };
const planToday=()=>{ const d=new Date(), p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); };
const planHM=m=> m==null||isNaN(m)? '—' : String(Math.floor(m/60)).padStart(2,'0')+':'+String(Math.round(m%60)).padStart(2,'0');
const planFmt=(k,v)=> v==null||isNaN(v)? '—' : k.time? planHM(v) : k.unit==='%'? v.toFixed(1).replace('.',',')+' %' : (Math.abs(v)>=100? Math.round(v).toLocaleString('de-DE') : String(Math.round(v*10)/10).replace('.',','))+(k.unit==='%'?' %':'');
const planD=iso=>iso? iso.slice(8,10)+'.'+iso.slice(5,7) : '—';

async function planLoad(){
  if(planLoading) return; planLoading=true;
  try{ planBn=await (await fetch('/bn/data',{cache:'no-store'})).json(); }catch(e){ planBn={error:e.message}; }
  finally{ planLoading=false; }
  if($('#planBody')) planDraw();
}
/* value of a KPI over a date range: Mon–Fri days; rates are Σ numerator ÷ Σ denominator, the rest an average */
function planKpiValue(k, from, to){
  if(k.key==='safety'){ const n=Store.col('problems').filter(p=>p.category==='Siguri' && (p.dateIdentified||'')>=from && (p.dateIdentified||'')<=to).length; return {v:n, days:null}; }
  const m=planBn&&planBn.metrics&&planBn.metrics[k.key]; if(!m) return {v:null, days:0};
  const s=(m.series||[]).filter(x=>x.d>=from && x.d<=to && planWd(x.d) && x.v!=null);
  if(!s.length) return {v:null, days:0};
  if(s[0].den!=null){ const num=s.reduce((a,x)=>a+(+x.num||0),0), den=s.reduce((a,x)=>a+(+x.den||0),0); return {v: den? (k.unit==='%'? num/den*100 : num/den) : null, days:s.length}; }
  if(k.time){ const v=s.map(x=>+x.v).sort((a,b)=>a-b); return {v:v[Math.floor(v.length/2)], days:s.length}; }   // median for clock times
  return {v:s.reduce((a,x)=>a+(+x.v),0)/s.length, days:s.length};
}
const planOnTarget=(k,v,t)=> v==null||t==null? null : k.better==='higher'? v>=t : v<=t;
function planWeekOf(iso){ const c=planCfg(); if(!c) return null; return (c.weeks||[]).find(w=>iso>=w.from && iso<=w.to)||null; }
function planAdherence(a){
  if(!a.startDate) return null; const end=planToday(); const checks=Store.col('planChecks').filter(c=>c.actionId===a.id);
  let exp=0, got=0; for(let d=a.startDate; d<=end; d=planAdd(d,1)){ if(!planWd(d)) continue; const c=checks.find(x=>x.date===d);
    if(d===end && !c) continue; exp++; if(c) got+= c.result==='po'? 1 : c.result==='pjes'? 0.5 : 0; }
  return exp? {pct:Math.round(got/exp*100), exp, got} : {pct:null, exp:0, got:0};
}
/* effect of an action on one KPI: before = frozen baseline and the 5 working days before the start; after = since the start */
function planEffect(a, k){
  const today=planToday(), y=planAdd(today,-1);
  if(!a.startDate || a.startDate>y) return null;
  let pre5=[], d=planAdd(a.startDate,-1); while(pre5.length<5 && d>planAdd(a.startDate,-21)){ if(planWd(d)) pre5.push(d); d=planAdd(d,-1); }
  const before=pre5.length? planKpiValue(k, pre5[pre5.length-1], pre5[0]) : {v:null};
  const after=planKpiValue(k, a.startDate, y);
  const delta= after.v!=null && k.baseline!=null? after.v-k.baseline : null;
  const better= delta==null? null : k.better==='higher'? delta>0 : delta<0;
  return {before:before.v, after:after.v, days:after.days, delta, better};
}

function renderPlan(v){
  const c=planCfg();
  v.innerHTML = pagehead(c? c.title : 'Plani i përmirësimit',
    'Plani drejt 1.000 porosive/ditë, i ndjekur çdo ditë: <b>a po aplikohen veprimet në terren</b> (shënimi ditor Po / Pjesërisht / Jo) dhe <b>si lëvizin shifrat</b> — KPI-të vijnë automatikisht nga WMS (07, 13, 18) dhe krahasohen me bazën e ngrirë dhe targetin e javës.',
    `<button class="btn" id="planRefresh">⟳ Rifresko</button>`)
    + `<div id="planTop"></div><div class="btnrow no-print" id="planTabs" style="margin:12px 0"></div><div id="planBody"><div class="empty">Po ngarkohet…</div></div>`;
  if(!c){ $('#planBody').innerHTML='<div class="card"><div class="empty">Plani nuk është krijuar ende.</div></div>'; return; }
  $('#planRefresh').onclick=()=>planLoad();
  if(planBn) planDraw(); planLoad();
}
function planDraw(){
  const c=planCfg(), body=$('#planBody'); if(!c||!body) return;
  const today=planToday(), wk=planWeekOf(today)||planWeekOf(planAdd(today,-1)), acts=Store.col('planActions').slice().sort((a,b)=>a.no-b.no);
  const active=acts.filter(a=>a.status==='Në zbatim' || (a.startDate && a.startDate<=today && a.status!=='Pezulluar' && a.status!=='Zbatuar'));
  const adh=acts.map(planAdherence).filter(x=>x&&x.exp); const adhAll= adh.length? Math.round(adh.reduce((s,x)=>s+x.got,0)/adh.reduce((s,x)=>s+x.exp,0)*100) : null;
  const dayN= today<c.start? 0 : Math.floor((Date.parse(today)-Date.parse(c.start))/864e5)+1;
  $('#planTop').innerHTML=`<div class="card"><div style="display:flex;gap:14px;flex-wrap:wrap;align-items:baseline">
      <b>${today<c.start? 'Plani nis më '+fmtDateAl(c.start) : wk? 'Java '+wk.n+' — '+h(wk.title) : 'Plani përfundoi'}</b>
      <span class="small faint">${fmtDateAl(c.start)} – ${fmtDateAl(c.end)}${dayN>0? ' · dita '+dayN : ''}</span>
      <span class="small">Veprime në zbatim: <b>${active.length}</b> / ${acts.length}</span>
      <span class="small">Zbatimi në terren: <b>${adhAll!=null? adhAll+' %' : '—'}</b></span>
      <span class="small faint" style="margin-left:auto">KPI nga WMS: ${planBn&&planBn.blocks&&planBn.blocks.D14? 'D14 '+String(planBn.blocks.D14.at).slice(8,10)+'.'+String(planBn.blocks.D14.at).slice(5,7)+' '+String(planBn.blocks.D14.at).slice(11,16) : '—'}</span></div></div>`;
  const tabs=[['today','✅ Sot'],['actions','🧩 Veprimet ('+acts.length+')'],['kpi','📈 KPI & efekti'],['weeks','🗓 Plani javor'],['report','📄 Plani']];
  $('#planTabs').innerHTML=tabs.map(([k,l])=>`<button class="btn sm ${planTab===k?'primary':''}" data-plant="${k}">${l}</button>`).join('');
  $$('[data-plant]').forEach(b=>b.onclick=()=>{ planTab=b.dataset.plant; planDraw(); });
  ({today:planDrawToday, actions:planDrawActions, kpi:planDrawKpi, weeks:planDrawWeeks, report:planDrawReport})[planTab](body, acts);
}
function planKpiCard(k, wkN){
  const c=planCfg(), w=(c.weeks||[]).find(x=>x.n===wkN);
  const last5=[]; let d=planAdd(planToday(),-1); while(last5.length<5 && d>planAdd(planToday(),-15)){ if(planWd(d)) last5.push(d); d=planAdd(d,-1); }
  const y=planAdd(planToday(),-1), inWeek= w && w.from<=y;   // before the week has a day behind it: the last 5 working days
  const cur= inWeek? planKpiValue(k, w.from, y<w.to? y : w.to) : planKpiValue(k, last5[last5.length-1], last5[0]);
  const t= w? k.targets[wkN-1] : k.targets[0]; const ok=planOnTarget(k, cur.v, t);
  return `<div class="kpi ${ok==null?'':ok?'st-ok':'st-warn'}"><div class="lbl">${h(k.name)}</div><div class="val">${planFmt(k,cur.v)}</div>
    <div class="foot">${inWeek? 'java '+wkN : '5 ditët e fundit'} · baza ${planFmt(k,k.baseline)} · target J${wkN} ${t!=null? (k.better==='higher'?'≥ ':'≤ ')+planFmt(k,t) : h(k.targetText||'—')}</div></div>`;
}

/* today: one line per action in progress — was it applied today? */
function planDrawToday(body, acts){
  const today=planToday(), wk=planWeekOf(today), kpis=Store.col('planKpis').slice().sort((a,b)=>a.no-b.no);
  const live=acts.filter(a=>a.status!=='Pezulluar' && a.status!=='Zbatuar' && a.startDate && a.startDate<=today);
  const soon=acts.filter(a=>a.startDate && a.startDate>today).sort((a,b)=>a.startDate<b.startDate?-1:1).slice(0,4);
  const ch=Store.col('planChecks').filter(x=>x.date===today);
  body.innerHTML=`<div class="grid g-kpi" style="margin-bottom:12px">${kpis.map(k=>planKpiCard(k, wk? wk.n : 1)).join('')}</div>
    <div class="card" style="margin-bottom:12px"><h3>A u aplikua sot? <span class="sub">${fmtDateAl(today)}${planWd(today)?'':' · ditë pushimi'}</span></h3>
    ${live.length? live.map(a=>{ const c=ch.find(x=>x.actionId===a.id), ad=planAdherence(a);
      return `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line)">
        <span class="badge b-new">#${a.no}</span><div style="flex:1;min-width:240px"><b>${h(a.title)}</b><div class="small faint">${h(a.owner||'—')} · ${h(a.when||'')}${ad&&ad.pct!=null? ' · zbatimi '+ad.pct+' %' : ''}</div></div>
        ${PLAN_RES.map(([v,l,cls])=>`<button class="btn sm ${c&&c.result===v? '' : 'ghost'}" data-pck="${a.id}|${v}" ${c&&c.result===v? `style="outline:2px solid var(--accent)"` : ''}>${l}</button>`).join('')}
        <input type="text" data-pnote="${a.id}" placeholder="shënim (çfarë u bë / pse jo)" value="${h(c&&c.note||'')}" style="flex:1;min-width:200px;min-height:32px"></div>`; }).join('')
      : `<div class="empty">Asnjë veprim në zbatim sot.${soon.length? ' Të ardhshmet: '+soon.map(a=>'#'+a.no+' '+h(a.title)+' ('+planD(a.startDate)+')').join(' · ') : ''}</div>`}
    <div class="hint">Shënimi ditor tregon nëse veprimi u aplikua në terren; efekti në shifra shihet te "KPI & efekti". Shënimet ruhen menjëherë.</div></div>`;
  $$('[data-pck]').forEach(b=>b.onclick=()=>{ const [id,v]=b.dataset.pck.split('|'); planSetCheck(id, today, v, ($(`[data-pnote="${id}"]`)||{}).value||''); planDraw(); toast('U shënua'); });
  $$('[data-pnote]').forEach(el=>el.onchange=()=>{ const id=el.dataset.pnote, c=Store.col('planChecks').find(x=>x.actionId===id && x.date===today); if(c){ Store.update('planChecks', c.id, {note:el.value.trim()}); toast('Shënimi u ruajt'); } else toast('Zgjidh fillimisht Po / Pjesërisht / Jo'); });
}
function planSetCheck(actionId, date, result, note){
  const c=Store.col('planChecks').find(x=>x.actionId===actionId && x.date===date);
  if(c) Store.update('planChecks', c.id, {result, note:note.trim()}); else Store.insert('planChecks', {actionId, date, result, note:note.trim()});
  const a=Store.get('planActions', actionId); if(a && a.status==='Pa filluar') Store.update('planActions', actionId, {status:'Në zbatim'});
}

/* actions: status, adherence and the measured effect on the linked KPIs */
function planDrawActions(body, acts){
  const K={}; Store.col('planKpis').forEach(k=>K[k.key]=k);
  body.innerHTML=`<div class="tablewrap"><table><thead><tr><th>#</th><th class="wrap">Veprimi</th><th>Pronari</th><th>Fillimi</th><th>Statusi</th><th>Zbatimi</th><th class="wrap">Efekti në KPI (baza → pas fillimit)</th><th></th></tr></thead><tbody>
    ${acts.map(a=>{ const ad=planAdherence(a);
      const eff=(a.kpis||[]).map(key=>{ const k=K[key]; if(!k) return ''; const e=planEffect(a,k);
        return `<div class="small">${h(k.short||k.name)}: ${e&&e.after!=null? `${planFmt(k,k.baseline)} → <b>${planFmt(k,e.after)}</b> <span style="color:${e.better?'var(--ok)':'var(--crit)'}">${e.delta>0?'▲':'▼'} ${planFmt(k,Math.abs(e.delta))}</span>${e.days<3? ' <span class="faint">(pak ditë)</span>' : ''}` : '<span class="faint">pa të dhëna pas fillimit</span>'}</div>`; }).join('') || '<span class="small faint">pa KPI të lidhur</span>';
      return `<tr><td><b>${a.no}</b></td><td class="wrap"><b>${h(a.title)}</b><div class="small faint">${h(a.action)}</div></td><td class="small">${h(a.owner||'—')}</td>
        <td class="small">${a.startDate? planD(a.startDate) : '—'}</td><td><span class="badge ${a.status==='Zbatuar'?'b-ok':a.status==='Në zbatim'?'b-warn':a.status==='Pezulluar'?'b-crit':'b-muted'}">${h(a.status)}</span></td>
        <td class="small">${ad&&ad.pct!=null? '<b>'+ad.pct+' %</b> ('+ad.got+'/'+ad.exp+' ditë)' : '—'}</td><td class="wrap">${eff}</td>
        <td><button class="btn sm" data-pedit="${a.id}">Ndrysho</button> <button class="btn sm ghost" data-phist="${a.id}">Historiku</button></td></tr>`; }).join('')}</tbody></table></div>
    <div class="hint">Zbatimi = ditët e shënuara "Po" (1) dhe "Pjesërisht" (½) nga ditët e punës që nga fillimi. Efekti = KPI-ja nga data e fillimit deri dje (Hën–Pre, i njëjti përkufizim si baza). Kur disa veprime lidhen me të njëjtin KPI, efekti është i përbashkët — mos e mbledh dy herë.</div>`;
  $$('[data-pedit]').forEach(b=>b.onclick=()=>planEditAction(Store.get('planActions', b.dataset.pedit)));
  $$('[data-phist]').forEach(b=>b.onclick=()=>planActionHistory(Store.get('planActions', b.dataset.phist)));
}
function planEditAction(a){
  openForm({title:'#'+a.no+' '+a.title, values:a, fields:[
    {name:'owner',label:'Pronari / kush e bën',type:'text'},
    {name:'when',label:'Kur / ku',type:'text',row:'a'}, {name:'startDate',label:'Data e fillimit',type:'date',noToday:true,row:'a'},
    {name:'status',label:'Statusi',type:'select',options:PLAN_STATUS,required:true},
    {name:'action',label:'Veprimi',type:'textarea',rows:3}, {name:'notes',label:'Shënime',type:'textarea',rows:2}],
    onSave:(vals)=>{ Store.update('planActions', a.id, vals); closeModal(); toast('U ruajt'); planDraw(); }});
}
function planActionHistory(a){
  const ch=Store.col('planChecks').filter(c=>c.actionId===a.id).sort((x,y)=>x.date<y.date?1:-1);
  const K={}; Store.col('planKpis').forEach(k=>K[k.key]=k);
  openModal('#'+a.no+' '+a.title, `<div class="note small"><b>Problemi:</b> ${h(a.problem)}<br><b>Ndikimi i pritur:</b> ${h(a.impact)}<br><b>Përpjekja:</b> ${h(a.effort)} · <b>Siguria:</b> ${h(a.risk)}<br><b>Matja:</b> ${h(a.measure)}</div>
    ${(a.kpis||[]).map(key=>{ const k=K[key]; if(!k) return ''; const e=planEffect(a,k); return `<div class="small" style="margin:4px 0"><b>${h(k.name)}</b>: baza ${planFmt(k,k.baseline)}${e&&e.before!=null? ' · 5 ditët para fillimit '+planFmt(k,e.before) : ''}${e&&e.after!=null? ' · pas fillimit <b>'+planFmt(k,e.after)+'</b> ('+e.days+' ditë)' : ' · pa të dhëna pas fillimit'}</div>`; }).join('')}
    <div class="formsection">Shënimet ditore (${ch.length})</div>
    ${ch.map(c=>{ const r=PLAN_RES.find(x=>x[0]===c.result)||['','—','b-muted']; return `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--line)">${fmtDateAl(c.date)} <span class="badge ${r[2]}">${r[1]}</span> ${h(c.note||'')}</div>`; }).join('')||'<div class="small faint">Ende pa shënime.</div>'}`,
    `<button class="btn ghost" id="mcancel">Mbyll</button>`);
  $('#mcancel').onclick=closeModal;
}

/* KPIs: baseline → week 1/2/3 actual vs target, with the trend and the action start dates */
function planSpark(k){
  const m=planBn&&planBn.metrics&&planBn.metrics[k.key]; const c=planCfg();
  const s=((m&&m.series)||[]).filter(x=>planWd(x.d) && x.v!=null && x.d>=planAdd(c.start,-28)); if(s.length<2) return '<div class="small faint">Seri e pamjaftueshme.</div>';
  const W=560, H=120, P=26, vals=s.map(x=>+x.v), tg=k.targets.filter(t=>t!=null);
  const max=Math.max(...vals, k.baseline||0, ...tg)*1.08, min=Math.min(...vals, k.baseline||0, ...tg)*0.92;
  const X=i=>P+i*(W-2*P)/(s.length-1), Y=v=>H-16-(v-min)/((max-min)||1)*(H-30);
  const xOf=d=>{ const i=s.findIndex(x=>x.d>=d); return i<0? null : X(i); };
  const starts=Store.col('planActions').filter(a=>a.startDate && (a.kpis||[]).includes(k.key)).map(a=>({x:xOf(a.startDate), no:a.no})).filter(o=>o.x!=null);
  const steps=(c.weeks||[]).map(w=>({x1:xOf(w.from), x2:xOf(planAdd(w.to,1))||W-P, t:k.targets[w.n-1]})).filter(o=>o.x1!=null && o.t!=null);
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto">
    ${k.baseline!=null? `<line x1="${P}" x2="${W-P}" y1="${Y(k.baseline)}" y2="${Y(k.baseline)}" stroke="var(--muted)" stroke-dasharray="2 3"/><text x="${P}" y="${Y(k.baseline)-3}" font-size="9" fill="var(--muted)">baza</text>` : ''}
    ${steps.map(o=>`<line x1="${o.x1}" x2="${o.x2}" y1="${Y(o.t)}" y2="${Y(o.t)}" stroke="var(--ok)" stroke-width="2"/>`).join('')}
    ${starts.map(o=>`<line x1="${o.x}" x2="${o.x}" y1="8" y2="${H-16}" stroke="var(--warn)" stroke-dasharray="3 3"/><text x="${o.x+2}" y="14" font-size="9" fill="var(--warn)">#${o.no}</text>`).join('')}
    <polyline points="${s.map((x,i)=>X(i)+','+Y(+x.v)).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${s.map((x,i)=>`<circle cx="${X(i)}" cy="${Y(+x.v)}" r="2.3" fill="var(--accent)"><title>${planD(x.d)}: ${planFmt(k,+x.v)}</title></circle>`).join('')}
    <text x="${P}" y="${H-3}" font-size="9" fill="var(--faint)">${planD(s[0].d)}</text><text x="${W-P}" y="${H-3}" font-size="9" fill="var(--faint)" text-anchor="end">${planD(s[s.length-1].d)}</text></svg>`;
}
function planDrawKpi(body){
  const c=planCfg(), kpis=Store.col('planKpis').slice().sort((a,b)=>a.no-b.no), y=planAdd(planToday(),-1);
  body.innerHTML=kpis.map(k=>{ const cells=(c.weeks||[]).map(w=>{ const started=w.from<=y; const v= started? planKpiValue(k, w.from, w.to<y? w.to : y) : {v:null}; const t=k.targets[w.n-1]; const ok=planOnTarget(k,v.v,t);
      return `<td style="text-align:center">${started&&v.v!=null? `<b style="color:${ok?'var(--ok)':'var(--warn)'}">${planFmt(k,v.v)}</b>` : '<span class="faint">—</span>'}<div class="small faint">target ${t!=null? (k.better==='higher'?'≥ ':'≤ ')+planFmt(k,t) : h(k.targetText||'—')}</div></td>`; }).join('');
    return `<div class="card" style="margin-bottom:12px"><h3>${h(k.name)} <span class="sub">${h(k.source)}</span></h3>
      <div class="tablewrap" style="margin-bottom:8px"><table style="min-width:520px"><thead><tr><th>Baza (05.09–02.10)</th>${(c.weeks||[]).map(w=>`<th style="text-align:center">Java ${w.n}<div class="small faint">${planD(w.from)}–${planD(w.to)}</div></th>`).join('')}</tr></thead>
      <tbody><tr><td><b>${planFmt(k,k.baseline)}</b>${k.baseNote? '<div class="small faint">'+h(k.baseNote)+'</div>' : ''}</td>${cells}</tr></tbody></table></div>
      ${k.key!=='safety'? planSpark(k) : '<div class="small faint">Numërohen problemet e kategorisë Siguri të regjistruara në javë (Bottleneck Register → Problem nga terreni).</div>'}
      <div class="small faint">Veprimet e lidhura: ${Store.col('planActions').filter(a=>(a.kpis||[]).includes(k.key)).sort((x,y)=>x.no-y.no).map(a=>'#'+a.no+' '+h(a.title)+(a.startDate? ' ('+planD(a.startDate)+')' : '')).join(' · ')||'—'}</div></div>`; }).join('')
    + `<div class="hint">Vlera e javës: Hën–Pre deri dje; normat (porosi/orë, njësi/orë, %) = shuma e numëruesit ÷ shuma e emëruesit; ora e skanimit të parë = mediana. Vija gri = baza, vija jeshile = targeti i javës, vijat portokalli = fillimi i veprimeve (#).</div>`;
}
function planDrawWeeks(body){
  const c=planCfg();
  body.innerHTML=(c.weeks||[]).map(w=>`<div class="card" style="margin-bottom:12px"><h3>Java ${w.n} — ${h(w.title)} <span class="sub">${fmtDateAl(w.from)} – ${fmtDateAl(w.to)}</span></h3>
    <div class="small" style="margin-bottom:6px">${(w.goals||[]).map(g=>'• '+h(g)).join('<br>')}</div>
    <div class="formsection">Pikat e kontrollit</div>
    ${(w.checkpoints||[]).map((p,i)=>`<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--line)">
      <input type="checkbox" data-pcp="${w.n}|${i}" ${p.done?'checked':''} style="width:auto;min-height:auto"><span class="small" style="flex:1">${h(p.text)}${p.when? ' <span class="faint">('+h(p.when)+')</span>' : ''}</span>
      <input type="text" data-pcpr="${w.n}|${i}" value="${h(p.result||'')}" placeholder="rezultati" style="width:220px;min-height:30px"></div>`).join('')}</div>`).join('');
  const save=(n,i,patch)=>{ const cfg=JSON.parse(JSON.stringify(planCfg())); const w=cfg.weeks.find(x=>x.n===+n); Object.assign(w.checkpoints[+i], patch, {at:nowISO()}); Store.db.config.plan=cfg; Store.persist(); };
  $$('[data-pcp]').forEach(el=>el.onchange=()=>{ const [n,i]=el.dataset.pcp.split('|'); save(n,i,{done:el.checked}); toast(el.checked?'Pika e kontrollit u shënua':'U hoq shënimi'); });
  $$('[data-pcpr]').forEach(el=>el.onchange=()=>{ const [n,i]=el.dataset.pcpr.split('|'); save(n,i,{result:el.value.trim()}); toast('Rezultati u ruajt'); });
}
function planDrawReport(body){
  const c=planCfg();
  body.innerHTML=`<div class="card" style="margin-bottom:12px"><h3>Përmbledhja</h3>${(c.summary||[]).map(s=>`<div class="small" style="margin:4px 0">• ${h(s)}</div>`).join('')}</div>
    <div class="card" style="margin-bottom:12px"><h3>Rruga drejt 1.000 porosive/ditë</h3><div class="tablewrap"><table><thead><tr><th>Hapi</th><th>Orë për 1.000</th><th>Orë në dispozicion</th><th>Kapaciteti</th></tr></thead><tbody>
      ${(c.path||[]).map(p=>`<tr><td class="small">${h(p.step)}</td><td>${h(p.hours)}</td><td>${h(p.avail)}</td><td><b>${h(p.cap)}</b></td></tr>`).join('')}</tbody></table></div>
      <div class="small" style="margin-top:6px">${(c.scenarios||[]).map(s=>`<b>${h(s.name)}</b>: ${h(s.text)}`).join('<br>')}</div></div>
    <div class="card"><h3>Të dhënat që mungojnë</h3>${(c.missing||[]).map(m=>`<div class="small" style="margin:5px 0"><b>${h(m.what)}</b> — ${h(m.why)}<div class="faint">Si: ${h(m.how)}</div></div>`).join('')}
      <div class="hint">Raporti i plotë: reports/plan-produktiviteti-2026-10-03.md (lokal). Burimet: WMS (vetëm lexim) dhe ky app; personat me iniciale.</div></div>`;
}

/* Tabela ditore — the standalone board page /tabela (for the screen at the entrance), shown here in a frame like "Orari i punës" */
function renderPostat(v){
  v.innerHTML = pagehead('Postat — në pritje', 'Porositë që presin dërgimin për POD final, sipas postës: sa janë, sipas pagesës dhe kohës së pritjes, dhe ato mbi 3 ditë me të kuqe. Hape si faqe më vete për ekranin e POD-it (⛶ ekran i plotë; rifreskohet vetë çdo 2 minuta).', `<button class="btn" id="postOpen">↗ Hap si faqe më vete</button>`)
    + `<iframe id="postFrame" src="/postat" style="width:100%;height:calc(100vh - 170px);min-height:560px;border:1px solid var(--line);border-radius:12px;background:var(--panel)"></iframe>`;
  $('#postOpen').onclick=()=>window.open('/postat','postat');
}
function renderTabela(v){
  v.innerHTML = pagehead('Tabela ditore',
    'Tabela në hyrje: porosi/orë për tavolinë me emrin e operatorit (live nga WMS, çdo 2 min), carryover i djeshëm dhe porositë e gatshme deri 13:00 · 15:00 · 17:30 (databaza e WMS, çdo orë). Për ekranin në hyrje hape si faqe më vete: <b>http://localhost:8790/tabela</b>.',
    `<button class="btn" id="tabOpen">↗ Hap si faqe më vete</button>`)
    + `<iframe id="tabFrame" src="/tabela" style="width:100%;height:calc(100vh - 170px);min-height:560px;border:1px solid var(--line);border-radius:12px;background:var(--panel)"></iframe>`;
  $('#tabOpen').onclick=()=>window.open('/tabela','tabela');
}
