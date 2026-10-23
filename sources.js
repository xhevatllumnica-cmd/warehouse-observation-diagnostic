/* =========================================================================
   Kartelat → burimi i të dhënave (the warehouse lead, 24.10.2026): a click on a card opens, in a new tab, the page of the
   system its figure comes from — the WMS or the Delivery Platform (their menus, read 24.10.2026). A figure that comes from
   the WMS database (WMS Pulse, hourly) or from this app itself has no such page: it opens the app module instead.
   A card gets data-src="<key>"; a card that already does something on click (e.g. a table card on Tabela ditore) gets a
   small ↗ in its corner instead (srcIcon), so its own click keeps working. Only addresses — nothing is sent anywhere.
   =======================================================================*/
const SRC_WMS='https://wms.gjirafamall.com', SRC_DP='https://deliveryplatform.gjirafamall.com';
const SRC={
  wmsLogs:     {label:'WMS · Product History',            url:SRC_WMS+'/Warehouse/ProductLogs?focusedMenu=ProductLogs'},
  wmsOrders:   {label:'WMS · Orders Dashboard',           url:SRC_WMS+'/Order?focusedMenu=OrderIndex'},
  wmsPrepared: {label:'WMS · Prepared',                   url:SRC_WMS+'/Order/PreparedOrders?focusedMenu=PreparedOrders'},
  wmsCancel:   {label:'WMS · Cancellations',              url:SRC_WMS+'/Order/RefusedOrders?focusedMenu=RefusedOrders'},
  wmsStock:    {label:'WMS · Inventory',                  url:SRC_WMS+'/Warehouse/ProductsStock?focusedMenu=ProductsStock'},
  wmsReturns:  {label:'WMS · Product Transfer/Return',    url:SRC_WMS+'/ReturnProcess/Returns?focusedMenu=ReturnHistory'},
  wmsBulk:     {label:'WMS · Bulk Check-In',              url:SRC_WMS+'/CheckInBulk?focusedMenu=CheckInBulkIndex'},
  dpScanned:   {label:'Delivery Platform · Scanned Orders', url:SRC_DP+'/AcceptDelivery/ScannedOrders'},
  dpRealtime:  {label:'Delivery Platform · Real Time POD Orders', url:SRC_DP+'/Delivery/RealTimePodOrders'},
  dpStats:     {label:'Delivery Platform · POD Delivery Stats', url:SRC_DP+'/Delivery'},
  dpRefusals:  {label:'Delivery Platform · Scanned Collections', url:SRC_DP+'/Refusals/ScannedRefusals'},
  dpMerreVet:  {label:'Delivery Platform · Merre vet Report', url:SRC_DP+'/Showroom/MerreVetReport'},
  // no page in the WMS / Delivery Platform (database through WMS Pulse, or this app's own records) → the app module
  appPicking:  {label:'app · Picking (WMS databaza, çdo orë)', hash:'#picking'},
  appPulse:    {label:'app · WMS Pulse (databaza e WMS, çdo orë)', hash:'#pulse'},
  appFlow:     {label:'app · Order Flow', hash:'#orders'},
  appObs:      {label:'app · Daily Observation', hash:'#observations'},
  appCampaign: {label:'app · Kampanja', hash:'#campaign'},
};
function srcAttr(key){ const s=SRC[key]; return s? ` data-src="${key}" title="Kliko: hap burimin — ${s.label.replace(/"/g,'&quot;')}"` : ''; }
function srcIcon(key){ const s=SRC[key]; return s? `<span class="src-ico" data-src="${key}" title="Hap burimin — ${s.label.replace(/"/g,'&quot;')}">↗</span>` : ''; }
function srcOpen(key){
  const s=SRC[key]; if(!s) return;
  if(s.url){ window.open(s.url, '_blank', 'noopener'); return; }
  // inside the app: go to the module; on a page of its own (Tabela ditore, Proceset): open the app in a new tab
  let appTop=null; try{ if(window.top!==window && /\/app\.html$/.test(window.top.location.pathname)) appTop=window.top; }catch(e){}   // a page shown inside the app
  if(/\/app\.html$/.test(location.pathname) && window.top===window) location.hash=s.hash;
  else if(appTop) appTop.location.hash=s.hash;
  else window.open('/app.html'+s.hash, '_blank', 'noopener');
}
document.addEventListener('click', e=>{
  const el=e.target.closest && e.target.closest('[data-src]'); if(!el) return;
  // a control inside the card (link, button, field, sortable header, heatmap cell …) keeps its own action
  const ctl=e.target.closest('a,button,input,select,textarea,label,summary,th,[data-heat],[data-psq],[data-psdp]');
  if(ctl && ctl!==el && el.contains(ctl)) return;
  e.preventDefault(); e.stopPropagation(); srcOpen(el.dataset.src);
}, true);
(function(){ try{ const st=document.createElement('style'); st.textContent=
  '[data-src]{cursor:pointer}[data-src]:not(.src-ico):hover{outline:2px solid var(--accent,#2e86c1);outline-offset:-2px}'
  +'.src-ico{position:absolute;top:4px;right:6px;font-size:13px;line-height:1;padding:2px 5px;border-radius:6px;color:var(--muted,#667);background:transparent;cursor:pointer;z-index:2}'
  +'.src-ico:hover{background:var(--accent,#2e86c1);color:#fff}.has-src-ico{position:relative}'
  // the monitor / TV rotation (?kiosk=1): nobody clicks there — no icons, no hover frame
  +(/[?&]kiosk=1\b/.test(location.search)? '.src-ico{display:none}[data-src]{cursor:default}[data-src]:hover{outline:none}' : '');
  document.head.appendChild(st); }catch(e){} })();
