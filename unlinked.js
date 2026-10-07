/* =========================================================================
   KTHIME PA LIDHJE — the receiving log for returned packages that arrive without a return request or a known order
   (agreed with the warehouse lead, 08.10.2026). The Delivery Platform's Return Collection pages no longer get new rows
   (ReturnCollection: last insert 05.01.2026), and a package a customer sends on their own is registered nowhere — so the
   warehouse logs every such package here, one row each, and follows it: Pranuar → Lidhur me porosi/kërkesë → Zgjidhur.
   Stored in the app's shared database (collection "unlinkedReturns", every change in the audit log).
   Personal data: the sender's NAME only — no phone (decided by the lead). A phone-like number (8+ digits) typed into the
   name or the notes is removed on save; the tracking/barcode has its own field. No photos (a label shows the customer's
   address, and images would make the shared database heavy).
   =======================================================================*/
let urStatus='', urQuery='', urStaff=null;
const UR_ST=['Pranuar','Lidhur me porosi/kërkesë','Zgjidhur'];
const UR_ST_BADGE={'Pranuar':'b-warn','Lidhur me porosi/kërkesë':'b-new','Zgjidhur':'b-ok'};
const UR_ARRIVAL=['Postë / kurier','Klienti në depo','Pickup i yni','Tjetër'];
const UR_POSTS=['BEKI','Express','Fiks','Merre vet','Starlink','Boxes','PickUpPoint'];
const UR_COND=['E paketuar','E hapur','E dëmtuar'];
const UR_RESOLUTION=['Kthim në stok','Defekt','Outlet','Kthyer te klienti','Te furnitori','Tjetër'];
// a phone number is 8+ digits (044 123 456, +383 44 123 456); an order number has at most 7 — it stays
const urNoPhone=s=>String(s||'').replace(/(?:\+|00)?\d[\d\s\-/().]{6,}\d/g, m=> m.replace(/\D/g,'').length>=8? '[tel. i hequr]' : m).trim();
const urAgeDays=r=>{ const t=Date.parse((r.date||'')+'T'+(r.time||'00:00')+':00'); return isNaN(t)? null : Math.floor((Date.now()-t)/864e5); };
const urDT=r=> r.date? r.date.slice(8,10)+'.'+r.date.slice(5,7)+'.'+r.date.slice(2,4)+(r.time? ' '+r.time : '') : '—';

