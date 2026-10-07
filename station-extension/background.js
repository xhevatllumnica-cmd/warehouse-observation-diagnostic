/* WMS Station — tells the warehouse agent which WMS account is logged in on this table PC.
   Once a minute (and whenever a WMS page opens) it sends {user} to the agent on the lead's PC; the agent knows the table
   from this PC's IP. user = the name the WMS shows in its header, or '' when no WMS page is open / the login page shows.
   Settings: config.js (agent address + station key); the agent address can be changed in the popup. */
importScripts('config.js');
const WMS_URL='https://wms.gjirafamall.com/*';

async function agentUrl(){ const s=await chrome.storage.local.get('agent'); return (s.agent||STATION_CFG.agent).replace(/\/+$/,''); }
async function send(reason){
  const tabs=await chrome.tabs.query({url:WMS_URL});
  const s=await chrome.storage.local.get(['wmsUser']);
  const user= tabs.length? (s.wmsUser||'') : '';          // no WMS page open on this PC → nobody working in the WMS here
  let res=null, error=null;
  try{ const r=await fetch((await agentUrl())+'/beacon',{method:'POST', headers:{'Content-Type':'application/json','X-Station-Key':STATION_CFG.key},
      body:JSON.stringify({user, v:chrome.runtime.getManifest().version, reason})}); res=await r.json(); if(!r.ok) error=res&&res.error||('HTTP '+r.status); }
  catch(e){ error=String(e&&e.message||e); }
  await chrome.storage.local.set({last:{at:Date.now(), user, reason, res, error}});
}
chrome.runtime.onMessage.addListener((msg)=>{ if(msg&&msg.type==='wmsUser'){ chrome.storage.local.set({wmsUser:msg.user||''}).then(()=>send('page')); } });
chrome.alarms.onAlarm.addListener(a=>{ if(a.name==='beacon') send('alarm'); });
function ensureAlarm(){ chrome.alarms.get('beacon', a=>{ if(!a) chrome.alarms.create('beacon',{periodInMinutes:1}); }); }
chrome.runtime.onInstalled.addListener(()=>{ ensureAlarm(); send('installed'); });
chrome.runtime.onStartup.addListener(()=>{ ensureAlarm(); send('startup'); });
ensureAlarm();
