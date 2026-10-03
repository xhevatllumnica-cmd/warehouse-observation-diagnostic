/* =========================================================================
   PROBLEM / BOTTLENECK REGISTER — the register of problems and bottlenecks, from detection to a measured close.
   Data: /bn/data from the agent (bottleneck/: WmsDataAdapter snapshots of the WMS queries D1–D13 + the detectors).
   Records live in the existing Store collection "problems" (so the Dashboard, reports, Validation and Search keep
   working): every record carries the register fields (BN-YYYY-###, phase, category, evidence with snapshot, RPN,
   priority, hypotheses, 5 Why / Ishikawa, Gemba plan, actions, effect, history) and the legacy fields are kept in step
   (problem, severity, priorityScore, status, processId, cause, evidence, impact, frequency, relatedKPI).
   Candidates become problems only when the lead accepts / merges them; dismissals keep their reason (bnDecisions).
   A problem closes only when its metric stayed on target for at least 14 days, measured with the same query.
   Loaded after shared.js and before app.js; uses app.js helpers at call time.
   =======================================================================*/
const BN_PHASES=['Claim','Picking','Checkout/Packing','Boxing','Inbounding','Check-in','Mapping','Inventar','Të gjitha'];
const BN_PHASE_PROC={'Claim':'Claim','Picking':'Picking','Checkout/Packing':'Packing/Check-out','Boxing':'Boxing','Inbounding':'Receiving','Check-in':'Check-in','Mapping':'Mapping','Inventar':'Inventory'};
const BN_CATS=['Njerëz','Proces','Layout-Hapësirë','Pajisje','Sistem-WMS','Të dhëna','Inbound-Furnitor','Transport','Siguri'];
const BN_STATUS=['I hapur','Në analizë','Në veprim','Në verifikim','I mbyllur','I rihapur','Hedhur poshtë'];
const BN_TO_LEGACY={'I hapur':'Open','Në analizë':'Under validation','Në veprim':'In progress','Në verifikim':'In progress','I mbyllur':'Resolved','I rihapur':'Open','Hedhur poshtë':'Rejected'};
const BN_FROM_LEGACY={'Open':'I hapur','Under validation':'Në analizë','Validated':'Në analizë','In progress':'Në veprim','Resolved':'I mbyllur','Rejected':'Hedhur poshtë'};
const BN_OBJECTIVES=['Siguri','Same-day','Kosto për porosi','Ekipi'];
const BN_OBJ_KPI={'Siguri':'Safety','Same-day':'Same-day shipping','Kosto për porosi':'Cost per order','Ekipi':'Staffing / shift discipline'};
const BN_6M=['Njeri','Metodë','Makineri','Material','Matje','Mjedis'];
const BN_SOURCES=['Vëzhgim në terren','D1','D2','D3','D4','D5','D6','D7','D8','D9','D10','D11','D12','D13'];
const BN_DET_NAMES={D1:'Carryover',D2:'Lead time porosi → check-out',D3:'Rrjedha për orë / kufizimi',D4:'Pritja për mapping',D5:'Picking & koha e ciklit',D6:'Produktiviteti',
  D7:'Cilësia e të dhënave',D8:'Inbound',D9:'Saktësia e inventarit',D10:'Hapësira / lokacioni',D11:'Transporti',D12:'Mosha e porosive sipas statusit',D13:'Kosto për porosi'};
const BN_CLOSE_DAYS=14;
const BN_PARAM_LABELS={wh:['Depoja (WarehouseId)','1 = Prishtinë'], pf:['Platforma','0 = të dyja, 1 = GjirafaMall, 2 = Gjirafa50'], nd:['Ditë historie','7 ditë aktuale + 4 javë baseline = 35'],
  ma:['Mosha maksimale e problemit (ditë kalendarike)','vetëm ngjarjet e WMS-it të këtyre ditëve bëhen kandidatë; mbetjet më të vjetra shfaqen vetëm si shënim'],
  co:['Cut-off','HH:MM — pas kësaj ore nuk ka inbound'], mh:['Pritja për mapping (orë)','njësitë mbi këtë moshë numërohen si në pritje'], sh:['Furnizim i ngecur pas (orë)',''], gm:['Boshllëk (min)','pa skanime mes dy veprimeve']};
const BN_TH_LABELS={ roster:'Ekipi i planifikuar (operatorë)', breakMin:'Pushimi për person-ditë (min)', minN:'n minimal për besueshmëri të lartë',
  carryMax:'D1 Carryover i lejuar (porosi/ditë)', leadP50Max:'D2 Mediana max porosi → check-out (orë)', leadRisePct:'D2 Rritja e p90 mbi baseline (%)', utilMax:'D3 Shfrytëzimi që shënon kufizimin (%)',
  mapWaitMax:'D4 Njësi në pritje për mapping (max)', mapP90Max:'D4 Check-in → mapping p90 (min)', cycleTolPct:'D5 Toleranca mbi standardin (%)', declinePct:'D6 Rënia javë pas jave (%)',
  gapMax:'D6 Boshllëqe/person-ditë pas pushimit (min)', bandHi:'D6 Banda "mbi" (× mesatarja)', bandLo:'D6 Banda "nën" (× mesatarja)', sharedMax:'D7 Skanime me llogari temp (%)',
  noUserMax:'D7 Skanime pa përdorues/ditë', only27Max:'D7 Porosi vetëm me 27', unknownTypePct:'D7 LogTypeId të panjohura (%)', supplyStuckMax:'D8 Furnizime të ngecura (max)',
  supplyStaleMax:'D8 Furnizime > 30 ditë (max)', staleDays:'D9/D10 Burim i ndalur pas (ditë)', missPctMax:'D9 Mungesa në inspektim (%)', rowFactor:'D10 Rresht i mbingarkuar (× mediana)',
  lateMax:'D11 Transport lokal: ndalesa me vonesë (%)', lateIntlMax:'D11 Transport ndërkombëtar: me vonesë, 30 ditë (%)', openIntlMax:'D11 Ndërkombëtare pa mbërritje pas datës (max)',
  palletPctMin:'D11 Ndërkombëtare me palet të regjistruara (min %)', noPriceMax:'D11 Ndërkombëtare pa çmim, 3 muaj (max)', ageMax:'D12 Porosi > 3 ditë pa check-out (për status)', costMax:'D13 Objektivi €/porosi (bosh = pa objektiv)', costRisePct:'D13 Rritja e lejuar (%)',
  p1:'RPN për P1 (≥)', p2:'RPN për P2 (≥)' };

let bnData=null, bnTab='register', bnFilt={status:'aktive', prio:'', phase:'', cat:'', owner:''}, bnLoading=false;

