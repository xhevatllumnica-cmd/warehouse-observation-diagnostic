/* =========================================================================
   KËRKO PRODUKT (the warehouse lead, 13.10.2026) — search a product or an order in the WMS and the Delivery Platform.
   The agent does the reading (product-search.js, read-only): GET /search/q?q=… and, per order, GET /search/dp.
   Accepts: product code (EAN), SKU, unit id, serial number — exact, last 365 days; an order number; a product name
   (from the agent's index of products that moved in the last ~30 days). No customer data is shown.
   =======================================================================*/
let psLast='';
function renderProductSearch(v){
  v.innerHTML=pagehead('Kërko produkt','Kërko një produkt ose porosi në <b>WMS</b> dhe <b>Delivery Platform</b>: kodi i produktit (EAN), SKU, ID e njësisë, numri serik, numri i porosisë ose emri i produktit. Vetëm lexim — asgjë nuk ndryshohet në sisteme.','')
    + `<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="search" id="psQ" value="${h(psLast)}" placeholder="p.sh. 6297001571002 · 310982romp · 1277109 · Victorinox" style="flex:1;min-width:240px;min-height:40px;font-size:15px" autofocus>
        <button class="btn primary" id="psGo">🔎 Kërko</button></div>
      <div class="hint" style="margin-top:6px">Kodet kërkohen saktë (jo pjesë kodi) në 365 ditët e fundit. Emri kërkohet te produktet që kanë lëvizur në depo kohët e fundit.</div></div>
    <div id="psRes"></div>`;
  const go=()=>{ const q=$('#psQ').value.trim(); if(q) psSearch(q); };
  $('#psGo').onclick=go; $('#psQ').onkeydown=e=>{ if(e.key==='Enter') go(); };
  if(!wmsOnAgent()){ $('#psRes').innerHTML='<div class="empty">Kërkimi punon vetëm kur app-i hapet nga agjenti: http://localhost:8790/app.html</div>'; return; }
  if(psLast) psSearch(psLast);
}
async function psSearch(q){
  psLast=q; const box=$('#psRes'); if(!box) return; const t0=Date.now();
  box.innerHTML=`<div class="empty">Po kërkohet “${h(q)}” në WMS…</div>`;
  let j; try{ const r=await fetch('/search/q?q='+encodeURIComponent(q),{cache:'no-store'}); j=await r.json();
    if(r.status===401 || j.error==='auth_expired'){ box.innerHTML='<div class="empty" style="color:var(--warn)">Sesioni i WMS ka skaduar — rifreskoje cookie-n e agjentit dhe provo sërish.</div>'; return; }
    if(j.error){ box.innerHTML=`<div class="empty">${h(j.error)}</div>`; return; } }
  catch(e){ box.innerHTML=`<div class="empty">Agjenti s'përgjigjet (${h(e.message)}).</div>`; return; }
  if(psLast!==q) return;
  const parts=[];
  if(j.order) parts.push(psOrderCard(j.order));
  (j.products||[]).forEach((p,i)=>parts.push(psProductCard(p,i)));
  if(j.names && j.names.length) parts.push(`<div class="card"><h3 style="margin-top:0">Produkte me këtë emër <span class="sub">${j.names.length}${j.names.length>=40? '+' : ''} · kliko për historinë</span></h3>
    <div class="tablewrap"><table><thead><tr><th>Emri</th><th>Kodi (EAN)</th><th>SKU</th><th>Lëvizja e fundit</th></tr></thead><tbody>
    ${j.names.map(n=>`<tr><td><a href="#" data-psq="${h(n.code||n.sku)}">${h(n.name)}</a></td><td>${h(n.code)}</td><td>${h(n.sku)}</td><td data-sort="${h(n.lastSeen||'')}">${h(fmtDateAl(n.lastSeen||''))}</td></tr>`).join('')}</tbody></table></div></div>`);
  if(!parts.length) parts.push(`<div class="empty">Asgjë për “${h(q)}”. ${/[A-Za-zëç]/i.test(q) && !/\d/.test(q)? 'Emri kërkohet vetëm te produktet që kanë lëvizur kohët e fundit'+(j.index? ' ('+j.index.products+' produkte në indeks, '+j.index.days+' ditë)' : '')+'; provo kodin ose SKU-në.' : 'Kodet duhet të jenë të sakta (EAN, SKU, ID e njësisë, numri serik ose numri i porosisë).'}</div>`);
  box.innerHTML=parts.join('')+`<div class="hint" style="margin-top:6px">Burimi: WMS (log-u i produkteve, porositë) dhe Delivery Platform (skanimet POD, dërgesat) · lexuar ${h(new Date(j.at||Date.now()).toLocaleTimeString())} · ${((Date.now()-t0)/1000).toFixed(1)} s</div>`;
  $$('[data-psq]').forEach(a=>a.onclick=e=>{ e.preventDefault(); const q2=a.dataset.psq; $('#psQ').value=q2; psSearch(q2); });
  $$('[data-psdp]').forEach(b=>b.onclick=()=>psLoadDp(b));
  $$('[data-psdp-auto]').forEach(b=>psLoadDp(b));   // the order's own card and the 3 latest orders of a product load at once
  $$('[data-psimg]').forEach(psLoadImg);
}
async function psLoadImg(box){
  const [uid, sku, code]=box.dataset.psimg.split('|'), link=box.parentElement.querySelector('[data-psimglink]');
  try{ const r=await fetch('/search/img?uid='+encodeURIComponent(uid)+'&sku='+encodeURIComponent(sku)+'&code='+encodeURIComponent(code),{cache:'no-store'}); const j=await r.json();
    if(j.image){ const img=new Image(); img.alt='Foto e produktit'; img.style.cssText='max-width:100%;max-height:100%;object-fit:contain';
      img.onerror=()=>{ box.innerHTML='<span class="faint small">foto s\'u hap</span>'; }; img.src=j.image; box.innerHTML=''; box.appendChild(img);
      if(link && j.url) link.innerHTML=`<a href="${h(j.url)}" target="_blank" rel="noopener">Shiko në ${h(j.shop==='gjirafa50.com'? 'Gjirafa50' : 'GjirafaMall')} ↗</a>`; }
    else box.innerHTML=`<span class="faint small" style="text-align:center;padding:6px">${j.error==='auth_expired'? 'sesioni i WMS ka skaduar' : 'pa foto në dyqan'}</span>`;
  }catch(e){ box.innerHTML='<span class="faint small">pa foto</span>'; }
}
const PS_STATUS={in:['Në depo','b-ok'], out:['Dalë','b-muted'], other:['Tjetër','b-warn']};
function psProductCard(p, i){
  const inU=p.units.filter(u=>u.status==='in'), rows=[...new Set(inU.map(u=>u.row).filter(Boolean))], u0=(inU[0]||p.units[0]||{}).uid||'';
  // the photo comes from the public shop (GjirafaMall / Gjirafa50) through the agent — loaded after the card is drawn
  return `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:6px">
      <div data-psimg="${h(u0)}|${h(p.sku)}|${h(p.code)}" style="width:128px;height:128px;flex:none;border:1px solid var(--line);border-radius:10px;display:flex;align-items:center;justify-content:center;background:#fff;overflow:hidden">
        <span class="faint small">foto…</span></div>
      <h3 style="margin:4px 0 0">${h(p.name||'(pa emër)')} <span class="sub" style="display:block;margin-top:4px">EAN ${h(p.code||'—')} · SKU ${h(p.sku||'—')}${p.vendor? ' · '+h(p.vendor) : ''}</span><span class="small" data-psimglink></span></h3></div>
    <div class="grid g-kpi" style="margin-bottom:10px">
      ${kpiCard(p.counts.in, 'Në depo tani', rows.length? 'rafti: '+rows.slice(0,4).join(', ')+(rows.length>4? ' …' : '') : 'asnjë njësi në raft')}
      ${kpiCard(p.counts.out, 'Të dala', p.orders.length+' porosi')}
      ${kpiCard(p.counts.units, 'Njësi gjithsej', p.events+' lëvizje në 365 ditë')}
      ${p.counts.other? kpiCard(p.counts.other, 'Status tjetër', 'kthime / inspektim etj.') : ''}</div>
    ${inU.length? `<details open><summary style="cursor:pointer"><b>Njësitë në depo</b> <span class="sub">${inU.length}</span></summary><div class="tablewrap"><table><thead><tr><th>Njësia</th><th>Rafti</th><th>Hapi i fundit</th><th>Kur</th><th>Nga</th></tr></thead><tbody>
      ${inU.slice(0,60).map(u=>`<tr><td><a href="#" data-psq="${h(u.uid)}">${h(u.uid)}</a>${u.serial? ' <span class="faint small">SN '+h(u.serial)+'</span>' : ''}</td><td><b>${h(u.row||'—')}</b></td><td>${h(u.lastType)}</td><td data-sort="${h(u.lastAt)}">${h(psDt(u.lastAt))}</td><td>${h(u.by||'')}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    ${p.orders.length? `<details ${inU.length? '' : 'open'}><summary style="cursor:pointer"><b>Porositë</b> <span class="sub">${p.orders.length}${p.orders.length>=40? '+' : ''} · check-out në WMS dhe dorëzimi në Delivery Platform</span></summary>
      <div class="tablewrap"><table><thead><tr><th>Porosia</th><th>Check-out</th><th>Delivery Platform</th></tr></thead><tbody>
      ${p.orders.map((o,k)=>`<tr><td><a href="#" data-psq="${o.order}">${o.order}</a></td><td data-sort="${h(o.at)}">${h(psDt(o.at))}</td>
        <td><button class="btn sm" data-psdp="${o.order}|${o.pid||''}|${h(o.date)}" ${k<3? 'data-psdp-auto' : ''}>Shiko</button></td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <details><summary style="cursor:pointer"><b>Historia</b> <span class="sub">${Math.min(80,p.events)} lëvizjet e fundit</span></summary><div class="tablewrap"><table><thead><tr><th>Kur</th><th>Hapi</th><th>Rafti</th><th>Porosia</th><th>Njësia</th><th>Nga</th></tr></thead><tbody>
      ${p.history.map(e=>`<tr><td data-sort="${h(e.at)}">${h(psDt(e.at))}</td><td>${h(e.type)}</td><td>${h(e.row||'')}</td><td>${e.order? `<a href="#" data-psq="${e.order}">${e.order}</a>` : ''}</td><td class="small">${h(e.uid)}</td><td>${h(e.by||'')}</td></tr>`).join('')}</tbody></table></div></details></div>`;
}
function psOrderCard(o){
  const co=o.checkout;
  return `<div class="card" style="margin-bottom:12px"><h3 style="margin-top:0">Porosia ${o.orderId} <span class="sub">${o.items.length} njësi</span></h3>
    <div class="grid g-kpi" style="margin-bottom:10px">
      ${kpiCard(co? psDt(co.first) : '—', 'Check-out në WMS', co? (co.first!==co.last? 'deri '+psDt(co.last)+' · ' : '')+co.by.join(', ') : 'nuk u gjet check-out në 365 ditë')}
      <div class="card kpi" style="margin:0"><div class="lbl" style="margin-bottom:4px">Delivery Platform</div><div id="psdp-${o.orderId}" class="small">${co? `<button class="btn sm" data-psdp="${o.orderId}|${co.pid||''}|${h(co.date)}" data-psdp-auto>Shiko</button>` : '<span class="faint">pa check-out → pa dërgesë</span>'}</div></div></div>
    <div class="tablewrap"><table><thead><tr><th>Produkti</th><th>EAN</th><th>SKU</th><th>Njësia</th><th>Statusi në WMS</th></tr></thead><tbody>
    ${o.items.map(i=>`<tr><td><a href="#" data-psq="${h(i.code||i.sku)}">${h(i.name)}</a></td><td>${h(i.code)}</td><td>${h(i.sku)}</td><td><a href="#" data-psq="${h(i.uid)}">${h(i.uid)}</a></td><td>${h(i.status)}${i.row? ' · '+h(i.row) : ''}</td></tr>`).join('')}</tbody></table></div>
    ${(o.events||[]).length? `<details><summary style="cursor:pointer"><b>Hapat e porosisë në WMS</b></summary><div class="tablewrap"><table><thead><tr><th>Kur</th><th>Hapi</th><th>Njësia</th><th>Nga</th></tr></thead><tbody>
      ${o.events.map(e=>`<tr><td data-sort="${h(e.at)}">${h(psDt(e.at))}</td><td>${h(e.type)}</td><td class="small">${h(e.uid)}</td><td>${h(e.by||'')}</td></tr>`).join('')}</tbody></table></div></details>` : ''}</div>`;
}
const psDt=s=>{ const m=/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?/.exec(String(s||'')); return m? m[3]+'.'+m[2]+'.'+m[1]+(m[4]? ' '+m[4] : '') : String(s||''); };
async function psLoadDp(btn){
  const [order, pid, from]=btn.dataset.psdp.split('|'), cell=btn.parentElement; if(!cell) return;
  cell.innerHTML='<span class="faint small">po lexohet… (deri në 20 s herën e parë)</span>';
  try{ const r=await fetch('/search/dp?order='+encodeURIComponent(order)+'&pid='+encodeURIComponent(pid)+'&from='+encodeURIComponent(from),{cache:'no-store'}); const j=await r.json();
    if(j.error){ cell.innerHTML=`<span style="color:var(--warn)" class="small">${j.error==='auth_expired'? 'Sesioni i Delivery Platform ka skaduar' : h(j.error)}</span>`; return; }
    const d=j.delivery, s=j.scan, refused= d && (d.refused===true || /refuz/i.test(d.status||''));
    cell.innerHTML= !s? `<span class="faint small">Pa skanim POD (${h(j.searchedDays.map(x=>fmtDateAl(x).slice(0,5)).join(', '))})</span>`
      : `<span class="small">POD ${h(psDt(s.at))}${s.by? ' · '+h(s.by) : ''}${d? ` · <b>${h(d.post||'—')}</b> · <span class="badge ${refused? 'b-crit' : d.delivered? 'b-ok' : 'b-muted'}">${h(d.status || (d.delivered? 'Dorëzuar' : 'Në dërgesë'))}</span>${d.delivered? ' · dorëzuar '+h(psDt(String(d.delivered).replace('T',' ').slice(0,16))) : ''}` : ' · <span class="faint">dërgesa ende pa u lexuar</span>'}</span>`;
  }catch(e){ cell.innerHTML=`<span class="small" style="color:var(--warn)">${h(e.message)}</span>`; }
}
