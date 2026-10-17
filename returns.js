/* =========================================================================
   KTHIMET (Returns) — returned products, from WMS.
   pulse/build.js puts the WMS "Product Transfer/Return" flow into /pulse/data → returns, refreshed hourly with WMS
   Pulse (query block L): Returns = one batch per store, TransferTypeId 1 = "Supplier Return" (kthim te furnitori),
   2 = "Warehouse Transfer" — the names the WMS web filter uses; ReturnDetails = one row per unit. Plus the products
   returned by customers and their disposition from the WMS "Returns" dashboard: 20 Map as defect, 21 Map as outlet,
   22 Return to stock, 29 Auction. Store names come from the WMS web app through the agent (/wms/stores), because the
   database has no store table. The free-text reason of a batch is sorted into categories by keywords; the text itself
   is shown only in a batch's detail. Staff appear as initials. Loaded after shared.js and before app.js.
   =======================================================================*/
let retData=null, retStores=null, retView='supplier', retStat='reason', retQuery='', retDispF='', retLimit=200, retSeq=0;
const RET_DISP={20:['Defekt','b-crit'],21:['Outlet','b-warn'],22:['Kthyer në stok','b-ok'],29:['Ankand','b-new']};
const RET_UNIT_ST={32:'32 · në kthim (e nxjerrë)',7:'Në raft (7)',4:'Check-out (4)',18:'Check-out (18)',6:'Para mapimit (6)',20:'Defekt (20)',21:'Outlet (21)',22:'Kthyer në stok (22)',29:'Ankand (29)',26:'26'};
const RET_CATS=[
  ['Refuzim nga klienti', /refuz|refzu|refruz|reduzuar/i], ['Anulim i porosisë', /anul|annul|anuuli/i],
  ['Defekt / servisim', /servis|riparim|defekt|nuk punon|nuk ndizet|nuk mbushet|nuk ftoh|nuk rregullohet|zhurm|nuk funksion|bateri/i],
  ['I dëmtuar / i hapur / i përdorur', /dëmt|demt|thyer|njolla|hapur|përdor|perdor|pa mang|pa mbajtese|mungoj/i],
  ['Ekstra / i dyfishtë', /ekstra|shtes|2 her|dy her|dyfish/i], ['Produkt i gabuar / madhësi', /gabim|madh|vogl|vogel|pershtat|përshtat|nuanc|ngjyr|njejt|zevendes|ne vend te/i],
  ['Afat i skaduar', /afat|skad/i], ['Marketing / dhuratë', /marketing|kola|gift|gratis/i], ['Transfer / furnizim', /prizren|transfer|stock per|furnizim|terheq|tërheq/i],
  ['Pa porosi aktive', /porosi aktive|ska porosi|nuk ka porosi|akrive/i], ['Kthim (pa detaje)', /kthim/i]];
function retCat(t){ const s=String(t||'').trim(); if(!s||s==='.') return 'Pa arsye'; const c=RET_CATS.find(([,re])=>re.test(s)); return c? c[0] : 'Tjetër'; }
function retStoreName(id, batchName){ const s=retStores&&retStores.stores&&retStores.stores[id]; if(s) return s;
  const n=String(batchName||'').split('_')[0].trim(); return n && !/^\d+$/.test(n)? n : '#'+id; }
const retD=s=>s? s.slice(8,10)+'.'+s.slice(5,7)+'.'+s.slice(2,4) : '—';
const retDT=s=>s? s.slice(8,10)+'.'+s.slice(5,7)+' '+s.slice(11,16) : '—';
const retMask=s=>String(s||'').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g,'[email]').replace(/\+?\d[\d\s\-/]{7,}\d/g,m=>/^\d{6,8}$/.test(m.trim())? m : '[nr]');

