/* WMS Agent Link — background worker.
   Whenever the login cookies change (you log in, or the server rotates the session) for either of the two
   independent systems this warehouse app talks to — wms.gjirafamall.com and deliveryplatform.gjirafamall.com
   (a separate app, own database, same corporate SSO) — the current cookie header for that host is pushed to
   the local agent's matching endpoint, which validates it and stores it in its own config. Also re-pushed on
   browser start and every 30 min, so the agent never sits on a dead session while Chrome has a live one.
   The two services are pushed independently: a missing/dead session on one never affects the other. */
const AGENT = 'http://localhost:8790';
const ROOT_DOMAIN = 'gjirafamall.com';
const SERVICES = [
  { key: 'wms', hosts: ['wms.' + ROOT_DOMAIN, ROOT_DOMAIN], endpoint: '/wms/cookie', label: 'WMS' },
  { key: 'delivery', hosts: ['deliveryplatform.' + ROOT_DOMAIN], endpoint: '/delivery/cookie', label: 'Delivery Platform' },
];
let timer = null;

async function cookieHeaderFor(hosts) {
  const all = await chrome.cookies.getAll({ domain: ROOT_DOMAIN });
  const mine = all.filter(c => hosts.includes((c.domain || '').replace(/^\./, '')));
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
  return header ? header.split(/;\s*/).map(p => { const i = p.indexOf('='); return i > 0 ? p.slice(0, i).replace(/^(OpenIdConnect\.nonce)\..*$/, '$1…') + '(' + (p.length - i - 1) + ')' : p; }).join(', ') : '(asnjë cookie)';
}
async function pushOne(svc, reason) {
  const header = await cookieHeaderFor(svc.hosts);
  const result = { service: svc.key, label: svc.label, ok: false, msg: '' };
  if (!looksLoggedIn(header)) { result.msg = 'Nuk gjej biletë login-i të ' + svc.label + ' në KËTË Chrome/profil. Cookies: ' + describe(header) + '.'; result.skipped = !header; return result; }
  try {
    const r = await fetch(AGENT + svc.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie: header, source: 'extension' }) });
    const j = await r.json().catch(() => ({}));
    result.ok = r.ok && !j.error; result.msg = result.ok ? 'Sesioni u dërgua te agjenti ✓' : (j.error || ('Agjenti u përgjigj ' + r.status));
    if (result.ok && j.stats) result.stats = j.stats;
  } catch (e) { result.msg = 'Agjenti nuk përgjigjet në ' + AGENT + ' — a është ndezur? (' + e.message + ')'; result.agentDown = true; }
  return result;
}
async function push(reason) {
  // diagnostic ping (names + lengths only) so the agent log shows what the extension sees
  try { await fetch(AGENT + '/wms/ext-ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, version: chrome.runtime.getManifest().version }) }); } catch (e) {}
  const results = [];
  for (const svc of SERVICES) results.push(await pushOne(svc, reason));
  const state = { at: new Date().toISOString(), reason, results, ok: results.some(r => r.ok) };
  // headline message: prefer reporting a real failure (agent down / cookie rejected) over "not logged in here",
  // since the latter is normal for someone who only ever uses one of the two services
  const bad = results.find(r => !r.ok && !r.skipped);
  state.msg = bad ? bad.label + ': ' + bad.msg : results.filter(r => r.ok).map(r => r.label + ' ✓').join(' · ') || 'Nuk je kyçur në asnjë nga sistemet (WMS / Delivery Platform) në këtë Chrome.';
  await chrome.storage.local.set({ last: state });
  chrome.action.setBadgeText({ text: state.ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: state.ok ? '#1f9d55' : '#c0392b' });
  return state;
}
function schedule(reason) { clearTimeout(timer); timer = setTimeout(() => push(reason), 2500); }   // login sets several cookies in a burst

chrome.cookies.onChanged.addListener(info => {
  const d = (info.cookie.domain || '').replace(/^\./, '');
  if (d.endsWith(ROOT_DOMAIN) && /^(\.AspNet\.Cookies|ASP\.NET_SessionId|gjs)/.test(info.cookie.name) && !info.removed) schedule('cookie-changed');
});
chrome.runtime.onInstalled.addListener(() => { push('installed'); chrome.alarms.create('wms-push', { periodInMinutes: 30 }); });
chrome.runtime.onStartup.addListener(() => { push('browser-start'); chrome.alarms.create('wms-push', { periodInMinutes: 30 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'wms-push') push('periodic'); });
chrome.runtime.onMessage.addListener((msg, _s, reply) => { if (msg === 'push-now') { push('manual').then(reply); return true; } });
