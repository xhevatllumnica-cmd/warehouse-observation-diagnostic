(async function(){
  const $=id=>document.getElementById(id);
  const s=await chrome.storage.local.get(['agent','last','wmsUser']); const agent=(s.agent||STATION_CFG.agent).replace(/\/+$/,'');
  $('agent').value=agent; $('user').textContent=(s.last&&s.last.user)||'— asnjë —';
  const L=s.last; $('last').innerHTML= L? 'Dërguar: '+new Date(L.at).toLocaleTimeString()+' · '+(L.error? '<span class="err">'+L.error+'</span>' : '<span class="ok">në rregull</span>') : 'Ende pa dërgim.';
  try{ const r=await fetch(agent+'/hello',{headers:{'X-Station-Key':STATION_CFG.key}}); const j=await r.json();
    $('table').innerHTML= j.ok? j.table+' <span class="muted">('+j.station+' · '+j.ip+')</span>' : '<span class="err">IP '+(j.ip||'?')+' nuk është në listë</span>'; }
  catch(e){ $('table').innerHTML='<span class="err">agjenti nuk përgjigjet</span>'; }
  $('save').onclick=async()=>{ await chrome.storage.local.set({agent:$('agent').value.trim()}); window.close(); };
})();
