/* WMS Agent Link — background worker.
   Whenever the WMS login cookies change (you log in, or the server rotates the session),
   the current cookie header for wms.gjirafamall.com is pushed to the local agent, which
   validates it against WMS and stores it in its own config. Also re-pushed on browser start
   and every 30 min, so the agent never sits on a dead session while Chrome has a live one. */
const AGENT = 'http://localhost:8790';
const WMS_DOMAIN = 'gjirafamall.com';
let timer = null;

async function cookieHeader() {
  const all = await chrome.cookies.getAll({ domain: WMS_DOMAIN });
  // keep cookies that apply to the WMS host (host cookies + parent-domain cookies like the SSO "gjs")
  const mine = all.filter(c => {
    const d = (c.domain || '').replace(/^\./, '');
    return d === 'wms.' + WMS_DOMAIN || d === WMS_DOMAIN;
  });
  return mine.map(c => c.name + '=' + c.value).join('; ');
}
/* logged in = an auth ticket is present (.AspNet.Cookies, possibly chunked into .AspNet.CookiesC1..n).
   A leftover OpenIdConnect.nonce cookie is normal after a successful login and must NOT disqualify. */
function looksLoggedIn(header) {
  const m = header.match(/(?:^|;\s*)\.AspNet\.Cookies=([^;]*)/);
  const chunked = /\.AspNet\.CookiesC\d+=/.test(header);
  return !!(m && (m[1].length >= 200 || chunked));
}
function describe(header) {   // names + value lengths only — never the values
  return header ? header.split(/;\s*/).map(p => { const i = p.indexOf('='); return i > 0 ? p.slice(0, i).replace(/^(OpenIdConnect\.nonce)\..*$/, '$1…') + '(' + (p.length - i - 1) + ')' : p; }).join(', ') : '(asnjë cookie për gjirafamall.com)';
}
async function push(reason) {
  const header = await cookieHeader();
  const state = { at: new Date().toISOString(), reason, ok: false, msg: '' };
  // diagnostic ping (names + lengths only) so the agent log shows what the extension sees
  try { await fetch(AGENT + '/wms/ext-ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, loggedIn: looksLoggedIn(header), found: describe(header), version: chrome.runtime.getManifest().version }) }); }
  catch (e) { state.msg = 'Agjenti nuk përgjigjet në ' + AGENT + ' — a është ndezur? (' + e.message + ')'; await chrome.storage.local.set({ last: state }); chrome.action.setBadgeText({ text: '!' }); chrome.action.setBadgeBackgroundColor({ color: '#c0392b' }); return state; }
  if (!looksLoggedIn(header)) { state.msg = 'Nuk gjej biletë login-i të WMS në KËTË Chrome/profil. Cookies të gjetura: ' + describe(header) + '. Kyçu në wms.gjirafamall.com në të njëjtin profil ku është ky ekstension, pastaj shtyp butonin.'; }
  else {
    try {
      const r = await fetch(AGENT + '/wms/cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie: header, source: 'extension' }) });
      const j = await r.json().catch(() => ({}));
      state.ok = r.ok && !j.error; state.msg = state.ok ? 'Sesioni u dërgua te agjenti ✓' : (j.error || ('Agjenti u përgjigj ' + r.status));
      if (state.ok && j.stats) state.stats = j.stats;
    } catch (e) { state.msg = 'Agjenti nuk përgjigjet në ' + AGENT + ' — a është ndezur?'; }
  }
  await chrome.storage.local.set({ last: state });
  chrome.action.setBadgeText({ text: state.ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: state.ok ? '#1f9d55' : '#c0392b' });
  return state;
}
function schedule(reason) { clearTimeout(timer); timer = setTimeout(() => push(reason), 2500); }   // login sets several cookies in a burst

chrome.cookies.onChanged.addListener(info => {
  const d = (info.cookie.domain || '').replace(/^\./, '');
  if (d.endsWith(WMS_DOMAIN) && /^(\.AspNet\.Cookies|ASP\.NET_SessionId|gjs)/.test(info.cookie.name) && !info.removed) schedule('cookie-changed');
});
chrome.runtime.onInstalled.addListener(() => { push('installed'); chrome.alarms.create('wms-push', { periodInMinutes: 30 }); });
chrome.runtime.onStartup.addListener(() => { push('browser-start'); chrome.alarms.create('wms-push', { periodInMinutes: 30 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'wms-push') push('periodic'); });
chrome.runtime.onMessage.addListener((msg, _s, reply) => { if (msg === 'push-now') { push('manual').then(reply); return true; } });
