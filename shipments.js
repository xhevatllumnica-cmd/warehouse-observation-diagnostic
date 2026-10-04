/* =========================================================================
   SHIPMENTS — inbound transport to the warehouses, from WMS (Shipments → ShipmentDestinations, Carriers).
   pulse/build.js puts every shipment stop picked up, due or arrived in the last 30 days (plus the ones still on the
   way) into /pulse/data → shipments, refreshed hourly with WMS Pulse (query block K in pulse/queries.sql).
   Two categories from Shipments.SupplierType: 10 = Kombëtare (local sellers, e.g. Beki), 20 = Ndërkombëtare
   (Poland, Czechia, Romania, Hungary … via Vokshi, MIKMIK, GoShipping, Apcom) — the meaning is inferred from the
   origin names. Inside each category the stops are grouped by origin country, carrier, state or warehouse.
   Status numbers (10 → 60) have no documented meaning: shown as numbers. Invoices are counted, never listed (local
   invoice numbers carry sellers' names). Loaded after shared.js and before app.js; uses app.js helpers at call time.
   =======================================================================*/
let shpData=null, shpTab='I', shpWh='1', shpGroup=null, shpSel=null, shpState='', shpQuery='', shpLimit=200, shpSeq=0;
const SHP_WH={1:'01 Prishtinë',5:'02 Tiranë',6:'03 Shkup',11:'iGjirafa Prishtinë',12:'05 Prizren'};
const SHP_CAT={K:{name:'Kombëtare', desc:'Furnitorë/shitës lokalë (SupplierType 10) — p.sh. Beki', def:'carrier'},
  I:{name:'Ndërkombëtare', desc:'Dërgesa nga jashtë vendit (SupplierType 20) — Poloni, Çeki, Rumani, Hungari…', def:'country'}};
const SHP_GROUPS={country:'Vendi i origjinës', supplier:'Furnizuesi', carrier:'Transportuesi', state:'Gjendja', wh:'Depoja'};
/* WMS has no store names: the supplier of a stop is the StoreId of its invoices. Names below are inferred from the origin
   text, the carrier and the invoice format (marked "i nxjerrë" until confirmed); the lead names / corrects any id in
   Shipments → Furnizuesit (Store config.suppliers). National stops show only the number of sellers (may be individuals). */
const SHP_SUP_SEED={645:'APCOM', 203:'Morele', 414:'Action', 809:'Innpro'};
function shpSupCfg(){ return (Store.db.config||{}).suppliers||{}; }
let shpStores=null;   // WMS store names (StoreId → name) from the agent (/wms/stores)
const shpStore=id=> shpStores&&shpStores[id] || null;
function shpSupName(id){ const c=shpSupCfg()[id]; return c&&c.name? c.name : SHP_SUP_SEED[id]? SHP_SUP_SEED[id] : shpStore(id) || '#'+id; }
const shpSupInferred=id=> !(shpSupCfg()[id]&&shpSupCfg()[id].name) && !!SHP_SUP_SEED[id];
const shpSupUnknown=id=> !(shpSupCfg()[id]&&shpSupCfg()[id].name) && !SHP_SUP_SEED[id] && !shpStore(id);
const SHP_STATES=[['arrived','Mbërritur në kohë','b-ok'],['late','Mbërritur me vonesë','b-warn'],['overdue','Pa mbërritje pas datës','b-crit'],['customs','Në doganë','b-warn'],['transit','Në rrugë','b-new'],['planned','Planifikuar','b-muted']];
/* ShipmentDestinations.Status — the names the WMS itself uses ("Track Shipments" status filter, read 05.10.2026) */
const SHP_WMS_ST={10:'Scheduled · planifikuar',20:'In Transit · në rrugë',30:'In Customs · në doganë',40:'Customs Clearance · zhdoganim',50:'Arrived · mbërritur',60:'Completed · përfunduar',70:'Delayed · me vonesë'};
const shpStName=st=> SHP_WMS_ST[+st]||'';
// the badge comes from the dates; when the pickup date has passed but the WMS still says Scheduled, the WMS was not updated
const shpStStale=x=> !x.arr && +x.st===10 && (x.state==='transit'||x.state==='overdue');
const shpT=s=>s? new Date(s.replace(' ','T')) : null;
const shpD=s=>s? s.slice(8,10)+'.'+s.slice(5,7) : '—';
const shpDT=s=>s? s.slice(8,10)+'.'+s.slice(5,7)+(s.slice(11,16)&&s.slice(11,16)!=='00:00'? ' '+s.slice(11,16) : '') : '—';
const shpDays=(a,b)=> a&&b? Math.round((shpT(b)-shpT(a))/864e5*10)/10 : null;
/* origin country from the free-text origin ("PL Morele", "Poloni", "Ceki", "Apcom - Hungary" …) */
function shpCountry(o){ const s=String(o||'');
  if(/PL|Pol|Morele|Action|Innpro|Inppro|Komputronik|Mirjan/i.test(s)) return 'Poloni';
  if(/\bCZ\b|Ce[kq]i|Czech/i.test(s)) return 'Çeki'; if(/Hung|Apcom/i.test(s)) return 'Hungari'; if(/Rum|Rom/i.test(s)) return 'Rumani';
  if(/Maqed|\bMK\b|Maced/i.test(s)) return 'Maqedoni'; if(/Alb|Shqip|\bAL\b/i.test(s)) return 'Shqipëri'; if(/Kos|\bKS\b|\bXK\b/i.test(s)) return 'Kosovë';
  return s? s.slice(0,24) : 'E panjohur'; }