/* ------------------------------------------------------------- model helpers */
function bnCfg(){ return (Store.db.config||{}).bottleneck||{}; }
function bnTh(){ return Object.assign({p1:64,p2:27}, (bnData&&bnData.defaults)||{}, bnCfg().thresholds||{}); }
const bnClamp=v=>Math.max(1,Math.min(5,Math.round(+v||1)));
function bnRpn(p){ return bnClamp(p.sev)*bnClamp(p.occ)*bnClamp(p.det); }
function bnPrio(p){ if(p.category==='Siguri') return 'P1'; const r=bnRpn(p), t=bnTh(); return r>=t.p1? 'P1' : r>=t.p2? 'P2' : 'P3'; }
function bnNextId(year){
  const re=new RegExp('^BN-'+year+'-(\\d+)$'); let max=0;
  Store.col('problems').forEach(p=>{ const m=re.exec(p.bnId||''); if(m) max=Math.max(max,+m[1]); });
  return 'BN-'+year+'-'+String(max+1).padStart(3,'0');
}
function bnProcId(phase){ const name=BN_PHASE_PROC[phase]; if(!name) return ''; const p=Store.col('processes').find(x=>x.name===name); return p? p.id : ''; }
/* fill the register fields of a record that does not have them yet, and keep the legacy fields in step */
function bnNormalize(rec){
  if(!rec.bnId) rec.bnId=bnNextId((rec.dateIdentified||todayStr()).slice(0,4));
  if(!rec.title) rec.title=rec.problem||'';
  if(!rec.phase){ const pn=(Store.get('processes',rec.processId)||{}).name; rec.phase=Object.keys(BN_PHASE_PROC).find(k=>BN_PHASE_PROC[k]===pn)||'Të gjitha'; }
  if(!rec.category) rec.category=({People:'Njerëz',Process:'Proces',Technology:'Sistem-WMS',Material:'Inbound-Furnitor',Layout:'Layout-Hapësirë',Management:'Proces',Capacity:'Proces'})[(rec.rca||{}).category]||'Proces';
  if(!rec.symptom) rec.symptom=rec.problem||'';
  if(!rec.source) rec.source='Vëzhgim në terren';
  if(!Array.isArray(rec.bnEvidence)) rec.bnEvidence= rec.evidence? [{kind:'text', text:String(rec.evidence), at:rec.createdAt||nowISO()}] : [];
  if(!rec.objective){ const k=String(rec.relatedKPI||''); rec.objective=/safety/i.test(k)? 'Siguri' : /cost/i.test(k)? 'Kosto për porosi' : /staff|attendance/i.test(k)? 'Ekipi' : 'Same-day'; }
  if(rec.impactText==null) rec.impactText=rec.impact||'';
  if(rec.sev==null) rec.sev=({Critical:5,Important:4,Improvement:3,Minor:2})[rec.severity]||3;
  if(rec.occ==null) rec.occ=bnClamp(rec.frequency||1);
  if(rec.det==null) rec.det=3;
  if(!Array.isArray(rec.hypotheses)) rec.hypotheses= rec.cause? [{text:String(rec.cause), status:'HIPOTEZË'}] : [];
  if(!rec.whys) rec.whys=((rec.rca||{}).whys)||['','','','',''];
  if(!rec.ishikawa) rec.ishikawa={};
  if(!rec.verify) rec.verify={what:'',where:'',when:'',duration:''};
  if(!Array.isArray(rec.gemba)) rec.gemba=[];
  if(!rec.bnStatus) rec.bnStatus=BN_FROM_LEGACY[rec.status]||'I hapur';
  if(!Array.isArray(rec.history)) rec.history=[];
  if(!rec.effect) rec.effect={metricKey:null, startDate:null, before:null};
  bnSyncLegacy(rec); return rec;
}
function bnSyncLegacy(rec){
  rec.rpn=bnRpn(rec); rec.priority=bnPrio(rec);
  rec.problem=rec.title; rec.priorityScore=rec.rpn; rec.status=BN_TO_LEGACY[rec.bnStatus]||'Open';
  rec.severity={P1:'Critical',P2:'Important',P3:'Improvement'}[rec.priority];
  rec.processId=bnProcId(rec.phase)||rec.processId||''; rec.frequency=bnClamp(rec.occ);
  rec.cause=(rec.hypotheses||[]).filter(h=>h.status!=='E hedhur poshtë').map(h=>(h.status==='E konfirmuar'? '[konfirmuar] ' : '')+h.text).join(' · ');
  rec.evidence=(rec.bnEvidence||[]).map(e=>e.kind==='text'? e.text : `${e.detector}: ${e.value} ${e.unit||''} (baseline ${e.baseline??'—'}, prag ${e.threshold??'—'}, ${e.periodText||''})`).join(' | ');
  rec.impact=rec.impactText; rec.relatedKPI=BN_OBJ_KPI[rec.objective]||rec.relatedKPI||'';
  rec.location=rec.zone||rec.location||'';
}
/* one-time, additive: existing register entries get the new fields (called from Store.load) */
function bnMigrate(db){
  db.config=db.config||{}; db.config.migrations=db.config.migrations||{};
  if(db.config.migrations.bnRegister) return false;
  const prev=Store.db; Store.db=db;                                         // bnNormalize reads ids/processes through Store
  try{ (db.problems||[]).slice().reverse().forEach(p=>{ if(!p.bnId){ bnNormalize(p); p.history.push({at:nowISO(), text:'Migruar nga regjistri i mëparshëm (fushat e vjetra u ruajtën).'}); } }); }
  finally{ Store.db=prev; }
  db.config.migrations.bnRegister=true; return true;
}
function bnHist(rec, text){ rec.history=(rec.history||[]).concat([{at:nowISO(), by:Store.db.config.currentUser||'', text}]); }
function bnSave(rec, histText){ bnNormalize(rec); if(histText) bnHist(rec, histText); bnSyncLegacy(rec);
  const ex=Store.get('problems', rec.id); if(ex) Store.update('problems', rec.id, rec); else Store.insert('problems', rec); return rec; }
const bnPBadge=p=>`<span class="badge ${p==='P1'?'b-crit':p==='P2'?'b-imp':'b-warn'}">${p}</span>`;
const bnStBadge=s=>`<span class="badge ${({'I hapur':'b-new','Në analizë':'b-warn','Në veprim':'b-imp','Në verifikim':'b-valid','I mbyllur':'b-ok','I rihapur':'b-crit','Hedhur poshtë':'b-muted'})[s]||'b-muted'}">${h(s)}</span>`;
const bnConfBadge=c=>`<span class="badge ${c==='e lartë'?'b-ok':c==='e mesme'?'b-warn':'b-crit'}" title="Besueshmëria (n, periudha)">besueshmëri ${h(c||'—')}</span>`;
const bnFmtN=v=> v==null||v===''? '—' : typeof v==='number'? (Math.abs(v)>=100? Math.round(v).toLocaleString('de-DE') : String(Math.round(v*10)/10).replace('.',',')) : h(v);
const bnFmtAt=iso=>{ if(!iso) return '—'; const d=new Date(iso); if(isNaN(d)) return h(iso); const p=n=>String(n).padStart(2,'0'); return p(d.getDate())+'.'+p(d.getMonth()+1)+' '+p(d.getHours())+':'+p(d.getMinutes()); };
const bnPeriod=p=> !p? '' : (p.from&&p.to? fmtDateAl(p.from)+' – '+fmtDateAl(p.to) : p.to? 'deri '+fmtDateAl(p.to) : p.from||'');

/* ------------------------------------------------------------- data */
async function bnLoad(refresh){
  if(bnLoading) return; bnLoading=true;
  try{ const r=await fetch('/bn/data'+(refresh?'?refresh=1':''),{cache:'no-store'}); bnData=await r.json(); }
  catch(e){ bnData={error:'Agjenti nuk përgjigjet ('+e.message+').'}; }
  finally{ bnLoading=false; }
  if($('#bnBody')) bnDraw();
}
function bnDecisions(){ return Store.col('bnDecisions'); }
/* candidates still waiting for a decision (a dismissed one comes back when its value got 20% worse; an accepted one
   whose problem was closed comes back as "reopen") */
function bnOpenCandidates(){
  if(!bnData||!bnData.candidates) return [];
  const dec={}; bnDecisions().forEach(d=>{ if(!dec[d.key] || dec[d.key].at<d.at) dec[d.key]=d; });
  return bnData.candidates.map(c=>{ const d=dec[c.key]; if(!d) return c;
    if(d.action==='dismissed'){ const worse= c.better==='higher'? c.value<d.value*0.8 : c.value>d.value*1.2; return worse? Object.assign({}, c, {resurfaced:'Hedhur poshtë më '+fmtDateAl((d.at||'').slice(0,10))+' ('+d.reason+'), por vlera u përkeqësua: '+d.value+' → '+c.value}) : null; }
    const p=Store.get('problems', d.problemId);
    if(p && p.bnStatus==='I mbyllur') return Object.assign({}, c, {reopen:p.id});
    return null; }).filter(Boolean);
}

/* ------------------------------------------------------------- page */
function renderBottleneck(v){
  v.innerHTML = pagehead('Problem / Bottleneck Register',
    'Identifikon, kuantifikon dhe ndjek deri në mbyllje problemet dhe pikat e ngushta. Detektorët D1–D13 lexojnë WMS-in (vetëm SELECT) dhe propozojnë <b>kandidatë</b>; një kandidat bëhet problem vetëm kur e pranon. Të dhënat tregojnë <b>simptomën</b> — shkaku konfirmohet në Gemba. RPN = Ashpërsia × Shpeshtësia × Zbulueshmëria; Siguria është gjithmonë P1.',
    `<button class="btn" id="bnRefresh" title="Rilexo snapshot-in e fundit nga agjenti">⟳ Rifresko</button><button class="btn primary" id="bnAdd">＋ Problem nga terreni</button>`)
    + `<div id="bnTop"></div><div class="btnrow no-print" id="bnTabs" style="margin:12px 0"></div><div id="bnBody"><div class="empty">Po ngarkohet…</div></div>`;
  $('#bnAdd').onclick=()=>bnOpenForm(null,{source:'Vëzhgim në terren'});
  $('#bnRefresh').onclick=()=>{ bnLoad(true); toast('Po rifreskohet…'); };
  if(!wmsOnAgent()){ $('#bnBody').innerHTML='<div class="card"><div class="empty">Hape app-in nga http://localhost:8790 — detektorët lexojnë të dhënat nga agjenti.</div></div>'; bnData={candidates:[]}; bnDraw(); return; }
  if(bnData && !bnData.error) bnDraw();
  bnLoad(false);
}
function bnDraw(){
  const body=$('#bnBody'); if(!body) return;
  const cands=bnOpenCandidates(), regN=Store.col('problems').filter(p=>!['I mbyllur','Hedhur poshtë'].includes(p.bnStatus)).length;
  const tabs=[['register','Regjistri ('+regN+')'],['candidates','Kandidatët e rinj ('+cands.length+')'],['constraint','Kufizimi i sistemit'],['data','Të dhënat & query-t'],['settings','Cilësimet'],['export','Eksport / raport javor']];
  $('#bnTabs').innerHTML=tabs.map(([k,l])=>`<button class="btn sm ${bnTab===k?'primary':''}" data-bntab="${k}">${l}</button>`).join('');
  $$('[data-bntab]').forEach(b=>b.onclick=()=>{ bnTab=b.dataset.bntab; bnDraw(); });
  $('#bnTop').innerHTML=bnTopHTML();
  $$('#bnTop [data-bntab]').forEach(b=>b.onclick=()=>{ bnTab=b.dataset.bntab; bnDraw(); });
  if(bnData&&bnData.error && bnTab!=='register' && bnTab!=='settings'){ body.innerHTML=`<div class="card"><div class="empty">${h(bnData.error)}</div></div>`; return; }
  ({register:bnDrawRegister, candidates:bnDrawCandidates, constraint:bnDrawConstraint, data:bnDrawData, settings:bnDrawSettings, export:bnDrawExport})[bnTab](body);
}
function bnTopHTML(){
  if(!bnData) return '';
  if(bnData.error) return `<div class="note warn">${h(bnData.error)}</div>`;
  if(bnData.empty) return `<div class="note warn">Asnjë snapshot ende. Query-t D1–D13 ekzekutohen nga detyra e planifikuar në orët 07, 13 dhe 18, ose kërkoja Claude-it: «ekzekuto query-t e Bottleneck Register».</div>`;
  const c=bnData.constraint, ages=Object.values(bnData.blocks||{}).map(b=>b.at).sort(), oldest=ages[0], stale= oldest && (Date.now()-Date.parse(oldest))>26*3600e3;
  const top= c&&c.top? c.phases.find(p=>p.k===c.top) : null;
  return `<div class="card" style="margin-bottom:6px;border-left:3px solid var(--crit)">
      <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><b>⛓ Kufizimi i sistemit (D3):</b>
        <span>${top? `<b>${h(top.name)}</b> — ${h(c.text.split(': ').slice(1).join(': '))}${top.wip!=null? ' · WIP '+bnFmtN(top.wip)+' '+h(top.unit) : ''}` : h(c? c.text : 'pa të dhëna')}</span>
        <span class="etag et-hyp">hipotezë e të dhënave — konfirmo në Gemba</span>
        <button class="btn sm ghost" data-bntab="constraint" style="margin-left:auto">Shiko heatmap-in →</button></div>
      <div class="small faint" style="margin-top:4px">Përmirësimi jashtë kufizimit nuk e rrit output-in e depos. · Problemet: vetëm ngjarje të ${bnData.ageLimit? bnData.ageLimit.days : 30} ditëve të fundit · Snapshot ${h(bnData.snapshotId||'—')} · të dhënat ${h(bnPeriod({from:bnData.windows&&bnData.windows.base.from,to:bnData.windows&&bnData.windows.cur.to}))}
        ${stale? ' · <span style="color:var(--warn)">⚠ disa blloqe janë më të vjetra se 26 orë</span>' : ''}</div></div>`;
}