function renderReturns(v){
  v.innerHTML = pagehead('Kthimet','Produktet e kthyera nga WMS: <b>kthimet te furnitori</b> (Supplier Return), <b>transferimet mes depove</b> dhe <b>produktet e kthyera nga klientët</b> me vendimin (defekt, outlet, kthim në stok, ankand). Rifreskohet çdo orë bashkë me WMS Pulse.',
      `<span class="small faint" id="retAt"></span>`)
    + `<div class="btnrow no-print" id="retTabs" style="margin-bottom:10px"></div><div id="retBody"><div class="empty">Po ngarkohet…</div></div>`;
  if(!wmsOnAgent()){ $('#retBody').innerHTML='<div class="card"><div class="empty">Hape app-in nga http://localhost:8790.</div></div>'; return; }
  if(retData) retDraw(); retLoad();
}
async function retLoad(){
  const seq=++retSeq;
  try{ const [d,s]=await Promise.all([fetch('/pulse/data',{cache:'no-store'}).then(r=>r.json()), fetch('/wms/stores',{cache:'no-store'}).then(r=>r.json()).catch(()=>null)]);
    if(seq!==retSeq) return; retData=d.returns||{missing:true}; retStores=s; }
  catch(e){ retData={error:'Agjenti nuk përgjigjet ('+e.message+').'}; }
  if($('#retBody')) retDraw();
}
function retModel(){
  const B={}; (retData.batches||[]).forEach(b=>{ B[b.id]=Object.assign({}, b, {store:retStoreName(b.st,b.nm), cat:retCat(b.rsn)}); });
  const units=(retData.units||[]).map(u=>{ const b=B[u.rid]; return Object.assign({}, u, {b, tt:b? b.tt : null, store:b? b.store : retStoreName(u.cst), cat:b? b.cat : '—'}); });
  const disp=(retData.disp||[]).map(x=>Object.assign({}, x, {store:retStoreName(x.cst)}));
  return {B, batches:Object.values(B).sort((a,b)=>b.id-a.id), units, disp};
}
function retDraw(){
  const body=$('#retBody'); if(!body) return;
  if(retData&&retData.error){ body.innerHTML=`<div class="card"><div class="empty">${h(retData.error)}</div></div>`; return; }
  if(!retData||retData.missing){ body.innerHTML='<div class="card"><div class="empty">Të dhënat e kthimeve (blloku L) ende s\'janë lexuar nga WMS — vijnë me rifreskimin e ardhshëm të WMS Pulse (çdo orë).</div></div>'; return; }
  $('#retAt').textContent='WMS: '+(retData.gen? retDT(retData.gen.replace('T',' ')) : '—')+(retStores&&retStores.stores&&Object.keys(retStores.stores).length? ' · '+Object.keys(retStores.stores).length+' dyqane' : '');
  const M=retModel();
  const views=[['supplier','↩️ Kthime te furnitori',M.batches.filter(b=>b.tt===1).length],['transfer','🔁 Transferime mes depove',M.batches.filter(b=>b.tt===2).length],['customer','📦 Nga klientët',M.disp.length],['stats','📊 Statistika',null]];
  $('#retTabs').innerHTML=views.map(([k,l,n])=>`<button class="btn ${retView===k?'primary':''}" data-retv="${k}">${l}${n!=null?' ('+n+')':''}</button>`).join('');
  $$('[data-retv]').forEach(b=>b.onclick=()=>{ retView=b.dataset.retv; retQuery=''; retLimit=200; retDraw(); });
  ({supplier:()=>retDrawBatches(body,M,1), transfer:()=>retDrawBatches(body,M,2), customer:()=>retDrawCustomer(body,M), stats:()=>retDrawStats(body,M)})[retView]();
}
const retKpi=(lbl,val,foot,cls)=>`<div class="kpi ${cls||''}"><div class="lbl">${lbl}</div><div class="val">${val}</div>${foot?`<div class="foot">${foot}</div>`:''}</div>`;
const retTop=(arr,key,n)=>{ const c={}; arr.forEach(x=>{ const k=key(x); c[k]=(c[k]||0)+1; }); return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,n||8); };
function retSearchBox(ph){ return `<input type="search" id="retQ" placeholder="${h(ph)}" value="${h(retQuery)}" style="width:240px;min-height:32px">`; }
function retWireSearch(){ const el=$('#retQ'); if(el) el.oninput=e=>{ retQuery=e.target.value; clearTimeout(retDraw._t); retDraw._t=setTimeout(()=>{ retDraw(); const x=$('#retQ'); if(x){ x.focus(); x.setSelectionRange(x.value.length,x.value.length); } },250); }; }