function shpState1(x, now){
  if(x.arr) return x.eta && x.arr.slice(0,10)>x.eta.slice(0,10)? 'late' : 'arrived';      // dates compared, not times
  if((+x.st===30 || +x.st===40) && !(x.eta && x.eta.slice(0,10)<todayStr())) return 'customs';   // WMS: In Customs / Customs Clearance
  if(x.pick && shpT(x.pick)>now) return 'planned';
  if(x.eta && x.eta.slice(0,10)<todayStr()) return 'overdue';
  return 'transit';
}
const shpStateMeta=k=>SHP_STATES.find(s=>s[0]===k)||[k,k,'b-muted'];
const shpBadge=k=>{ const m=shpStateMeta(k); return `<span class="badge ${m[2]}">${h(m[1])}</span>`; };
const shpEur=v=> v==null||v===''? '—' : '€'+Math.round(+v).toLocaleString('de-DE');

function renderShipments(v){
  v.innerHTML = pagehead('Shipments','Transporti hyrës drejt depove, nga WMS: çdo ndalesë e marrë, e pritur ose e mbërritur në 30 ditët e fundit, plus ato ende në rrugë. Të ndara në <b>Kombëtare</b> dhe <b>Ndërkombëtare</b> dhe të grupuara sipas kategorisë. Rifreskohet çdo orë bashkë me WMS Pulse.',
      `<span class="small faint" id="shpAt"></span>`)
    + `<div class="btnrow no-print" id="shpTabs" style="margin-bottom:10px"></div><div id="shpBody"><div class="empty">Po ngarkohet…</div></div>`;
  if(!wmsOnAgent()){ $('#shpBody').innerHTML='<div class="card"><div class="empty">Hape app-in nga http://localhost:8790.</div></div>'; return; }
  if(shpData) shpDraw(); shpLoad();
}
async function shpLoad(){
  const seq=++shpSeq;
  try{ const [r,st]=await Promise.all([fetch('/pulse/data',{cache:'no-store'}), fetch('/wms/stores',{cache:'no-store'}).then(x=>x.json()).catch(()=>null)]); const j=await r.json(); if(seq!==shpSeq) return; shpStores=st&&st.stores||null;
    shpData= j.shipments || {missing:true}; }
  catch(e){ shpData={error:'Agjenti nuk përgjigjet ('+e.message+').'}; }
  if($('#shpBody')) shpDraw();
}
function shpRows(){
  if(!shpData||!shpData.stops) return [];
  const C={}; (shpData.carriers||[]).forEach(c=>C[c.id]=c); const now=new Date();
  return shpData.stops.map(x=>{ const sups=String(x.sup||'').split(',').filter(Boolean);
    return Object.assign({}, x, {sups, supplier: sups.length? sups.map(shpSupName).join(' + ') : (x.cat==='I'? 'Pa faturë' : 'Pa shitës'), carrier:(C[x.cid]||{}).nm||('#'+x.cid), country: x.cat==='K'? 'Kosovë' : shpCountry(x.o), state:shpState1(x, now),
    transit: shpDays(x.pick, x.arr), toCheckin: shpDays(x.arr, x.ci1)}); });
}
function shpDraw(){
  const body=$('#shpBody'); if(!body) return;
  if(shpData&&shpData.error){ body.innerHTML=`<div class="card"><div class="empty">${h(shpData.error)}</div></div>`; return; }
  if(!shpData||shpData.missing){ body.innerHTML='<div class="card"><div class="empty">Të dhënat e transportit (blloku K) ende s\'janë lexuar nga WMS — vijnë me rifreskimin e ardhshëm të WMS Pulse (çdo orë).</div></div>'; return; }
  $('#shpAt').textContent='WMS: '+(shpData.gen? shpDT(shpData.gen.replace('T',' ')) : '—');
  const all=shpRows(), inWh=all.filter(x=>shpWh==='all'||String(x.w)===shpWh);
  $('#shpTabs').innerHTML=['K','I'].map(k=>`<button class="btn ${shpTab===k?'primary':''}" data-shptab="${k}">${k==='K'?'🚚':'🌍'} ${SHP_CAT[k].name} (${inWh.filter(x=>x.cat===k).length})</button>`).join('')
    + `<select id="shpWh" style="width:auto;min-height:34px;margin-left:auto"><option value="all" ${shpWh==='all'?'selected':''}>Të gjitha depot</option>${[...new Set(all.map(x=>x.w))].sort((a,b)=>a-b).map(w=>`<option value="${w}" ${String(w)===shpWh?'selected':''}>Depo ${h(SHP_WH[w]||w)}</option>`).join('')}</select>`;
  $$('[data-shptab]').forEach(b=>b.onclick=()=>{ shpTab=b.dataset.shptab; shpGroup=null; shpSel=null; shpState=''; shpLimit=200; shpDraw(); });
  $('#shpWh').onchange=e=>{ shpWh=e.target.value; shpSel=null; shpDraw(); };
  const rows=inWh.filter(x=>x.cat===shpTab), grp=shpGroup||SHP_CAT[shpTab].def;
  const key=x=> grp==='country'? x.country : grp==='supplier'? x.supplier : grp==='carrier'? x.carrier : grp==='state'? shpStateMeta(x.state)[1] : 'Depo '+(SHP_WH[x.w]||x.w);
  // KPIs of the category
  const arrived=rows.filter(x=>x.arr), late=rows.filter(x=>x.state==='late'), overdue=rows.filter(x=>x.state==='overdue'), coming=rows.filter(x=>x.state==='transit'||x.state==='planned');
  const units=rows.reduce((a,x)=>a+(+x.units||0),0), cost=rows.reduce((a,x)=>a+(+x.pr||0),0), pal=rows.reduce((a,x)=>a+(+x.pal||0),0);
  const tr=arrived.map(x=>x.transit).filter(v=>v!=null&&v>=0).sort((a,b)=>a-b), med=tr.length? tr[Math.floor(tr.length/2)] : null;
  const kpi=(lbl,val,foot,cls)=>`<div class="kpi ${cls||''}"><div class="lbl">${lbl}</div><div class="val">${val}</div>${foot?`<div class="foot">${foot}</div>`:''}</div>`;
  const kpis=`<div class="grid g-kpi" style="margin-bottom:12px">
      ${kpi('Ndalesa (30 ditë + në rrugë)', rows.length.toLocaleString('de-DE'), SHP_CAT[shpTab].desc)}
      ${kpi('Mbërritur', arrived.length.toLocaleString('de-DE'), arrived.length? Math.round(late.length/arrived.length*100)+'% me vonesë ('+late.length+')' : '', late.length/Math.max(1,arrived.length)>0.2? 'st-warn':'')}
      ${kpi('Pa mbërritje pas datës', overdue.length, overdue.length? 'data e pritur ka kaluar' : 'asnjë', overdue.length? 'st-crit':'st-ok')}
      ${kpi('Në rrugë / planifikuar', coming.length, coming.length? 'e para: '+shpD(coming.map(x=>x.eta).filter(Boolean).sort()[0]) : '')}
      ${kpi('Marrja → mbërritja', med!=null? med+' ditë' : '—', 'mediana e ndalesave të mbërritura')}
      ${kpi('Njësi të pranuara', units.toLocaleString('de-DE'), 'nga faturat e lidhura')}
      ${kpi('Kosto e transportit', shpEur(cost), rows.filter(x=>!(+x.pr>0)).length+' ndalesa pa çmim')}
      ${kpi('Paleta', pal? pal.toLocaleString('de-DE') : '—', rows.filter(x=>+x.pal>0).length+'/'+rows.length+' me palet të regjistruara', pal? '' : 'st-warn')}</div>`;
  // groups ("sipas kategorisë")
  // by supplier a stop belongs to each of its suppliers (one truck can carry goods of several)
  const keysOf=x=> grp==='supplier'? (x.sups.length? [...new Set(x.sups.map(shpSupName))] : [x.cat==='I'? 'Pa faturë' : 'Pa shitës']) : [key(x)];
  const groups={}; rows.forEach(x=>keysOf(x).forEach(k=>{ (groups[k]=groups[k]||[]).push(x); }));
  const glist=Object.entries(groups).sort((a,b)=>b[1].length-a[1].length);
  const gcard=([k,arr])=>{ const a=arr.filter(x=>x.arr), l=arr.filter(x=>x.state==='late').length, o=arr.filter(x=>x.state==='overdue').length, c=arr.filter(x=>x.state==='transit'||x.state==='planned').length;
    const carriers=[...new Set(arr.map(x=>x.carrier))], countries=[...new Set(arr.map(x=>x.country))], sups=[...new Set(arr.filter(x=>x.cat==='I').map(x=>x.supplier))];
    return `<div class="card" data-shpg="${h(k)}" style="cursor:pointer;${shpSel===k?'border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)':''}">
      <h3>${h(k)} <span class="sub">${arr.length} ndalesa</span></h3>
      <div class="small">${a.length} mbërritur · <b style="color:${l/Math.max(1,a.length)>0.2?'var(--warn)':'inherit'}">${a.length? Math.round(l/a.length*100) : 0}% me vonesë</b> · ${o? `<b style="color:var(--crit)">${o} pa mbërritje</b> · ` : ''}${c} në rrugë</div>
      <div class="small faint" style="margin-top:4px">${grp==='supplier'? carriers.slice(0,4).map(h).join(', ')+' · '+countries.slice(0,3).map(h).join(', ') : grp!=='carrier'? carriers.slice(0,4).map(h).join(', ') : countries.slice(0,4).map(h).join(', ')}${sups.length && grp!=='supplier'? '<br>Furnizues: '+sups.slice(0,5).map(h).join(', ')+(sups.length>5? '…' : '') : ''} · ${shpEur(arr.reduce((s,x)=>s+(+x.pr||0),0))} · ${arr.reduce((s,x)=>s+(+x.units||0),0).toLocaleString('de-DE')} njësi</div></div>`; };
  // table
  const q=shpQuery.trim().toLowerCase();
  let list=rows.filter(x=>(!shpSel||keysOf(x).includes(shpSel)) && (!shpState||x.state===shpState) && (!q || [x.carrier,x.supplier,x.o,x.country,x.sid,x.did].join(' ').toLowerCase().includes(q)));
  const rank={overdue:0,transit:1,planned:2,late:3,arrived:4};
  list.sort((a,b)=>(rank[a.state]-rank[b.state]) || String(b.eta||'').localeCompare(String(a.eta||'')));
  const shown=list.slice(0,shpLimit);
  body.innerHTML= kpis
    + `<div class="card no-print" style="margin-bottom:10px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><b class="small">Kategoritë sipas:</b>
        ${Object.entries(SHP_GROUPS).filter(([k])=>!(shpTab==='K'&&(k==='country'||k==='supplier'))).map(([k,l])=>`<button class="btn sm ${grp===k?'primary':''}" data-shpgrp="${k}">${l}</button>`).join('')}
        ${shpSel? `<button class="btn sm ghost" id="shpClear">✕ ${h(shpSel)}</button>` : ''}</div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;margin-bottom:12px">${glist.map(gcard).join('')||'<div class="empty">Asnjë ndalesë.</div>'}</div>
    <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <b>${shpSel? h(shpSel) : 'Të gjitha ndalesat'} — ${list.length}</b>
        <select id="shpState" style="width:auto;min-height:32px;margin-left:auto"><option value="">Gjendja: të gjitha</option>${SHP_STATES.map(s=>`<option value="${s[0]}" ${shpState===s[0]?'selected':''}>${s[1]}</option>`).join('')}</select>
        <input type="search" id="shpQ" placeholder="Kërko furnizues, transportues, origjinë, ID…" value="${h(shpQuery)}" style="width:220px;min-height:32px"></div>
      <div class="tablewrap"><table><thead><tr><th>ID</th><th>Gjendja</th>${shpTab==='I'?'<th>Vendi</th>':''}<th class="wrap">Origjina</th><th>Transportuesi</th><th>${shpTab==='I'?'Furnizuesi':'Shitës'}</th><th>Depo</th><th>Marrja</th><th>E pritur</th><th>Mbërritja</th><th>Tranzit</th><th>Palet</th><th>Kosto</th><th>Fatura</th><th>Njësi</th><th>Check-in</th></tr></thead><tbody>
      ${shown.length? shown.map(x=>`<tr data-shprow="${x.did}" style="cursor:pointer"><td class="small"><b>#${x.sid}</b>${x.dor>1?'<span class="faint">/'+x.dor+'</span>':''}</td><td>${shpBadge(x.state)}<div class="small faint">status ${h(x.st)}${shpStName(x.st)? ' · '+h(shpStName(x.st)) : ''}</div>${shpStStale(x)? '<div class="small" style="color:var(--warn)">WMS s&#39;është përditësuar</div>' : ''}</td>
        ${shpTab==='I'?`<td class="small">${h(x.country)}</td>`:''}<td class="wrap small">${h(x.o||'—')}</td><td class="small">${h(x.carrier)}</td><td class="small">${x.sups.length? x.sups.map(id=>`<span title="StoreId ${h(id)}${shpStore(id)? ' · dyqani në WMS: '+h(shpStore(id)) : ''}${shpTab==='I'&&shpSupInferred(id)?' · emër i nxjerrë, konfirmo te Furnizuesit':''}">${h(shpSupName(id))}${shpTab==='I'&&shpSupInferred(id)?'<sup class="faint">?</sup>':''}</span>`).join(' + ') : '<span class="faint">—</span>'}</td><td class="small">${h(SHP_WH[x.w]||x.w)}</td>
        <td class="small">${shpD(x.pick)}</td><td class="small">${shpD(x.eta)}</td><td class="small">${x.arr? shpDT(x.arr) : x.state==='overdue'? '<b style="color:var(--crit)">'+Math.round((Date.now()-shpT(x.eta))/864e5)+' ditë vonesë</b>' : '—'}</td>
        <td class="small">${x.transit!=null&&x.transit>=0? x.transit+' d' : '—'}</td><td class="small">${+x.pal>0? x.pal : '—'}</td><td class="small">${+x.pr>0? shpEur(x.pr) : '<span class="faint">—</span>'}</td>
        <td class="small">${x.inv||0}</td><td class="small">${x.units? (+x.units).toLocaleString('de-DE') : '—'}</td><td class="small">${x.ci1? shpDT(x.ci1) : '—'}</td></tr>`).join('')
        : `<tr><td colspan="16"><div class="empty">Asnjë ndalesë me këta filtra.</div></td></tr>`}</tbody></table></div>
      ${list.length>shown.length? `<div class="btnrow" style="margin-top:8px"><button class="btn sm" id="shpMore">Shfaq edhe ${Math.min(200,list.length-shown.length)} (${list.length-shown.length} të tjera)</button></div>` : ''}
      <div class="hint">Gjendja: <b>me vonesë</b> = data e mbërritjes pas datës së pritur (krahasim datash); <b>pa mbërritje pas datës</b> = data e pritur ka kaluar dhe s'ka mbërritje të regjistruar. Statusi i WMS-it (10 → 60) shfaqet si numër — kuptimi i pakonfirmuar. Kategoria Kombëtare / Ndërkombëtare vjen nga SupplierType (10 / 20), e nxjerrë nga emrat e origjinës. Faturat numërohen, nuk listohen. Furnizuesi = StoreId i faturave të ndalesës (WMS s'ka emrat); <sup>?</sup> = emër i nxjerrë, konfirmoje te Furnizuesit.</div></div>`
    + (shpTab==='I'? shpSupEditorHTML(rows) : '');
  $$('[data-shpgrp]').forEach(b=>b.onclick=()=>{ shpGroup=b.dataset.shpgrp; shpSel=null; shpLimit=200; shpDraw(); });
  $$('[data-shpg]').forEach(c=>c.onclick=()=>{ shpSel= shpSel===c.dataset.shpg? null : c.dataset.shpg; shpLimit=200; shpDraw(); });
  if($('#shpClear')) $('#shpClear').onclick=()=>{ shpSel=null; shpDraw(); };
  $('#shpState').onchange=e=>{ shpState=e.target.value; shpLimit=200; shpDraw(); };
  $('#shpQ').oninput=e=>{ shpQuery=e.target.value; clearTimeout(shpDraw._t); shpDraw._t=setTimeout(()=>{ shpDraw(); const el=$('#shpQ'); if(el){ el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 250); };
  if($('#shpMore')) $('#shpMore').onclick=()=>{ shpLimit+=200; shpDraw(); };
  $$('[data-shprow]').forEach(r=>r.onclick=()=>shpDetail(rows.find(x=>String(x.did)===r.dataset.shprow)));
  if($('#shpSupSave')) $('#shpSupSave').onclick=()=>{ const cfg=Object.assign({}, shpSupCfg());
    $$('[data-supid]').forEach(el=>{ const id=el.dataset.supid, v=el.value.trim(); if(v) cfg[id]={name:v, at:nowISO()}; else delete cfg[id]; });
    Store.db.config.suppliers=cfg; Store.persist(); toast('Furnizuesit u ruajtën'); shpDraw(); };
}
/* supplier names: every StoreId seen on international stops, with where it comes from; the lead confirms or names them */
function shpSupEditorHTML(rows){
  const by={}; rows.forEach(x=>x.sups.forEach(id=>{ const o=by[id]=by[id]||{id, n:0, carriers:new Set(), countries:new Set()}; o.n++; o.carriers.add(x.carrier); o.countries.add(x.country); }));
  const list=Object.values(by).sort((a,b)=>b.n-a.n); if(!list.length) return '';
  const unknown=list.filter(x=>shpSupUnknown(x.id)).length;
  return `<div class="card no-print" style="margin-top:12px"><h3>Furnizuesit <span class="sub">${list.length} furnizues në këto ndalesa${unknown? ' · '+unknown+' pa emër' : ''}</span></h3>
    <div class="small faint" style="margin-bottom:8px">WMS-i ruan vetëm numrin e dyqanit (StoreId) te faturat. Shkruaj emrin e furnizuesit një herë — ruhet në app dhe shfaqet në çdo ndalesë. Emrat me <sup>?</sup> janë nxjerrë nga origjina, transportuesi dhe formati i faturave.</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px">${list.map(x=>`<div class="field" style="margin:0"><label>StoreId ${h(x.id)}${shpStore(x.id)? ' = <b>'+h(shpStore(x.id))+'</b> (WMS)' : ''} · ${x.n} ndalesa · ${[...x.countries].slice(0,2).map(h).join(', ')} · ${[...x.carriers].slice(0,2).map(h).join(', ')}${shpSupInferred(x.id)? ' · <i>i nxjerrë</i>' : ''}</label>
      <input type="text" data-supid="${h(x.id)}" value="${h((shpSupCfg()[x.id]||{}).name||'')}" placeholder="${h(SHP_SUP_SEED[x.id]? SHP_SUP_SEED[x.id]+' (i nxjerrë)' : 'emri i furnizuesit')}"></div>`).join('')}</div>
    <div class="btnrow" style="margin-top:8px"><button class="btn sm primary" id="shpSupSave">Ruaj emrat</button><span class="small faint">Fushë bosh = përdoret emri i nxjerrë ose numri.</span></div></div>`;
}
function shpDetail(x){
  if(!x) return;
  const tr=(shpData.trucks||[]).find(t=>t.id===x.tr);
  const row=(l,v)=>`<tr><th style="text-align:left;width:42%">${l}</th><td>${v}</td></tr>`;
  openModal(`Dërgesa #${x.sid}${x.dor>1?' / ndalesa '+x.dor:''} · ${SHP_CAT[x.cat].name}`, `<table class="small" style="width:100%">
    ${row('Gjendja', shpBadge(x.state)+' · status WMS '+h(x.st)+(shpStName(x.st)? ' = '+h(shpStName(x.st)) : '')+(shpStStale(x)? ' — <span style="color:var(--warn)">data e marrjes ka kaluar, por WMS ende shënon Scheduled</span>' : ''))}
    ${row('Transportuesi', h(x.carrier)+(tr? ' · kamion #'+tr.id+(tr.mp? ' (deri '+tr.mp+' paleta)' : '') : ''))}
    ${row(x.cat==='I'? 'Furnizuesi' : 'Shitës', x.cat==='I'? (x.sups.length? x.sups.map(id=>h(shpSupName(id))+' <span class="faint">(StoreId '+h(id)+(shpStore(id)&&shpStore(id)!==shpSupName(id)? ', dyqani në WMS: '+h(shpStore(id)) : '')+(shpSupInferred(id)? ', emër i nxjerrë' : '')+')</span>').join('<br>') : 'pa faturë të lidhur') : (x.sups.length? x.sups.map(id=>h(shpSupName(id))+' <span class="faint">(StoreId '+h(id)+')</span>').join('<br>') : 'pa shitës të lidhur'))}
    ${row('Origjina', h(x.o||'—')+(x.cat==='I'? ' · '+h(x.country) : ''))}
    ${row('Depoja', h(SHP_WH[x.w]||x.w))}
    ${row('Marrja te furnitori', shpDT(x.pick))}
    ${row('Mbërritja e pritur', shpDT(x.eta))}
    ${row('Mbërritja reale', x.arr? shpDT(x.arr) : '<b>e paregjistruar</b>')}
    ${row('Marrja → mbërritja', x.transit!=null&&x.transit>=0? x.transit+' ditë' : '—')}
    ${row('Vonesa ndaj datës së pritur', x.arr&&x.eta? shpDays(x.eta.slice(0,10)+' 00:00', x.arr.slice(0,10)+' 00:00')+' ditë' : x.state==='overdue'? Math.round((Date.now()-shpT(x.eta))/864e5)+' ditë (pa mbërritje)' : '—')}
    ${row('Paleta', +x.pal>0? x.pal : 'të paregjistruara')}
    ${row('Kosto e transportit', +x.pr>0? shpEur(x.pr) : 'pa çmim')}
    ${row('Distanca', x.km? x.km+' km' : '—')}
    ${row('Fatura të lidhura', x.inv||0)}
    ${row('Njësi të pranuara (check-in)', x.units? (+x.units).toLocaleString('de-DE') : '—')}
    ${row('Check-in i parë → i fundit', x.ci1? shpDT(x.ci1)+' → '+shpDT(x.ci2) : '—')}
    ${row('Mbërritja → check-in i parë', x.toCheckin!=null? (x.toCheckin<0? 'check-in para regjistrimit të mbërritjes' : x.toCheckin+' ditë') : '—')}
    </table><div class="hint">Burimi: WMS (Shipments, ShipmentDestinations, Invoices → Supply_Invoice_Mapping → ProductCheckIns), vetëm lexim.</div>`,
    `<button class="btn ghost" id="mcancel">Mbyll</button>`);
  $('#mcancel').onclick=closeModal;
}