/* ------------------------------------------------------------- Register */
function bnDrawRegister(body){
  const all=Store.col('problems').map(p=>{ if(!p.bnId) bnNormalize(p); return p; });
  const owners=[...new Set(all.map(p=>p.owner).filter(Boolean))];
  const f=bnFilt;
  let rows=all.filter(p=>(f.status==='aktive'? !['I mbyllur','Hedhur poshtë'].includes(p.bnStatus) : !f.status || p.bnStatus===f.status)
    && (!f.prio||p.priority===f.prio) && (!f.phase||p.phase===f.phase) && (!f.cat||p.category===f.cat) && (!f.owner||p.owner===f.owner));
  rows.sort((a,b)=>(a.priority>b.priority?1:a.priority<b.priority?-1:0) || bnRpn(b)-bnRpn(a));
  const sel=(id,opts,val,first)=>`<select id="${id}" style="width:auto;min-height:32px">${first?`<option value="">${first}</option>`:''}${opts.map(o=>{ const v=typeof o==='object'?o.v:o, l=typeof o==='object'?o.l:o; return `<option value="${h(v)}" ${String(val)===String(v)?'selected':''}>${h(l)}</option>`; }).join('')}</select>`;
  body.innerHTML=`<div class="card no-print" style="margin-bottom:10px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${sel('bnfStatus',[{v:'aktive',l:'Statusi: aktive'},...BN_STATUS],f.status,'Statusi: të gjitha')}
      ${sel('bnfPrio',['P1','P2','P3'],f.prio,'Prioriteti: të gjitha')}
      ${sel('bnfPhase',BN_PHASES,f.phase,'Faza: të gjitha')}
      ${sel('bnfCat',BN_CATS,f.cat,'Kategoria: të gjitha')}
      ${sel('bnfOwner',owners.map(o=>({v:o,l:empName(o)||'(punonjës i fshirë)'})),f.owner,'Pronari: të gjithë')}
      <span class="small faint" style="margin-left:auto">${rows.length} nga ${all.length} · renditur sipas prioritetit dhe RPN</span></div></div>
    <div class="tablewrap"><table><thead><tr><th>ID</th><th>P</th><th>RPN</th><th class="wrap">Titulli</th><th>Faza</th><th>Kategoria</th><th class="wrap">Ndikimi</th><th>Burimi</th><th>Pronari</th><th>Afati</th><th>Statusi</th><th></th></tr></thead><tbody>
    ${rows.length? rows.map(p=>{ const late=p.dueDate && p.dueDate<todayStr() && !['I mbyllur','Hedhur poshtë'].includes(p.bnStatus);
      return `<tr><td class="small"><b>${h(p.bnId)}</b></td><td>${bnPBadge(p.priority)}</td><td><b>${bnRpn(p)}</b><div class="small faint">${bnClamp(p.sev)}×${bnClamp(p.occ)}×${bnClamp(p.det)}</div></td>
        <td class="wrap">${h(p.title)}${p.category==='Siguri'?' <span class="badge b-crit">Siguri</span>':''}</td><td class="small">${h(p.phase)}${p.zone?'<div class="faint">'+h(p.zone)+'</div>':''}</td><td class="small">${h(p.category)}</td>
        <td class="wrap small">${h(p.impactText||'')}${p.objective?'<div class="faint">'+h(p.objective)+'</div>':''}</td><td class="small">${h(p.source)}</td>
        <td class="small">${h(empName(p.owner)||'—')}</td><td class="small" style="${late?'color:var(--crit);font-weight:600':''}">${p.dueDate?fmtDateAl(p.dueDate):'—'}</td>
        <td>${bnStBadge(p.bnStatus)}</td><td><button class="btn sm" data-bncard="${p.id}">Karta</button></td></tr>`; }).join('')
      : emptyRow(12, all.length? 'Asnjë problem me këta filtra.' : 'Regjistri është bosh. Prano një kandidat nga "Kandidatët e rinj" ose shto një problem nga vëzhgimi në terren.')}</tbody></table></div>`;
  [['bnfStatus','status'],['bnfPrio','prio'],['bnfPhase','phase'],['bnfCat','cat'],['bnfOwner','owner']].forEach(([id,k])=>$('#'+id).onchange=e=>{ bnFilt[k]=e.target.value; bnDraw(); });
  $$('[data-bncard]').forEach(b=>b.onclick=()=>bnOpenCard(b.dataset.bncard));
}

/* ------------------------------------------------------------- Candidates */
function bnCandEvidence(c){ return {kind:'detector', detector:c.detector, key:c.key, metricKey:c.metricKey, title:c.title, symptom:c.symptom, value:c.value, baseline:c.baseline,
  threshold:c.threshold, unit:c.unit, better:c.better, period:c.period, periodText:bnPeriod(c.period), baselinePeriod:c.baselinePeriod, scope:c.scope, n:c.n, confidence:c.confidence,
  snapshotId:c.snapshotId, blocks:c.blocks, tags:c.tags, at:nowISO()}; }