/* returns to supplier (tt 1) and warehouse transfers (tt 2): batches + the returned products */
function retDrawBatches(body, M, tt){
  const bs=M.batches.filter(b=>b.tt===tt), us=M.units.filter(u=>u.tt===tt), q=retQuery.trim().toLowerCase();
  const d30=new Date(Date.now()-30*864e5).toISOString().slice(0,10), b30=bs.filter(b=>b.ins.slice(0,10)>=d30);
  const topCat=retTop(bs,b=>b.cat,1)[0], topStore=retTop(us,u=>u.store,1)[0];
  const kp=`<div class="grid g-kpi" style="margin-bottom:12px">
    ${retKpi(tt===1?'Kthime te furnitori (120 ditë)':'Transferime (120 ditë)', bs.length, b30.length+' në 30 ditët e fundit')}
    ${retKpi('Produkte (njësi, 90 ditë)', us.length.toLocaleString('de-DE'), us.filter(u=>u.res).length+' të zgjidhura')}
    ${retKpi(tt===1?'Furnitorë / dyqane':'Depo destinacioni', tt===1? new Set(bs.map(b=>b.st)).size : [...new Set(bs.map(b=>b.dw))].map(w=>w==null?'—':'#'+w).join(', '), '')}
    ${retKpi('Arsyeja më e shpeshtë', topCat? h(topCat[0]) : '—', topCat? topCat[1]+' kthime' : '')}
    ${retKpi('Më shumë produkte', topStore? h(topStore[0]) : '—', topStore? topStore[1]+' njësi' : '')}</div>`;
  const fb=bs.filter(b=>!q || [b.store,b.cat,b.rsn,b.nm,b.id].join(' ').toLowerCase().includes(q));
  const fu=us.filter(u=>!q || [u.store,u.cat,u.pc,u.pn,u.rid].join(' ').toLowerCase().includes(q));
  body.innerHTML= kp + `<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <b>${tt===1?'Kthimet te furnitori':'Transferimet'} — ${fb.length}</b><span style="margin-left:auto"></span>${retSearchBox('Kërko dyqan, arsye, kod produkti…')}</div>
    <div class="tablewrap"><table><thead><tr><th>Nr.</th><th>Data</th><th>${tt===1?'Furnitori / dyqani':'Dyqani'}</th><th>Arsyeja</th>${tt===2?'<th>Depo</th>':''}<th>Produkte</th><th>Të zgjidhura</th></tr></thead><tbody>
    ${fb.slice(0,retLimit).map(b=>`<tr data-retb="${b.id}" style="cursor:pointer"><td class="small"><b>#${b.id}</b></td><td class="small">${retDT(b.ins)}</td><td class="small">${h(b.store)}</td>
      <td class="small">${h(b.cat)}</td>${tt===2?`<td class="small">${b.dw!=null? '#'+h(b.dw) : '—'}</td>`:''}<td class="small">${b.n}</td><td class="small">${b.res}/${b.n}</td></tr>`).join('') || `<tr><td colspan="7"><div class="empty">Asnjë.</div></td></tr>`}</tbody></table></div>
    ${fb.length>retLimit? `<div class="btnrow" style="margin-top:8px"><button class="btn sm" id="retMore">Shfaq më shumë (${fb.length-retLimit})</button></div>` : ''}</div>
    <div class="card"><h3>Produktet e kthyera <span class="sub">${fu.length} njësi · 90 ditët e fundit</span></h3>
    <div class="tablewrap"><table><thead><tr><th>Data</th><th>Kodi i produktit</th><th class="wrap">Emri</th><th>${tt===1?'Furnitori':'Dyqani'}</th><th>Arsyeja</th><th>Gjendja tani</th><th>Zgjidhur</th><th>Kthimi</th></tr></thead><tbody>
    ${fu.slice(0,retLimit).map(u=>`<tr><td class="small">${retDT(u.ins)}</td><td class="small"><b>${h(u.pc||'—')}</b></td><td class="wrap small">${h(u.pn||'—')}</td><td class="small">${h(u.store)}</td>
      <td class="small">${h(u.cat)}</td><td class="small">${h(RET_UNIT_ST[u.cs]||u.cs||'—')}</td><td class="small">${u.res?'✓':'—'}</td><td class="small"><a href="#" data-retb="${u.rid}">#${u.rid}</a></td></tr>`).join('') || `<tr><td colspan="8"><div class="empty">Asnjë produkt.</div></td></tr>`}</tbody></table></div>
    <div class="hint">Arsyeja vjen nga teksti i lirë i kthimit (renditur sipas fjalëve kyçe). Gjendja 32 = njësia në procesin e kthimit (kuptimi i nxjerrë, jo i konfirmuar). Emri i produktit shfaqet vetëm kur gjendet në katalogun e GjirafaMall-it.</div></div>`;
  $$('[data-retb]').forEach(el=>el.onclick=e=>{ e.preventDefault(); retBatchDetail(M, +el.dataset.retb); });
  if($('#retMore')) $('#retMore').onclick=()=>{ retLimit+=200; retDraw(); };
  retWireSearch();
}
function retBatchDetail(M, id){
  const b=M.B[id]; if(!b){ toast('Kthimi #'+id+' është më i vjetër se 120 ditë.'); return; }
  const us=M.units.filter(u=>u.rid===id);
  openModal(`Kthimi #${b.id} · ${b.tt===1?'Supplier Return':b.tt===2?'Warehouse Transfer':'lloji '+b.tt}`, `<table class="small" style="width:100%">
      <tr><th style="text-align:left;width:35%">Data</th><td>${retDT(b.ins)}</td></tr>
      <tr><th style="text-align:left">${b.tt===1?'Furnitori / dyqani':'Dyqani'}</th><td>${h(b.store)} <span class="faint">(StoreId ${h(b.st)})</span></td></tr>
      <tr><th style="text-align:left">Arsyeja</th><td><b>${h(b.cat)}</b><div class="faint">${h(retMask(b.rsn)||'—')}</div></td></tr>
      ${b.tt===2? `<tr><th style="text-align:left">Depoja e destinacionit</th><td>${b.dw!=null? '#'+h(b.dw) : '—'}</td></tr>` : ''}
      <tr><th style="text-align:left">Produkte</th><td>${b.n} (${b.res} të zgjidhura)</td></tr></table>
    <div class="formsection">Produktet${us.length<b.n? ' (shfaqen ato të 90 ditëve të fundit)' : ''}</div>
    <div class="tablewrap"><table class="small"><thead><tr><th>Kodi</th><th class="wrap">Emri</th><th>Gjendja tani</th><th>Zgjidhur</th></tr></thead><tbody>
    ${us.map(u=>`<tr><td><b>${h(u.pc||'—')}</b></td><td class="wrap">${h(u.pn||'—')}</td><td>${h(RET_UNIT_ST[u.cs]||u.cs||'—')}</td><td>${u.res?'✓':'—'}</td></tr>`).join('')||'<tr><td colspan="4" class="faint">—</td></tr>'}</tbody></table></div>`,
    `<button class="btn ghost" id="mcancel">Mbyll</button>`);
  $('#mcancel').onclick=closeModal;
}

/* products returned by customers and their disposition */
function retDrawCustomer(body, M){
  const q=retQuery.trim().toLowerCase(), all=M.disp;
  const by=t=>all.filter(x=>x.t===t).length;
  const list=all.filter(x=>(!retDispF||String(x.t)===retDispF) && (!q || [x.pc,x.pn,x.store,x.oid].join(' ').toLowerCase().includes(q)));
  body.innerHTML=`<div class="grid g-kpi" style="margin-bottom:12px">
      ${retKpi('Produkte me vendim (90 ditë)', all.length.toLocaleString('de-DE'), 'nga paneli "Returns" i WMS-it')}
      ${[21,22,20,29].map(t=>retKpi(RET_DISP[t][0], by(t).toLocaleString('de-DE'), all.length? Math.round(by(t)/all.length*100)+'%' : '', t===20&&by(20)/Math.max(1,all.length)>0.2?'st-warn':'')).join('')}</div>
    <div class="card"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px"><b>Produktet e kthyera nga klientët — ${list.length}</b>
      <select id="retDispF" style="width:auto;min-height:32px;margin-left:auto"><option value="">Vendimi: të gjitha</option>${[21,22,20,29].map(t=>`<option value="${t}" ${retDispF===String(t)?'selected':''}>${RET_DISP[t][0]}</option>`).join('')}</select>
      ${retSearchBox('Kërko kod, emër, dyqan, porosi…')}</div>
    <div class="tablewrap"><table><thead><tr><th>Data</th><th>Vendimi</th><th>Kodi i produktit</th><th class="wrap">Emri</th><th>Dyqani</th><th>Porosia</th><th>Nga</th></tr></thead><tbody>
    ${list.slice(0,retLimit).map(x=>`<tr><td class="small">${retDT(x.ins)}</td><td><span class="badge ${RET_DISP[x.t][1]}">${RET_DISP[x.t][0]}</span></td><td class="small"><b>${h(x.pc||'—')}</b></td>
      <td class="wrap small">${h(x.pn||'—')}</td><td class="small">${h(x.store)}</td><td class="small">${x.oid>0? h(x.oid)+(x.pf? ' <span class="faint">'+(x.pf===2?'G50':'GM')+'</span>' : '') : '—'}</td><td class="small">${h(x.ui||'—')}</td></tr>`).join('') || `<tr><td colspan="7"><div class="empty">Asnjë.</div></td></tr>`}</tbody></table></div>
    ${list.length>retLimit? `<div class="btnrow" style="margin-top:8px"><button class="btn sm" id="retMore">Shfaq më shumë (${list.length-retLimit})</button></div>` : ''}
    <div class="hint">Vendimet vijnë nga paneli "Returns" i WMS-it: Map as defect (20), Map as outlet (21), Return to stock (22), Auction (29). "Nga" = inicialet e punonjësit që e regjistroi.</div></div>`;
  $('#retDispF').onchange=e=>{ retDispF=e.target.value; retLimit=200; retDraw(); };
  if($('#retMore')) $('#retMore').onclick=()=>{ retLimit+=200; retDraw(); };
  retWireSearch();
}

/* statistics: one button per view */
function retDrawStats(body, M){
  const STATS=[['reason','Sipas arsyes'],['store','Sipas furnitorit'],['product','Sipas produktit'],['month','Sipas muajit'],['disp','Sipas vendimit (klientët)'],['legacy','Kthimet e vjetra']];
  const bar=(label,val,max,color,sub)=>`<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:12.5px;gap:8px"><span class="wrap">${label}</span><span class="muted">${sub!=null?sub:val}</span></div>
    <div style="height:12px;background:var(--bg);border-radius:6px;overflow:hidden;margin-top:3px;border:1px solid var(--line)"><i style="display:block;height:100%;width:${max>0?Math.max(2,Math.round(val/max*100)):0}%;background:${color||'var(--accent)'}"></i></div></div>`;
  const sup=M.batches.filter(b=>b.tt===1), supU=M.units.filter(u=>u.tt===1);
  let html='';
  if(retStat==='reason'){
    const c=retTop(sup,b=>b.cat,20), cu=retTop(supU,u=>u.cat,20), mx=Math.max(1,...c.map(x=>x[1]));
    html=`<div class="grid g-2"><div class="card"><h3>Kthime te furnitori sipas arsyes <span class="sub">${sup.length} kthime · 120 ditë</span></h3>${c.map(([k,n])=>bar(h(k),n,mx,'var(--imp)',n+' ('+Math.round(n/Math.max(1,sup.length)*100)+'%)')).join('')}</div>
      <div class="card"><h3>Produkte sipas arsyes <span class="sub">${supU.length} njësi · 90 ditë</span></h3>${cu.map(([k,n])=>bar(h(k),n,Math.max(1,...cu.map(x=>x[1])),'var(--warn)',n+' njësi')).join('')}</div></div>
      <div class="hint">Arsyet janë grupuar nga teksti i lirë i secilit kthim me fjalë kyçe (refuzim, anulim, defekt, i dëmtuar, ekstra, gabim/madhësi, afat, marketing, transfer…).</div>`;
  } else if(retStat==='store'){
    const st={}; sup.forEach(b=>{ const o=st[b.store]=st[b.store]||{b:0,n:0,cats:{}}; o.b++; o.n+=b.n; o.cats[b.cat]=(o.cats[b.cat]||0)+1; });
    const rows=Object.entries(st).sort((a,b)=>b[1].n-a[1].n), mx=Math.max(1,...rows.map(r=>r[1].n));
    html=`<div class="card"><h3>Kthime te furnitori sipas furnitorit / dyqanit <span class="sub">${rows.length} dyqane · 120 ditë</span></h3>
      <div class="tablewrap"><table><thead><tr><th>Furnitori / dyqani</th><th>Kthime</th><th>Produkte</th><th style="width:35%">Produkte</th><th>Arsyeja kryesore</th></tr></thead><tbody>
      ${rows.slice(0,60).map(([k,o])=>{ const top=Object.entries(o.cats).sort((a,b)=>b[1]-a[1])[0]; return `<tr><td class="small"><b>${h(k)}</b></td><td class="small">${o.b}</td><td class="small">${o.n}</td>
        <td><div style="height:10px;background:var(--bg);border-radius:5px;overflow:hidden;border:1px solid var(--line)"><i style="display:block;height:100%;width:${Math.max(2,Math.round(o.n/mx*100))}%;background:var(--accent)"></i></div></td>
        <td class="small">${h(top? top[0] : '—')}</td></tr>`; }).join('')}</tbody></table></div></div>`;
  } else if(retStat==='product'){
    const p={}; M.units.forEach(u=>{ const k=u.pc||'—'; const o=p[k]=p[k]||{n:0,pn:u.pn,stores:new Set(),cats:{}}; o.n++; o.stores.add(u.store); o.cats[u.cat]=(o.cats[u.cat]||0)+1; if(!o.pn&&u.pn) o.pn=u.pn; });
    const d={}; M.disp.forEach(x=>{ const k=x.pc||'—'; const o=d[k]=d[k]||{n:0,pn:x.pn,t:{}}; o.n++; o.t[x.t]=(o.t[x.t]||0)+1; if(!o.pn&&x.pn) o.pn=x.pn; });
    const pr=Object.entries(p).sort((a,b)=>b[1].n-a[1].n).slice(0,30), dr=Object.entries(d).sort((a,b)=>b[1].n-a[1].n).slice(0,30);
    html=`<div class="grid g-2"><div class="card"><h3>Produktet që kthehen më shpesh te furnitori <span class="sub">90 ditë</span></h3>
      <div class="tablewrap"><table class="small"><thead><tr><th>Kodi</th><th class="wrap">Emri</th><th>Njësi</th><th>Dyqani</th><th>Arsyeja</th></tr></thead><tbody>
      ${pr.map(([k,o])=>`<tr><td><b>${h(k)}</b></td><td class="wrap">${h(o.pn||'—')}</td><td>${o.n}</td><td>${[...o.stores].slice(0,2).map(h).join(', ')}</td><td>${h(Object.entries(o.cats).sort((a,b)=>b[1]-a[1])[0][0])}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><h3>Produktet e kthyera më shpesh nga klientët <span class="sub">90 ditë</span></h3>
      <div class="tablewrap"><table class="small"><thead><tr><th>Kodi</th><th class="wrap">Emri</th><th>Njësi</th><th>Vendimet</th></tr></thead><tbody>
      ${dr.map(([k,o])=>`<tr><td><b>${h(k)}</b></td><td class="wrap">${h(o.pn||'—')}</td><td>${o.n}</td><td>${Object.entries(o.t).map(([t,n])=>`<span class="badge ${RET_DISP[t][1]}">${RET_DISP[t][0]} ${n}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div></div></div>`;
  } else if(retStat==='month'){
    const mo=retData.monthly||[], months=[...new Set(mo.map(x=>x.m))].filter(Boolean).sort().slice(-9);
    const dm=retData.dispMonthly||[], mx=Math.max(1,...months.map(m=>mo.filter(x=>x.m===m).reduce((a,x)=>a+x.n,0)));
    html=`<div class="grid g-2"><div class="card"><h3>Kthime te furnitori dhe transferime sipas muajit <span class="sub">produkte</span></h3>
      ${months.map(m=>{ const s=mo.find(x=>x.m===m&&x.tt===1)||{b:0,n:0}, t=mo.find(x=>x.m===m&&x.tt===2)||{b:0,n:0}; return bar(m+' — '+s.b+' kthime'+(t.b? ', '+t.b+' transferime' : ''), s.n+t.n, mx, 'var(--imp)', s.n+' + '+t.n+' produkte'); }).join('')}</div>
      <div class="card"><h3>Kthime nga klientët sipas muajit dhe vendimit</h3>
      <div class="tablewrap"><table class="small"><thead><tr><th>Muaji</th>${[21,22,20,29].map(t=>`<th>${RET_DISP[t][0]}</th>`).join('')}<th>Gjithsej</th></tr></thead><tbody>
      ${[...new Set(dm.map(x=>x.m))].sort().map(m=>{ const g=t=>(dm.find(x=>x.m===m&&x.t===t)||{n:0}).n; return `<tr><td>${m}</td>${[21,22,20,29].map(t=>`<td>${g(t)}</td>`).join('')}<td><b>${[21,22,20,29].reduce((a,t)=>a+g(t),0)}</b></td></tr>`; }).join('')}</tbody></table></div></div></div>`;
  } else if(retStat==='disp'){
    const tot=M.disp.length, c=[21,22,20,29].map(t=>[t,M.disp.filter(x=>x.t===t).length]);
    const st={}; M.disp.forEach(x=>{ const o=st[x.store]=st[x.store]||{n:0,t:{}}; o.n++; o.t[x.t]=(o.t[x.t]||0)+1; });
    const rows=Object.entries(st).sort((a,b)=>b[1].n-a[1].n).slice(0,25);
    html=`<div class="grid g-2"><div class="card"><h3>Vendimi për produktet e kthyera nga klientët <span class="sub">${tot} · 90 ditë</span></h3>
      ${c.map(([t,n])=>bar(`<span class="badge ${RET_DISP[t][1]}">${RET_DISP[t][0]}</span>`, n, Math.max(1,...c.map(x=>x[1])), t===20?'var(--crit)':t===22?'var(--ok)':t===21?'var(--warn)':'var(--accent)', n+' ('+Math.round(n/Math.max(1,tot)*100)+'%)')).join('')}</div>
      <div class="card"><h3>Sipas dyqanit</h3><div class="tablewrap"><table class="small"><thead><tr><th>Dyqani</th>${[21,22,20,29].map(t=>`<th>${RET_DISP[t][0]}</th>`).join('')}<th>Gjithsej</th></tr></thead><tbody>
      ${rows.map(([k,o])=>`<tr><td><b>${h(k)}</b></td>${[21,22,20,29].map(t=>`<td>${o.t[t]||0}</td>`).join('')}<td>${o.n}</td></tr>`).join('')}</tbody></table></div></div></div>`;
  } else if(retStat==='legacy'){
    const lg=retData.legacy||[], mx=Math.max(1,...lg.map(x=>x.n));
    html=`<div class="card"><h3>Kthimet e vjetra te furnitori (ReturnsToSupplier) <span class="sub">rrjedha e mëparshme — e ndalur në mars 2026</span></h3>
      ${lg.map(x=>bar(x.m+' · '+x.stores+' dyqane', x.n, mx, 'var(--muted)', x.n+' kthime')).join('')||'<div class="empty">—</div>'}
      <div class="hint">Që nga shkurti 2026 kthimet regjistrohen te "Product Transfer/Return" (Returns), që shfaqen te skedat e tjera.</div></div>`;
  }
  body.innerHTML=`<div class="btnrow no-print" style="margin-bottom:12px">${STATS.map(([k,l])=>`<button class="btn sm ${retStat===k?'primary':''}" data-rets="${k}">${l}</button>`).join('')}</div>`+html;
  $$('[data-rets]').forEach(b=>b.onclick=()=>{ retStat=b.dataset.rets; retDraw(); });
}