function renderUnlinkedReturns(v){
  v.innerHTML=pagehead('Kthime pa lidhje',
    'Regjistri i pakove të kthyera që vijnë <b>pa kërkesë kthimi</b> ose pa porosi të njohur (p.sh. klienti e dërgon vetë). Një rresht për çdo pako; ndiqet deri në zgjidhje: <b>Pranuar → Lidhur me porosi/kërkesë → Zgjidhur</b>. Ruhet vetëm emri i dërguesit — pa telefon.',
    `<button class="btn primary" id="urAdd">＋ Pako e re</button>`)
    + `<div id="urKpi"></div><div class="card no-print" style="margin-bottom:12px"><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center" id="urBar"></div></div><div id="urBody"></div>`;
  $('#urAdd').onclick=()=>urForm();
  urDraw();
  if(!urStaff && typeof wmsOnAgent==='function' && wmsOnAgent()) fetch('/schedule',{cache:'no-store'}).then(r=>r.json()).then(j=>{ urStaff=(j&&j.names)||[]; }).catch(()=>{ urStaff=[]; });
}
function urDraw(){
  const all=Store.col('unlinkedReturns'), cnt=s=>all.filter(r=>r.status===s).length, today=todayStr();
  const openOld=all.filter(r=>r.status!=='Zgjidhur' && (urAgeDays(r)||0)>3).length;
  const kpi=(val,lbl,foot,st)=>`<div class="card kpi ${st||''}"><div class="val">${val}</div><div class="lbl">${lbl}</div><div class="foot">${foot}</div></div>`;
  $('#urKpi').innerHTML=`<div class="grid g-kpi" style="margin-bottom:12px">
      ${kpi(cnt('Pranuar'),'Pranuar — pa lidhje','pako që ende s\'janë lidhur me porosi ose kërkesë', cnt('Pranuar')? 'st-warn' : 'st-ok')}
      ${kpi(cnt('Lidhur me porosi/kërkesë'),'Lidhur, pa vendim','e dihet porosia/kërkesa, pret zgjidhjen','')}
      ${kpi(cnt('Zgjidhur'),'Zgjidhur','me vendim (stok, defekt, outlet, kthyer…)','st-ok')}
      ${kpi(openOld,'Të hapura > 3 ditë','pa u zgjidhur mbi 3 ditë', openOld? 'st-crit' : 'st-ok')}
      ${kpi(all.filter(r=>r.date===today).length,'Pranuar sot','pako të regjistruara sot','')}
    </div>`;
  $('#urBar').innerHTML=[['','Të gjitha',all.length]].concat(UR_ST.map(s=>[s,s,cnt(s)])).map(([k,l,n])=>`<span class="chip ${urStatus===k?'on':''}" data-urs="${h(k)}">${h(l)} <b style="margin-left:5px">${n}</b></span>`).join('')
    + `<input id="urSearch" placeholder="Kërko tracking / produkt / porosi / dërgues…" value="${h(urQuery)}" style="margin-left:auto;max-width:280px;min-height:36px">
       <button class="btn sm ghost" id="urCsv">⬇ CSV</button>`;
  $$('[data-urs]').forEach(c=>c.onclick=()=>{ urStatus=c.dataset.urs; urDraw(); });
  const si=$('#urSearch'); si.oninput=e=>{ urQuery=e.target.value; clearTimeout(si._t); si._t=setTimeout(()=>{ urDrawTable(); },200); };
  $('#urCsv').onclick=urCsv;
  urDrawTable();
}
function urRows(){
  const q=urQuery.trim().toLowerCase();
  return Store.col('unlinkedReturns').filter(r=>!urStatus || r.status===urStatus)
    .filter(r=>!q || [r.tracking,r.productCode,r.productName,r.orderId,r.requestId,r.senderName,r.post,r.wmsRow,r.receivedBy].join(' ').toLowerCase().includes(q))
    .sort((a,b)=>((b.date||'')+(b.time||'')).localeCompare((a.date||'')+(a.time||'')));
}
function urDrawTable(){
  const box=$('#urBody'); if(!box) return; const rows=urRows();
  if(!Store.col('unlinkedReturns').length){ box.innerHTML='<div class="card"><div class="empty">Ende asnjë pako. Shtyp <b>＋ Pako e re</b> sa herë që pranohet një kthim pa kërkesë ose pa porosi.</div></div>'; return; }
  box.innerHTML=`<div class="card"><div style="overflow-x:auto"><table style="font-size:12.5px"><thead><tr>
      <th>Pranuar</th><th>Pranoi</th><th>Ardhja</th><th>Dërguesi</th><th>Tracking / barcode</th><th>Produkti</th><th>Sasia</th><th>Gjendja</th><th>WMS row</th><th>Statusi</th><th>Porosia / kërkesa</th><th>Koha e pritjes</th><th></th></tr></thead><tbody>
    ${rows.map(r=>{ const age=urAgeDays(r), open=r.status!=='Zgjidhur';
      return `<tr><td data-sort="${h((r.date||'')+' '+(r.time||''))}" style="white-space:nowrap">${h(urDT(r))}</td><td>${h(r.receivedBy||'—')}</td>
        <td>${h(r.arrival||'—')}${r.post? '<div class="small faint">'+h(r.post)+'</div>' : ''}</td><td>${h(r.senderName||'—')}</td>
        <td><code>${h(r.tracking||'—')}</code></td><td>${h(r.productCode||'—')}${r.productName? '<div class="small faint">'+h(r.productName)+'</div>' : ''}</td>
        <td>${h(r.qty!=null? r.qty : 1)}</td><td>${r.condition? `<span class="badge ${r.condition==='E dëmtuar'?'b-crit':r.condition==='E hapur'?'b-warn':'b-muted'}">${h(r.condition)}</span>` : '—'}</td>
        <td>${h(r.wmsRow||'—')}</td><td><span class="badge ${UR_ST_BADGE[r.status]||'b-muted'}">${h(r.status||'Pranuar')}</span>${r.status==='Zgjidhur'&&r.resolution? '<div class="small faint">'+h(r.resolution)+'</div>' : ''}</td>
        <td>${r.orderId? '#'+h(r.orderId)+(r.platform? ' <span class="faint small">'+h(r.platform)+'</span>' : '') : ''}${r.requestId? '<div class="small">RMS '+h(r.requestId)+'</div>' : ''}${!r.orderId&&!r.requestId? '—' : ''}</td>
        <td data-sort="${age==null? '' : age}" style="${open&&age>3?'color:var(--crit);font-weight:700':''}">${age==null? '—' : open? age+' ditë' : '—'}</td>
        <td class="no-print" style="white-space:nowrap">${r.status==='Pranuar'? `<button class="btn sm" data-urlink="${h(r.id)}" title="Lidh me porosi ose kërkesë">Lidh</button> ` : ''}${open? `<button class="btn sm" data-urres="${h(r.id)}" title="Shëno si të zgjidhur">Zgjidh</button> ` : ''}<button class="btn sm ghost" data-ured="${h(r.id)}" title="Ndrysho">✎</button><button class="btn sm ghost" data-urdel="${h(r.id)}" title="Fshi">🗑</button></td></tr>`; }).join('')}
    </tbody></table></div>${rows.length? '' : '<div class="empty">Asgjë nuk përputhet me filtrin.</div>'}
    <div class="hint" style="margin-top:8px">Kliko titujt e kolonave për renditje. Ruhet vetëm emri i dërguesit; një numër telefoni i shkruar te emri ose te shënimet hiqet automatikisht. Çdo ndryshim mbetet në Audit Log.</div></div>`;
  const rec=id=>Store.get('unlinkedReturns',id);
  $$('[data-ured]').forEach(b=>b.onclick=()=>urForm(rec(b.dataset.ured)));
  $$('[data-urlink]').forEach(b=>b.onclick=()=>urForm(rec(b.dataset.urlink),'Lidhur me porosi/kërkesë'));
  $$('[data-urres]').forEach(b=>b.onclick=()=>urForm(rec(b.dataset.urres),'Zgjidhur'));
  $$('[data-urdel]').forEach(b=>b.onclick=()=>{ const r=rec(b.dataset.urdel); if(r) confirmDelete('pakon '+(r.tracking||r.productCode||urDT(r)), ()=>{ Store.remove('unlinkedReturns', r.id); urDraw(); toast('U fshi'); }); });
}
function urForm(existing, nextStatus){
  const staff=[...new Set([...(urStaff||[]), ...Store.col('employees').filter(e=>e.active!==false).map(e=>e.name)])].sort();
  const vals=Object.assign({date:todayStr(), status:'Pranuar', qty:1}, existing||{}, nextStatus? {status:nextStatus} : {});
  const fields=[
    {type:'section', label:'Pranimi'},
    {name:'date', label:'Data', type:'date', required:true, row:'a'}, {name:'time', label:'Ora', type:'time', row:'a'},
    {name:'receivedBy', label:'Kush e pranoi', type:'datalist', options:staff, required:true, ph:'emri i operatorit', row:'a'},
    {name:'arrival', label:'Si erdhi', type:'chips', options:UR_ARRIVAL},
    {name:'post', label:'Posta / kurieri', type:'datalist', options:UR_POSTS, ph:'BEKI, Express, Fiks…', row:'b'},
    {name:'senderName', label:'Emri i dërguesit', type:'text', ph:'vetëm emri — pa telefon', row:'b'},
    {name:'tracking', label:'Tracking / barcode', type:'text', ph:'nëse ka', row:'b'},
    {type:'section', label:'Produkti'},
    {name:'productCode', label:'Product ID / EAN / SKU', type:'text', row:'c'}, {name:'productName', label:'Emri i produktit', type:'text', row:'c'},
    {name:'qty', label:'Sasia', type:'number', row:'c'},
    {name:'condition', label:'Gjendja e produktit', type:'chips', options:UR_COND},
    {name:'wmsRow', label:'WMS row', type:'text', ph:'p.sh. 01-FT-04-01'},
    {type:'section', label:'Lidhja dhe zgjidhja'},
    {name:'status', label:'Statusi', type:'select', options:UR_ST, required:true, row:'e'},
    {name:'orderId', label:'Porosia', type:'text', ph:'nr. i porosisë', row:'e'},
    {name:'platform', label:'Platforma', type:'select', options:['GjirafaMall','Gjirafa50'], row:'e'},
    {name:'requestId', label:'Kërkesa RMS', type:'text', ph:'nëse ka', row:'f'},
    {name:'resolution', label:'Vendimi (kur zgjidhet)', type:'select', options:UR_RESOLUTION, row:'f'},
    {name:'notes', label:'Shënime', type:'textarea', rows:2, ph:'pa numra telefoni'},
  ];
  openForm({title: existing? 'Pako e kthyer — '+(existing.tracking||existing.productCode||urDT(existing)) : 'Pako e re e kthyer (pa lidhje)', fields, values:vals,
    onSave:(v)=>{
      v.senderName=urNoPhone(v.senderName); v.notes=urNoPhone(v.notes);
      if(v.status==='Lidhur me porosi/kërkesë' && !v.orderId && !v.requestId){ toast('Për statusin «Lidhur» shkruaj porosinë ose kërkesën RMS'); $('#f_orderId').focus(); return; }
      if(v.status==='Zgjidhur' && !v.resolution){ toast('Zgjidh vendimin për pakon e zgjidhur'); $('#f_resolution').focus(); return; }
      if(v.status!=='Zgjidhur') v.resolution=v.resolution||'';
      if(v.status==='Zgjidhur' && !(existing&&existing.resolvedAt)) v.resolvedAt=nowISO();
      if(existing) Store.update('unlinkedReturns', existing.id, v); else Store.insert('unlinkedReturns', v);
      closeModal(); urDraw(); toast(existing? 'U ruajt' : 'Pakoja u regjistrua'); }});
}
function urCsv(){
  const rows=urRows(), q=s=>'"'+String(s==null?'':s).replace(/"/g,'""')+'"';
  const head=['Data','Ora','Pranoi','Ardhja','Posta','Dërguesi','Tracking','Produkti','Emri i produktit','Sasia','Gjendja','WMS row','Statusi','Porosia','Platforma','Kërkesa RMS','Vendimi','Koha e pritjes (ditë)','Shënime'];
  const lines=[head.map(q).join(',')].concat(rows.map(r=>[r.date,r.time,r.receivedBy,r.arrival,r.post,r.senderName,r.tracking,r.productCode,r.productName,r.qty,r.condition,r.wmsRow,r.status,r.orderId,r.platform,r.requestId,r.resolution,r.status!=='Zgjidhur'? urAgeDays(r) : '',r.notes].map(q).join(',')));
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['﻿'+lines.join('\n')],{type:'text/csv;charset=utf-8'})); a.download='kthime-pa-lidhje-'+todayStr()+'.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