function bnCandCard(c){
  const tag=(cls,lbl,arr)=>(arr||[]).map(t=>`<div class="small" style="margin:3px 0"><span class="etag ${cls}">${lbl}</span> ${h(t)}</div>`).join('');
  return `<div style="padding:10px 0;border-top:1px solid var(--line)">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="badge b-new">${h(c.detector)} · ${h(BN_DET_NAMES[c.detector]||'')}</span><b>${h(c.title)}</b> ${bnConfBadge(c.confidence)}
      ${c.confidence==='e ulët'?'<span class="small" style="color:var(--warn)">⚠ n i ulët ose burim i pjesshëm — mos nxirr përfundime pa verifikim</span>':''}</div>
    <div class="small" style="margin:6px 0"><span class="etag et-fact">fakt</span> ${h(c.symptom)}</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:8px 0">
      ${[['Aktuale',bnFmtN(c.value)+' '+h(c.unit||'')],['Baseline (4 javë)',bnFmtN(c.baseline)],['Pragu',bnFmtN(c.threshold)],['n',bnFmtN(c.n)],['Periudha',h(bnPeriod(c.period))]].map(([l,v])=>`<div class="kpi" style="padding:8px 10px"><div class="lbl">${l}</div><div style="font-weight:700">${v}</div></div>`).join('')}</div>
    <div class="small faint">Scope: ${h(c.scope||'')} · <a href="#" data-bnsql="${h(c.snapshotId)}|${h((c.blocks||[])[0]||c.detector)}">query-t dhe snapshot-i ↗</a></div>
    <div class="small" style="margin:6px 0"><b>Ndikimi (${h(c.impact&&c.impact.objective||'')}):</b> ${h(c.impact&&c.impact.text||'')}</div>
    ${tag('et-fact','fakt',c.tags&&c.tags.fact)}${tag('et-hyp','hipotezë',c.tags&&c.tags.hyp)}${tag('et-obs','e pakonfirmuar',c.tags&&c.tags.unconfirmed)}
    <details style="margin-top:6px"><summary class="small">Hipotezat e shkakut (${(c.hypotheses||[]).length}) dhe pyetjet për Gemba (${(c.gemba||[]).length})</summary>
      ${(c.hypotheses||[]).map(x=>`<div class="small" style="margin:3px 0"><span class="etag et-hyp">hipotezë</span> ${h(x)}</div>`).join('')}
      ${(c.gemba||[]).map(x=>`<div class="small" style="margin:3px 0"><span class="etag et-obs">gemba</span> ${h(x)}</div>`).join('')}</details>
    ${c.resurfaced?`<div class="note warn small">${h(c.resurfaced)}</div>`:''}</div>`;
}
function bnDrawCandidates(body){
  const list=bnOpenCandidates();
  if(!bnData || bnData.empty){ body.innerHTML='<div class="card"><div class="empty">Asnjë snapshot ende — kandidatët shfaqen pas ekzekutimit të parë të query-ve D1–D13.</div></div>'; return; }
  if(!list.length){ body.innerHTML='<div class="card"><div class="empty">Asnjë kandidat i ri. Të gjithë janë pranuar, shkrirë ose hedhur poshtë — ose metrikat janë brenda pragjeve.</div></div>'; return; }
  const groups=[]; const seen={};
  list.forEach(c=>{ const g=c.group||c.key; if(!seen[g]){ seen[g]={g, items:[]}; groups.push(seen[g]); } seen[g].items.push(c); });
  body.innerHTML=`<div class="note small">Çdo kartë është një <b>kandidat</b> nga detektorët. Simptomat e së njëjtës fazë dhe kategori janë bashkuar (shkrirje e dublikatave). <b>Prano</b> krijon një problem me të gjitha evidencat; <b>Shkrij</b> i shton si evidencë te një problem ekzistues; <b>Hidh poshtë</b> kërkon arsye (kandidati rikthehet vetëm nëse vlera përkeqësohet ≥ 20%).</div>`
    + groups.map((g,gi)=>`<div class="card" style="margin-bottom:12px">
      <h3>${g.items.length>1? '🔗 '+g.items.length+' simptoma — '+h(g.items[0].phase)+' · '+h(g.items[0].category) : h(g.items[0].phase)+' · '+h(g.items[0].category)}
        <span class="sub">${g.items.map(c=>c.detector).join(', ')}</span></h3>
      ${g.items.map(bnCandCard).join('')}
      <div class="btnrow no-print" style="margin-top:10px">
        ${g.items[0].reopen? `<button class="btn primary" data-bnreopen="${gi}">↺ Rihap ${h((Store.get('problems',g.items[0].reopen)||{}).bnId||'')}</button>`
          : `<button class="btn primary" data-bnacc="${gi}">✓ Prano</button><button class="btn" data-bnmerge="${gi}">⇢ Shkrij me një problem</button>`}
        <button class="btn ghost" data-bndis="${gi}">✕ Hidh poshtë</button></div></div>`).join('');
  $$('[data-bnsql]').forEach(a=>a.onclick=e=>{ e.preventDefault(); const [id,bl]=a.dataset.bnsql.split('|'); bnShowSql(id,bl); });
  $$('[data-bnacc]').forEach(b=>b.onclick=()=>bnAccept(groups[+b.dataset.bnacc].items));
  $$('[data-bnmerge]').forEach(b=>b.onclick=()=>bnMerge(groups[+b.dataset.bnmerge].items));
  $$('[data-bndis]').forEach(b=>b.onclick=()=>bnDismiss(groups[+b.dataset.bndis].items));
  $$('[data-bnreopen]').forEach(b=>b.onclick=()=>bnReopen(groups[+b.dataset.bnreopen].items));
}
function bnDecide(items, action, extra){ items.forEach(c=>Store.insert('bnDecisions', Object.assign({key:c.key, detector:c.detector, value:c.value, at:nowISO(), action}, extra||{}))); }
function bnAccept(items){
  const c=items.slice().sort((a,b)=>(b.suggest.sev*b.suggest.occ)-(a.suggest.sev*a.suggest.occ))[0];
  const hyps=[...new Set(items.flatMap(x=>x.hypotheses||[]))].slice(0,4).map(t=>({text:t, status:'HIPOTEZË'}));
  bnOpenForm(null, { title:c.title, phase:c.phase, category:c.category, symptom:items.map(x=>x.symptom).join(' '), source:items.map(x=>x.detector).join('+'),
    objective:(c.impact&&c.impact.objective)||'Same-day', impactText:items.map(x=>x.impact&&x.impact.text).filter(Boolean).join('; '),
    sev:Math.max(...items.map(x=>x.suggest.sev||3)), occ:Math.max(...items.map(x=>x.suggest.occ||3)), det:Math.min(...items.map(x=>x.suggest.det||2)),
    bnEvidence:items.map(bnCandEvidence), hypotheses:hyps, gemba:[...new Set(items.flatMap(x=>x.gemba||[]))],
    effect:{metricKey:c.metricKey||null, startDate:null, before:c.metricKey? {value:c.value, period:c.period, snapshotId:c.snapshotId, at:nowISO()} : null},
    _candidates:items });
}
function bnMerge(items){
  const open=Store.col('problems').filter(p=>!['I mbyllur','Hedhur poshtë'].includes(p.bnStatus));
  if(!open.length){ toast('Asnjë problem aktiv për shkrirje — prano kandidatin.'); return; }
  openModal('Shkrij me një problem ekzistues', `<p class="small">Evidencat e ${items.length} kandidat${items.length>1?'ëve':'it'} (${items.map(c=>c.detector).join(', ')}) shtohen te problemi i zgjedhur.</p>
    <div class="field"><label>Problemi</label><select id="bnMergeTo">${open.sort((a,b)=>bnRpn(b)-bnRpn(a)).map(p=>`<option value="${p.id}">${h(p.bnId)} · ${h(p.title)} (${h(p.phase)})</option>`).join('')}</select></div>`,
    `<button class="btn ghost" id="mcancel">Anulo</button><button class="btn primary" id="msave">Shkrij</button>`);
  $('#mcancel').onclick=closeModal;
  $('#msave').onclick=()=>{ const p=Store.get('problems',$('#bnMergeTo').value); if(!p) return;
    const rec=JSON.parse(JSON.stringify(p)); rec.bnEvidence=(rec.bnEvidence||[]).concat(items.map(bnCandEvidence));
    const hy=new Set((rec.hypotheses||[]).map(x=>x.text)); items.flatMap(x=>x.hypotheses||[]).forEach(t=>{ if(!hy.has(t)){ rec.hypotheses.push({text:t,status:'HIPOTEZË'}); hy.add(t); } });
    if(!rec.effect||!rec.effect.metricKey){ const c=items.find(x=>x.metricKey); if(c) rec.effect={metricKey:c.metricKey, startDate:null, before:{value:c.value, period:c.period, snapshotId:c.snapshotId, at:nowISO()}}; }
    bnSave(rec, 'U shkri me kandidatët '+items.map(c=>c.key).join(', '));
    bnDecide(items,'merged',{problemId:p.id, reason:'Shkrirë me '+p.bnId}); closeModal(); toast('U shkri me '+p.bnId); bnDraw(); };
}
function bnDismiss(items){
  openModal('Hidh poshtë kandidatin', `<p class="small">${items.map(c=>h(c.detector+' — '+c.title)).join('<br>')}</p>
    <div class="field"><label>Arsyeja <span class="req">*</span></label><textarea id="bnDisWhy" rows="3" placeholder="p.sh. e njohur dhe e pranuar përkohësisht; burim i pasaktë; jashtë kontrollit të depos…"></textarea></div>
    <div class="hint">Kandidati nuk shfaqet më derisa vlera e tij të përkeqësohet ≥ 20% nga ${items.map(c=>bnFmtN(c.value)+' '+(c.unit||'')).join(', ')}.</div>`,
    `<button class="btn ghost" id="mcancel">Anulo</button><button class="btn danger" id="msave">Hidh poshtë</button>`);
  $('#mcancel').onclick=closeModal;
  $('#msave').onclick=()=>{ const why=$('#bnDisWhy').value.trim(); if(!why){ toast('Shkruaj arsyen.'); return; } bnDecide(items,'dismissed',{reason:why}); closeModal(); toast('U hodh poshtë'); bnDraw(); };
}
function bnReopen(items){
  const p=Store.get('problems', items[0].reopen); if(!p) return;
  const rec=JSON.parse(JSON.stringify(p)); rec.bnStatus='I rihapur'; rec.bnEvidence=(rec.bnEvidence||[]).concat(items.map(bnCandEvidence));
  bnSave(rec, 'U rihap: detektori e gjeti sërish mbi prag ('+items.map(c=>c.detector+' '+c.value+' '+(c.unit||'')).join(', ')+')');
  bnDecide(items,'accepted',{problemId:p.id, reason:'Rihapur'}); toast(p.bnId+' u rihap'); bnDraw();
}

