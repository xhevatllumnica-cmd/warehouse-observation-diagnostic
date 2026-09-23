const st = document.getElementById('st');
function show(s) {
  if (!s) { st.textContent = 'Ende asnjë dërgim. Kyçu në WMS ose shtyp butonin.'; return; }
  st.className = 'st ' + (s.ok ? 'ok' : 'bad');
  const when = new Date(s.at).toLocaleString();
  st.innerHTML = (s.ok ? '✅ ' : '⚠️ ') + s.msg + '<div style="margin-top:4px;font-size:11px;color:#8a93a0">' + when + ' · ' + s.reason
    + (s.stats ? ' · WMS: ' + s.stats.ordersInProcessing + ' porosi në procesim' : '') + '</div>';
}
chrome.storage.local.get('last').then(r => show(r.last));
document.getElementById('go').onclick = () => { st.textContent = 'Po dërgoj…'; st.className = 'st'; chrome.runtime.sendMessage('push-now').then(show); };