/* ------------------------------------------------------------- problem form (create / edit core fields) */
function bnOpenForm(existing, prefill){
  const base=existing? existing : Object.assign({sev:3,occ:3,det:3, bnStatus:'I hapur', dateIdentified:todayStr()}, prefill||{});
  const shifts=Store.col('wmsShifts').filter(s=>s.active!==false).map(s=>s.name);
  const fields=[
    {name:'title',label:'Titulli (i qartë, pa zhargon)',type:'text',required:true},
    {name:'phase',label:'Faza e procesit',type:'select',options:BN_PHASES,required:true,row:'a'},
    {name:'category',label:'Kategoria',type:'select',options:BN_CATS,required:true,row:'a'},
    {name:'zone',label:'Zona / sektori',type:'text',row:'b',ph:'p.sh. Depo e re FA, stacioni Checkout 3'},
    {name:'shift',label:'Turni',type:'datalist',options:shifts,row:'b'},
    {name:'symptom',label:'Simptoma (çfarë shihet)',type:'textarea',rows:2,required:true},
    {name:'source',label:'Burimi',type:'datalist',options:BN_SOURCES,row:'c'},
    {name:'dateIdentified',label:'Data e identifikimit',type:'date',row:'c'},
    {name:'objective',label:'Ndikimi në objektiv',type:'select',options:BN_OBJECTIVES,required:true,row:'d'},
    {name:'impactText',label:'Ndikimi i kuantifikuar',type:'text',row:'d',ph:'p.sh. 34 porosi carryover/ditë · +0,12 €/porosi · 2,1 orë/turn'},
    {name:'sev',label:'Ashpërsia (1–5)',type:'number',step:'1',row:'e',hint:'5 = ndalon depon / rrezik sigurie'},
    {name:'occ',label:'Shpeshtësia (1–5)',type:'number',step:'1',row:'e',hint:'5 = çdo ditë'},
    {name:'det',label:'Zbulueshmëria (1–5)',type:'number',step:'1',row:'e',hint:'1 = zbulohet menjëherë · 5 = fshihet'},
    {name:'owner',label:'Pronari',type:'select',options:empOpts(),row:'f'},
    {name:'dueDate',label:'Afati',type:'date',noToday:true,row:'f'},
    {name:'bnStatus',label:'Statusi',type:'select',options:BN_STATUS.filter(s=>s!=='I mbyllur'||(existing&&existing.bnStatus==='I mbyllur')),row:'f',required:true}
  ];
  openForm({title: existing? 'Ndrysho '+existing.bnId : (prefill&&prefill._candidates? 'Prano kandidatin si problem' : 'Problem i ri nga terreni'), fields, values:base,
    extra:`<div class="note small" id="bnRpnLive"></div>${prefill&&prefill.bnEvidence? `<div class="small faint">Evidencat (${prefill.bnEvidence.length}), hipotezat (${(prefill.hypotheses||[]).length}) dhe pyetjet për Gemba kalojnë te karta e problemit.</div>` : ''}`,
    afterRender:()=>{ const upd=()=>{ const t={sev:$('#f_sev').value, occ:$('#f_occ').value, det:$('#f_det').value, category:$('#f_category').value};
        $('#bnRpnLive').innerHTML=`RPN = ${bnClamp(t.sev)} × ${bnClamp(t.occ)} × ${bnClamp(t.det)} = <b>${bnRpn(t)}</b> → ${bnPBadge(bnPrio(t))}${t.category==='Siguri'?' (Siguria është gjithmonë P1)':''}`; };
      ['f_sev','f_occ','f_det','f_category'].forEach(id=>{ const el=$('#'+id); if(el){ el.oninput=upd; el.onchange=upd; } }); upd(); },
    saveLabel: existing? 'Ruaj' : 'Krijo problemin',
    onSave:(vals)=>{
      for(const k of ['sev','occ','det']){ if(!(vals[k]>=1&&vals[k]<=5)){ toast('Ashpërsia, shpeshtësia dhe zbulueshmëria duhet të jenë 1–5.'); return; } }
      if(vals.bnStatus==='I mbyllur' && !(existing&&existing.bnStatus==='I mbyllur')){ toast('Mbyllja bëhet nga karta, pasi metrika të qëndrojë në objektiv ≥ '+BN_CLOSE_DAYS+' ditë.'); return; }
      if(existing){
        const rec=JSON.parse(JSON.stringify(existing)), changes=[];
        Object.keys(vals).forEach(k=>{ if(String(rec[k]??'')!==String(vals[k]??'')) changes.push(k+': '+(rec[k]??'—')+' → '+(vals[k]??'—')); rec[k]=vals[k]; });
        bnSave(rec, changes.length? 'Ndryshuar: '+changes.join('; ') : null); closeModal(); toast('U ruajt'); bnDraw(); if($('#bnCard')) bnOpenCard(rec.id);
      } else {
        const rec=Object.assign({}, prefill||{}, vals); const cands=rec._candidates; delete rec._candidates;
        rec.bnId=bnNextId((rec.dateIdentified||todayStr()).slice(0,4));
        const saved=bnSave(rec, cands? 'Krijuar nga kandidatët '+cands.map(c=>c.key).join(', ') : 'Krijuar nga vëzhgimi në terren');
        if(cands) bnDecide(cands,'accepted',{problemId:saved.id, reason:'Pranuar si '+saved.bnId});
        closeModal(); toast(saved.bnId+' u krijua'); bnTab='register'; bnDraw(); bnOpenCard(saved.id);
      }
    }});
}

/* ------------------------------------------------------------- problem card */
function bnSpark(m, opts){
  const s=(m&&m.series||[]).filter(x=>x.v!=null); if(s.length<2) return '<div class="small faint">Seri e pamjaftueshme për grafik.</div>';
  const W=640, H=130, P=28, vals=s.map(x=>+x.v), tgt=m.target!=null&&m.target!==''? +m.target : null;
  const max=Math.max(...vals, tgt??-Infinity)*1.1||1, min=Math.min(0,...vals);
  const X=i=>P+i*(W-2*P)/(s.length-1), Y=v=>H-18-(v-min)/(max-min)*(H-36);
  const pts=s.map((x,i)=>X(i)+','+Y(+x.v)).join(' ');
  const start=opts&&opts.startDate? s.findIndex(x=>String(x.d)>=opts.startDate) : -1;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto" role="img" aria-label="Trendi">
    ${tgt!=null? `<line x1="${P}" x2="${W-P}" y1="${Y(tgt)}" y2="${Y(tgt)}" stroke="var(--ok)" stroke-dasharray="4 4"/><text x="${W-P}" y="${Y(tgt)-4}" text-anchor="end" font-size="10" fill="var(--ok)">objektivi ${bnFmtN(tgt)}</text>` : ''}
    ${start>0? `<line x1="${X(start)}" x2="${X(start)}" y1="8" y2="${H-18}" stroke="var(--warn)" stroke-dasharray="3 3"/><text x="${X(start)+3}" y="16" font-size="10" fill="var(--warn)">veprimi</text>` : ''}
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${s.map((x,i)=>`<circle cx="${X(i)}" cy="${Y(+x.v)}" r="2.5" fill="var(--accent)"><title>${h(x.d)}: ${bnFmtN(+x.v)}</title></circle>`).join('')}
    <text x="${P}" y="${H-4}" font-size="10" fill="var(--faint)">${h(String(s[0].d))}</text><text x="${W-P}" y="${H-4}" font-size="10" fill="var(--faint)" text-anchor="end">${h(String(s[s.length-1].d))}</text>
    <text x="4" y="${Y(max/1.1)+4}" font-size="10" fill="var(--faint)">${bnFmtN(max/1.1)}</text></svg>`;
}
/* effect: the metric after the action start, and how long it stayed on target (daily: 14 days; weekly series: 2 weeks) */
function bnEffect(p){
  const ef=p.effect||{}, m=bnData&&bnData.metrics&&ef.metricKey? bnData.metrics[ef.metricKey] : null;
  if(!ef.metricKey) return {ok:false, why:'Lidh një metrikë me problemin për të matur efektin (para / pas).'};
  if(!m) return {ok:false, why:'Metrika '+ef.metricKey+' nuk është në snapshot-in aktual.'};
  if(m.target==null||m.target==='') return {ok:false, m, why:'Metrika nuk ka objektiv në Cilësimet.'};
  const s=(m.series||[]).filter(x=>x.v!=null), isDate=x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x.d));
  // a series of dates spaced about a week apart is weekly (D2, D11): "on target" then means 2 consecutive weeks
  const gaps=s.filter(isDate).slice(1).map((x,i)=>(Date.parse(x.d)-Date.parse(s.filter(isDate)[i].d))/864e5).sort((a,b)=>a-b);
  const daily=s.length && isDate(s[s.length-1]) && !(gaps.length && gaps[Math.floor(gaps.length/2)]>=6);
  const after=ef.startDate? s.filter(x=>!daily || String(x.d)>=ef.startDate) : [];
  const on=x=> m.better==='higher'? +x.v>=+m.target : +x.v<=+m.target;
  let streak=0; for(let i=after.length-1;i>=0;i--){ if(on(after[i])) streak++; else break; }
  const weekly=!daily, need= weekly? 2 : BN_CLOSE_DAYS;
  let spanDays=streak;
  if(daily && streak){ const first=after[after.length-streak].d, last=after[after.length-1].d; spanDays=Math.round((Date.parse(last)-Date.parse(first))/864e5)+1; }
  const ok= !!ef.startDate && (weekly? streak>=2 : spanDays>=BN_CLOSE_DAYS);
  const last=s.length? s[s.length-1] : null;
  return {ok, m, streak, spanDays, need, weekly, after, last, why: !ef.startDate? 'Vendos datën e fillimit të veprimit.' : ok? '' : `Në objektiv: ${weekly? streak+' javë' : spanDays+' ditë'} nga ${weekly? '2 javë' : BN_CLOSE_DAYS+' ditë'} të nevojshme.`};
}
function bnOpenCard(id){
  const p=Store.get('problems',id); if(!p) return; bnNormalize(p);
  const metricOpts=bnData&&bnData.metrics? Object.values(bnData.metrics) : [];
  const ef=bnEffect(p), m=ef.m||(bnData&&bnData.metrics||{})[p.effect&&p.effect.metricKey];
  const ev=(p.bnEvidence||[]).map((e,i)=>e.kind==='text'? `<div class="small" style="padding:6px 0;border-top:1px solid var(--line)"><span class="etag et-obs">tekst</span> ${h(e.text)}</div>`
    : `<div class="small" style="padding:6px 0;border-top:1px solid var(--line)"><span class="badge b-new">${h(e.detector)}</span> <b>${h(e.title||'')}</b> ${bnConfBadge(e.confidence)}
       <div>${h(e.symptom||'')}</div><div class="faint">Aktuale ${bnFmtN(e.value)} ${h(e.unit||'')} · baseline ${bnFmtN(e.baseline)} · prag ${bnFmtN(e.threshold)} · n ${bnFmtN(e.n)} · ${h(e.periodText||bnPeriod(e.period))} · ${h(e.scope||'')}
       · <a href="#" data-bnsql="${h(e.snapshotId)}|${h((e.blocks||[])[0]||e.detector)}">snapshot ${h(e.snapshotId)} ↗</a></div></div>`).join('');
  const hy=(p.hypotheses||[]).map((x,i)=>`<div style="display:flex;gap:6px;align-items:center;margin:4px 0"><select data-hst="${i}" style="width:auto;min-height:30px">${['HIPOTEZË','E konfirmuar','E hedhur poshtë'].map(s=>`<option ${x.status===s?'selected':''}>${s}</option>`).join('')}</select><input type="text" data-htx="${i}" value="${h(x.text)}"></div>`).join('');
  const ish=BN_6M.map(k=>`<div class="field"><label>${k}</label><textarea data-ish="${k}" rows="2">${h((p.ishikawa||{})[k]||'')}</textarea></div>`).join('');
  const body=`<div id="bnCard">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">${bnPBadge(p.priority)} <b>RPN ${bnRpn(p)}</b> <span class="small faint">(${bnClamp(p.sev)}×${bnClamp(p.occ)}×${bnClamp(p.det)})</span> ${bnStBadge(p.bnStatus)}
      <span class="small">${h(p.phase)} · ${h(p.category)}${p.zone?' · '+h(p.zone):''}${p.shift?' · turni '+h(p.shift):''}</span><span class="small faint" style="margin-left:auto">Pronari: ${h(empName(p.owner)||'—')} · Afati: ${p.dueDate?fmtDateAl(p.dueDate):'—'}</span></div>
    <div class="note small"><b>Simptoma:</b> ${h(p.symptom)}<br><b>Ndikimi (${h(p.objective)}):</b> ${h(p.impactText||'—')} · <b>Burimi:</b> ${h(p.source)}</div>
    <div class="formsection">Evidenca (${(p.bnEvidence||[]).length})</div>${ev||'<div class="small faint">Asnjë evidencë nga të dhënat — shto nga "Kandidatët" (Shkrij) ose përshkruaj vëzhgimin.</div>'}
    <div class="formsection">Trendi dhe efekti (para / pas)</div>
    <div class="row3"><div class="field"><label>Metrika</label><select id="bnEfM"><option value="">— pa metrikë —</option>${metricOpts.map(x=>`<option value="${h(x.key)}" ${p.effect&&p.effect.metricKey===x.key?'selected':''}>${h(x.label)} (${h(x.unit)})</option>`).join('')}</select></div>
      <div class="field"><label>Fillimi i veprimit</label><input type="date" id="bnEfStart" value="${h(p.effect&&p.effect.startDate||'')}"></div>
      <div class="field"><label>Para (baseline)</label><input type="text" disabled value="${p.effect&&p.effect.before? bnFmtN(p.effect.before.value)+' · '+h(bnPeriod(p.effect.before.period)) : '—'}"></div></div>
    ${m? bnSpark(m,{startDate:p.effect&&p.effect.startDate}) : ''}
    <div class="small ${ef.ok?'':'faint'}" style="margin:4px 0">${ef.last? 'Vlera e fundit: <b>'+bnFmtN(+ef.last.v)+' '+h(m.unit)+'</b> ('+h(String(ef.last.d))+') · objektivi '+bnFmtN(m.target)+' · ' : ''}${ef.ok? '✅ Metrika ka qëndruar në objektiv '+(ef.weekly? ef.streak+' javë' : ef.spanDays+' ditë')+' — problemi mund të mbyllet.' : h(ef.why||'')}</div>
    <div class="formsection">Hipotezat e shkakut <span>Shkaku mbetet HIPOTEZË derisa të verifikohet në terren</span></div>
    ${hy||'<div class="small faint">Asnjë hipotezë.</div>'}<button class="btn sm" id="bnHyAdd">＋ Hipotezë</button>
    <div class="field" style="margin-top:8px"><label>Shkaku rrënjësor i konfirmuar (vetëm pas verifikimit)</label><textarea id="bnRoot" rows="2">${h(p.rootCause||'')}</textarea></div>
    <details ${p.whys&&p.whys.some(Boolean)?'open':''}><summary class="small"><b>5 Pse</b></summary>${[0,1,2,3,4].map(i=>`<div class="field"><label>Pse #${i+1}</label><input type="text" data-why="${i}" value="${h((p.whys||[])[i]||'')}"></div>`).join('')}</details>
    <details ${Object.values(p.ishikawa||{}).some(Boolean)?'open':''}><summary class="small"><b>Ishikawa (6M)</b></summary><div class="row3">${ish}</div></details>
    <div class="formsection">Plani i verifikimit në terren (Gemba)</div>
    ${(p.gemba||[]).map(q=>`<div class="small" style="margin:3px 0"><span class="etag et-obs">pyetje</span> ${h(q)}</div>`).join('')}
    <div class="row2"><div class="field"><label>Çfarë vëzhgohet</label><input type="text" id="bnVwhat" value="${h(p.verify.what||'')}"></div><div class="field"><label>Ku</label><input type="text" id="bnVwhere" value="${h(p.verify.where||'')}"></div></div>
    <div class="row2"><div class="field"><label>Kur</label><input type="text" id="bnVwhen" value="${h(p.verify.when||'')}" placeholder="p.sh. e hënë 16:30–17:30"></div><div class="field"><label>Sa gjatë</label><input type="text" id="bnVdur" value="${h(p.verify.duration||'')}" placeholder="p.sh. 3 ditë × 60 min"></div></div>
    <div class="formsection">Veprimet</div>
    <div class="field"><label>Veprimi korrigjues</label><textarea id="bnCorr" rows="2">${h(p.corrective||'')}</textarea></div>
    <div class="field"><label>Veprimi parandalues (standardizim / SOP)</label><textarea id="bnPrev" rows="2">${h(p.preventive||'')}</textarea></div>
    <div class="formsection">Historiku</div>
    <div class="small" style="max-height:160px;overflow:auto">${(p.history||[]).slice().reverse().map(x=>`<div style="padding:3px 0;border-bottom:1px solid var(--line)"><span class="faint">${bnFmtAt(x.at)}${x.by?' · '+h(x.by):''}</span> — ${h(x.text)}</div>`).join('')||'<span class="faint">—</span>'}</div></div>`;
  const next={'I hapur':'Në analizë','Në analizë':'Në veprim','Në veprim':'Në verifikim','Në verifikim':'I mbyllur','I rihapur':'Në analizë'}[p.bnStatus];
  openModal(p.bnId+' · '+p.title, body, `<button class="btn ghost" id="mcancel">Mbyll</button><button class="btn" id="bnEdit">Ndrysho fushat</button>
    ${next? `<button class="btn" id="bnNext">→ ${h(next)}</button>` : ''}<button class="btn primary" id="msave">Ruaj kartën</button>`);
  const modal=$('.modal'); if(modal) modal.style.maxWidth='980px';
  $('#mcancel').onclick=closeModal;
  $$('#bnCard [data-bnsql]').forEach(a=>a.onclick=e=>{ e.preventDefault(); const [sid,bl]=a.dataset.bnsql.split('|'); bnShowSql(sid,bl); });
  const collect=()=>{ const rec=JSON.parse(JSON.stringify(Store.get('problems',id)));
    rec.hypotheses=$$('#bnCard [data-htx]').map(el=>({text:el.value.trim(), status:$(`#bnCard [data-hst="${el.dataset.htx}"]`).value})).filter(x=>x.text);
    rec.rootCause=$('#bnRoot').value.trim(); rec.whys=[0,1,2,3,4].map(i=>$(`#bnCard [data-why="${i}"]`).value.trim());
    rec.ishikawa=Object.fromEntries(BN_6M.map(k=>[k,$(`#bnCard [data-ish="${k}"]`).value.trim()]));
    rec.verify={what:$('#bnVwhat').value.trim(), where:$('#bnVwhere').value.trim(), when:$('#bnVwhen').value.trim(), duration:$('#bnVdur').value.trim()};
    rec.corrective=$('#bnCorr').value.trim(); rec.preventive=$('#bnPrev').value.trim();
    const mk=$('#bnEfM').value||null, st=$('#bnEfStart').value||null;
    if(mk!==(rec.effect&&rec.effect.metricKey)){ const mm=bnData&&bnData.metrics&&bnData.metrics[mk]; const ser=mm&&(mm.series||[]).filter(x=>x.v!=null);
      rec.effect={metricKey:mk, startDate:st, before: ser&&ser.length? {value:+ser[ser.length-1].v, period:{from:ser[0].d, to:ser[ser.length-1].d}, snapshotId:bnData.snapshotId, at:nowISO()} : null}; }
    else rec.effect=Object.assign({}, rec.effect, {startDate:st});
    if(rec.rootCause && rec.rootCause!==(Store.get('problems',id).rootCause||'') && !rec.hypotheses.some(x=>x.status==='E konfirmuar'))
      toast('Shënim: shkaku rrënjësor zakonisht konfirmon një nga hipotezat — shëno atë si "E konfirmuar".');
    return rec; };
  $('#bnHyAdd').onclick=()=>{ const rec=collect(); rec.hypotheses.push({text:'Hipotezë e re', status:'HIPOTEZË'}); bnSave(rec); bnOpenCard(id); };
  $('#msave').onclick=()=>{ const rec=collect(); bnSave(rec, 'Karta u përditësua'); toast('U ruajt'); closeModal(); bnDraw(); };
  $('#bnEdit').onclick=()=>{ const rec=collect(); bnSave(rec); bnOpenForm(Store.get('problems',id)); };
  if($('#bnNext')) $('#bnNext').onclick=()=>{ const rec=collect();
    if(next==='I mbyllur'){ bnSave(rec); const e2=bnEffect(Store.get('problems',id)); if(!e2.ok){ toast('Nuk mbyllet: '+(e2.why||'metrika s\'është në objektiv '+BN_CLOSE_DAYS+' ditë')); bnOpenCard(id); return; }
      rec.effect=Object.assign({}, rec.effect, {after:{value:+e2.last.v, at:nowISO(), days:e2.weekly? e2.streak*7 : e2.spanDays, snapshotId:bnData&&bnData.snapshotId}}); }
    if(next==='Në veprim' && !rec.owner){ toast('Cakto pronarin para se ta kalosh në veprim.'); return; }
    rec.bnStatus=next; bnSave(rec, 'Statusi → '+next); toast(p.bnId+': '+next); bnOpenCard(id); bnDraw(); };
}
async function bnShowSql(snapId, block){
  openModal('Query dhe snapshot', '<div class="empty">Po lexohet…</div>', `<button class="btn ghost" id="mcancel">Mbyll</button>`); $('#mcancel').onclick=closeModal;
  try{ const r=await fetch('/bn/snapshot?id='+encodeURIComponent(snapId)+'&block='+encodeURIComponent(block)); const j=await r.json();
    if(!r.ok) throw new Error(j.error||r.status);
    $('.modal .body').innerHTML=`<div class="small">Snapshot <b>${h(j.id)}</b> · blloku <b>${h(j.block)}</b> · ekzekutuar ${bnFmtAt(j.blockAt)} · burimi ${h(j.source)}</div>
      <div class="small faint" style="margin:4px 0">Scope: ${h(Object.entries(j.scope||{}).map(([k,v])=>k+'='+v).join(', '))}</div>
      <pre style="white-space:pre-wrap;font-size:11px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:50vh;overflow:auto">${h(j.sql||'(importuar pa SQL)')}</pre>
      <div class="hint">Riprodhimi: ekzekuto të njëjtin SQL (vetëm lexim) në databazën WMS — me të njëjtat parametra jep të njëjtat shifra për të njëjtën periudhë.</div>`;
    const modal=$('.modal'); if(modal) modal.style.maxWidth='900px';
  }catch(e){ $('.modal .body').innerHTML=`<div class="empty">${h(e.message)}</div>`; }
}

/* ------------------------------------------------------------- Constraint */
function bnDrawConstraint(body){
  const c=bnData&&bnData.constraint; if(!c){ body.innerHTML='<div class="card"><div class="empty">D3 ende pa të dhëna.</div></div>'; return; }
  const hrs=c.hours.filter(x=>x>=6);
  const heat=c.heat.map(r=>{ const mx=Math.max(...r.v,1); return `<tr><th style="text-align:left;white-space:nowrap">${h(r.name)}<div class="small faint">${h(r.unit)}/orë</div></th>${hrs.map(hh=>{ const v=r.v[hh]||0, a=v/mx;
      return `<td title="${h(r.name)} ${hh}:00 — ${bnFmtN(v)} ${h(r.unit)}" style="text-align:center;font-size:11px;padding:4px 2px;background:rgba(${r.k===c.top?'239,83,80':'79,140,255'},${(0.08+a*0.75).toFixed(2)});color:${a>0.55?'#fff':'var(--text)'}">${v? Math.round(v) : ''}</td>`; }).join('')}</tr>`; }).join('');
  body.innerHTML=`<div class="card" style="margin-bottom:12px"><h3>Heatmap fazë × orë <span class="sub">mesatarja për ditë pune, ${h(bnPeriod(c.period))} · ${c.days} ditë</span></h3>
      <div class="tablewrap"><table style="min-width:760px"><thead><tr><th></th>${hrs.map(x=>`<th style="text-align:center;font-size:11px">${String(x).padStart(2,'0')}</th>`).join('')}</tr></thead><tbody>${heat}</tbody></table></div>
      <div class="hint">Ngjyra = sa afër maksimumit të vet është faza në atë orë. Rreshti i kuq = faza me shfrytëzimin më të lartë (kufizimi i mundshëm). Porositë hyrëse = kërkesa (porosi të krijuara).</div></div>
    <div class="card"><h3>Kapaciteti, shfrytëzimi dhe WIP sipas fazës</h3>
      <div class="tablewrap"><table><thead><tr><th>Faza</th><th>Kapaciteti i demonstruar (p90/orë)</th><th>Mesatarja/orë</th><th>Shfrytëzimi 09–17</th><th>Për ditë (7 ditë)</th><th>Baseline/ditë</th><th>Operatorë/orë</th><th>WIP tani</th><th>n orë</th></tr></thead><tbody>
      ${c.phases.map(p=>`<tr ${p.k===c.top?'style="background:rgba(239,83,80,.10)"':''}><td><b>${h(p.name)}</b>${p.k===c.top?' <span class="badge b-crit">kufizimi</span>':''}</td><td>${bnFmtN(p.capPerH)} ${h(p.unit)}</td><td>${bnFmtN(p.meanPerH)}</td>
        <td><b>${bnFmtN(p.util)}%</b></td><td>${bnFmtN(p.perDay)}</td><td>${bnFmtN(p.perDayBase)}</td><td>${p.opsPerH!=null?bnFmtN(p.opsPerH):'—'}</td><td>${p.wip!=null?bnFmtN(p.wip):'—'}</td><td class="small ${p.n<20?'':'faint'}" style="${p.n<20?'color:var(--warn)':''}">${p.n}${p.n<20?' ⚠':''}</td></tr>`).join('')}</tbody></table></div>
      <div class="small" style="margin-top:8px"><span class="etag et-fact">fakt</span> Porositë hyrëse − porositë e dala = ${bnFmtN(c.netOrders)}/ditë (7 ditët e fundit; pozitive = WIP rritet, përfshin porositë që presin mallin nga shitësi).</div>
      <div class="small"><span class="etag et-hyp">hipotezë</span> Faza me shfrytëzimin më të lartë dhe WIP që rritet është kufizimi; konfirmoje me vëzhgim (pritje para stacionit, stacion që s'ndalet kurrë).</div>
      <div class="small"><span class="etag et-obs">e pakonfirmuar</span> Kapaciteti është ai i demonstruar nga skanimet (p90 i orëve me punë), jo kapaciteti teorik. WIP i check-out-it = porosi me të gjitha njësitë e rezervuara pa dalë (D1o); WIP i mapping-ut = njësi me status 2/6 (D4).</div></div>`;
}

/* ------------------------------------------------------------- Data & queries */
function bnDrawData(body){
  const b=bnData||{}, blocks=b.blocks||{};
  body.innerHTML=`<div class="card" style="margin-bottom:12px"><h3>Blloqet e të dhënave <span class="sub">snapshot ${h(b.snapshotId||'—')}</span></h3>
      <div class="tablewrap"><table><thead><tr><th>Blloku</th><th>Detektori</th><th>Ekzekutuar</th><th>Burimi</th><th>Scope</th><th></th></tr></thead><tbody>
      ${Object.keys(BN_DET_NAMES).flatMap(k=>k==='D1'?['D1','D1o']:[k]).map(k=>{ const x=blocks[k]; const old=x&&(Date.now()-Date.parse(x.at))>26*3600e3;
        return `<tr><td><b>${k}</b></td><td class="small">${h(BN_DET_NAMES[k.replace('o','')]||'')}${k==='D1o'?' (të hapura)':''}</td><td class="small" style="${old?'color:var(--warn)':''}">${x?bnFmtAt(x.at):'—'}</td><td class="small">${x?h(x.source):'—'}</td><td class="small">${x?h(x.scope):'—'}</td>
          <td>${x?`<a href="#" data-bnsql="${h(b.snapshotId)}|${k}">SQL ↗</a>`:''}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="btnrow no-print" style="margin-top:10px"><a class="btn sm" href="/bn/runfile" target="_blank">⬇ queries.run.sql (me cilësimet aktuale)</a>
        <label class="btn sm ghost" style="cursor:pointer">⬆ Importo rezultate (JSON/CSV)<input type="file" id="bnImport" accept=".json,.csv" style="display:none"></label></div>
      <div class="hint">Query-t ekzekutohen vetëm me SELECT nga detyra e planifikuar (07, 13, 18) përmes konektorit WMS; agjenti i merr rezultatet automatikisht dhe krijon një snapshot të ri. Pa konektor: ekzekuto queries.run.sql dhe importo rezultatet — JSON <code>{"D1":{"row":{…},"sql":"…"}}</code> ose CSV me kolonat <code>block,column,value</code>.</div></div>
    <div class="card"><h3>Shënime për të dhënat <span class="sub">fakte, burime të ndalura, ID të pakonfirmuara</span></h3>
      ${(b.notes||[]).map(n=>`<div class="small" style="margin:5px 0"><span class="etag ${n.kind==='ok'?'et-data':n.kind==='data'||n.kind==='missing'||n.kind==='old'?'et-obs':n.kind==='error'?'et-hyp':'et-fact'}">${h(n.detector)}</span> ${h(n.text)}</div>`).join('')||'<div class="small faint">—</div>'}</div>`;
  $$('[data-bnsql]').forEach(a=>a.onclick=e=>{ e.preventDefault(); const [id,bl]=a.dataset.bnsql.split('|'); bnShowSql(id,bl); });
  const imp=$('#bnImport'); if(imp) imp.onchange=async e=>{ const f=e.target.files[0]; if(!f) return; const text=await f.text();
    try{ const r=await fetch('/bn/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text, name:f.name})}); const j=await r.json();
      if(!r.ok) throw new Error(j.error||r.status); toast('Snapshot '+j.id+': '+j.changed.join(', ')); bnLoad(false); }
    catch(err){ toast('Importi dështoi: '+err.message); } e.target.value=''; };
}

/* ------------------------------------------------------------- Settings */
function bnDrawSettings(body){
  const cfg=bnCfg(), P=Object.assign({wh:1,pf:0,nd:35,ma:30,co:'17:30',mh:4,sh:24,gm:15}, cfg.params||{}), T=bnTh();
  body.innerHTML=`<div class="card" style="margin-bottom:12px"><h3>Parametrat e query-ve <span class="sub">vlejnë nga ekzekutimi i ardhshëm (queries.run.sql)</span></h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${Object.entries(BN_PARAM_LABELS).map(([k,[l,hint]])=>`<div class="field"><label>${h(l)}</label><input type="text" data-bnp="${k}" value="${h(P[k])}">${hint?`<div class="hint">${h(hint)}</div>`:''}</div>`).join('')}</div></div>
    <div class="card"><h3>Pragjet e detektorëve dhe të prioritetit <span class="sub">vlejnë menjëherë</span></h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${Object.entries(BN_TH_LABELS).map(([k,l])=>`<div class="field"><label>${h(l)}</label><input type="number" step="any" data-bnt="${k}" value="${T[k]==null?'':h(T[k])}"></div>`).join('')}</div>
      <div class="btnrow" style="margin-top:10px"><button class="btn primary" id="bnSaveCfg">Ruaj cilësimet</button><button class="btn ghost" id="bnResetCfg">Kthe vlerat fillestare</button></div></div>`;
  $('#bnSaveCfg').onclick=()=>{ const params={}, thresholds={};
    $$('[data-bnp]').forEach(el=>{ const v=el.value.trim(); params[el.dataset.bnp]= el.dataset.bnp==='co'? v : (v===''? null : +v); });
    $$('[data-bnt]').forEach(el=>{ const v=el.value.trim(); thresholds[el.dataset.bnt]= v===''? null : +v; });
    if(!/^\d{2}:\d{2}$/.test(params.co||'')){ toast('Cut-off duhet HH:MM'); return; }
    Store.db.config.bottleneck={params, thresholds}; Store.persist(); toast('Cilësimet u ruajtën'); setTimeout(()=>bnLoad(false), 1500); };
  $('#bnResetCfg').onclick=()=>{ Store.db.config.bottleneck={}; Store.persist(); toast('U kthyen vlerat fillestare'); bnDraw(); setTimeout(()=>bnLoad(false), 1500); };
}

/* ------------------------------------------------------------- Export / weekly report */
function bnReportData(){
  const all=Store.col('problems').filter(p=>p.bnId);
  const active=all.filter(p=>!['I mbyllur','Hedhur poshtë'].includes(p.bnStatus)).sort((a,b)=>(a.priority>b.priority?1:a.priority<b.priority?-1:0)||bnRpn(b)-bnRpn(a));
  const weekAgo=new Date(Date.now()-7*864e5).toISOString();
  const closed=all.filter(p=>p.bnStatus==='I mbyllur' && (p.history||[]).some(x=>x.at>=weekAgo && /I mbyllur/.test(x.text)));
  const byStatus=BN_STATUS.map(s=>[s, all.filter(p=>p.bnStatus===s).length]).filter(x=>x[1]);
  return {all, active, top:active.slice(0,5), closed, byStatus};
}
const bnEffText=p=>{ const e=p.effect||{}; const m=bnData&&bnData.metrics&&e.metricKey? bnData.metrics[e.metricKey] : null; const ser=m&&(m.series||[]).filter(x=>x.v!=null);
  const now=ser&&ser.length? ser[ser.length-1].v : null;
  return e.before? `${bnFmtN(e.before.value)} → ${now!=null? bnFmtN(+now) : (e.after? bnFmtN(e.after.value) : '—')} ${m? m.unit : ''}` : '—'; };
function bnDrawExport(body){
  const R=bnReportData(), c=bnData&&bnData.constraint, top=c&&c.top? c.phases.find(p=>p.k===c.top) : null;
  body.innerHTML=`<div class="btnrow no-print" style="margin-bottom:12px"><button class="btn primary" id="bnPrint">🖨 PDF (printo)</button><button class="btn" id="bnXlsx">⬇ Excel</button>
      <span class="small faint">Raporti javor për menaxhmentin: top 5 problemet, statusi dhe efekti i matur.</span></div>
    <div class="card" style="margin-bottom:12px"><h3>Raporti javor — Problem / Bottleneck Register <span class="sub">${fmtDateAl(todayStr())} · Depo 01 Prishtinë</span></h3>
      ${top? `<div class="small" style="margin-bottom:8px"><b>Kufizimi i sistemit:</b> ${h(top.name)} — shfrytëzim ${bnFmtN(top.util)}% (${bnFmtN(top.capPerH)} ${h(top.unit)}/orë p90)${top.wip!=null? ', WIP '+bnFmtN(top.wip) : ''} <span class="etag et-hyp">hipotezë</span></div>` : ''}
      <div class="small" style="margin-bottom:8px"><b>Statusi:</b> ${R.byStatus.map(([s,n])=>h(s)+' '+n).join(' · ')||'—'}</div>
      <div class="tablewrap"><table><thead><tr><th>#</th><th>ID</th><th>P</th><th>RPN</th><th class="wrap">Problemi</th><th>Faza</th><th class="wrap">Ndikimi</th><th>Statusi</th><th>Pronari</th><th>Afati</th><th>Efekti (para → tani)</th></tr></thead><tbody>
      ${R.top.length? R.top.map((p,i)=>`<tr><td>${i+1}</td><td>${h(p.bnId)}</td><td>${bnPBadge(p.priority)}</td><td>${bnRpn(p)}</td><td class="wrap">${h(p.title)}</td><td class="small">${h(p.phase)}</td><td class="wrap small">${h(p.impactText||'')}</td><td>${bnStBadge(p.bnStatus)}</td><td class="small">${h(empName(p.owner)||'—')}</td><td class="small">${p.dueDate?fmtDateAl(p.dueDate):'—'}</td><td class="small">${bnEffText(p)}</td></tr>`).join('') : emptyRow(11,'Asnjë problem aktiv.')}</tbody></table></div>
      ${R.closed.length? `<div class="small" style="margin-top:8px"><b>Mbyllur këtë javë (efekti i matur ≥ ${BN_CLOSE_DAYS} ditë në objektiv):</b> ${R.closed.map(p=>h(p.bnId+' '+p.title+' — '+bnEffText(p))).join('; ')}</div>` : ''}
      <div class="hint">Çdo shifër vjen nga një snapshot i WMS-it me query-n, periudhën dhe scope-in e vet (karta e problemit → evidenca). Shkaqet e pa-verifikuara janë hipoteza.</div></div>`;
  $('#bnPrint').onclick=()=>window.print();
  $('#bnXlsx').onclick=async()=>{
    const head=['ID','Prioriteti','RPN','S','O','D','Titulli','Faza','Zona','Turni','Kategoria','Simptoma','Burimi','Objektivi','Ndikimi','Hipotezat','Shkaku i konfirmuar','Veprimi korrigjues','Veprimi parandalues','Pronari','Afati','Statusi','Efekti (para → tani)','Evidenca (snapshot)'];
    const row=p=>[p.bnId,p.priority,bnRpn(p),bnClamp(p.sev),bnClamp(p.occ),bnClamp(p.det),p.title,p.phase,p.zone||'',p.shift||'',p.category,p.symptom,p.source,p.objective,p.impactText||'',
      (p.hypotheses||[]).map(x=>x.status+': '+x.text).join(' | '),p.rootCause||'',p.corrective||'',p.preventive||'',empName(p.owner)||'',p.dueDate||'',p.bnStatus,bnEffText(p),
      (p.bnEvidence||[]).map(e=>e.kind==='text'? e.text : e.detector+' '+e.value+' '+(e.unit||'')+' (snapshot '+e.snapshotId+', '+(e.periodText||'')+', '+(e.scope||'')+')').join(' | ')];
    const cands=bnOpenCandidates().map(c=>[c.detector,c.title,c.value,c.unit,c.baseline,c.threshold,c.n,c.confidence,bnPeriod(c.period),c.scope,c.impact&&c.impact.text,c.snapshotId]);
    const cs=c? c.phases.map(p=>[p.name,p.capPerH,p.meanPerH,p.util,p.perDay,p.perDayBase,p.opsPerH,p.wip,p.n]) : [];
    const sheets=[{name:'Top 5', rows:[head, ...R.top.map(row)], widths:[12,9,6,4,4,4,40,16,14,10,14,50,10,14,40,50,30,30,30,16,11,12,18,60]},
      {name:'Regjistri', rows:[head, ...R.all.map(row)]},
      {name:'Kandidatët', rows:[['Detektori','Titulli','Aktuale','Njësia','Baseline','Pragu','n','Besueshmëria','Periudha','Scope','Ndikimi','Snapshot'], ...cands]},
      {name:'Kufizimi', rows:[['Faza','Kapaciteti p90/orë','Mesatarja/orë','Shfrytëzimi %','Për ditë','Baseline/ditë','Operatorë/orë','WIP','n orë'], ...cs]}];
    try{ const r=await fetch('/bn/export.xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:'bottleneck-register-'+todayStr()+'.xlsx', sheets})});
      if(!r.ok) throw new Error('HTTP '+r.status); const blob=await r.blob(); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='bottleneck-register-'+todayStr()+'.xlsx'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); }
    catch(e){ toast('Eksporti dështoi: '+e.message); } };
}
