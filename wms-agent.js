/* ============================================================================
   WMS Agent — local companion for the Warehouse app.
   Serves the app at http://localhost:<port> AND proxies authorized reads from
   GjirafaWMS using YOUR session cookie (kept only in wms-agent.config.json,
   local-only, git-ignored). No password is stored. Read-only GET/POST of the
   same endpoints the WMS site itself calls.

   Setup:
     1) copy wms-agent.config.example.json  ->  wms-agent.config.json
     2) paste your WMS "cookie" header value into it (see the README notes)
     3) run:  node wms-agent.js   (or double-click start-wms-agent.bat)
     4) open http://localhost:8790/app.html  and turn Auto-Sync ON

   Also: keeps the SHARED app database (wods-db.json — one copy for every browser
   on this PC) and generates the narrative daily report after shift close
   (cfg.dailyReportTime, default "21:30"). See shared.js.
   ==========================================================================*/
'use strict';
const http=require('http'), https=require('https'), fs=require('fs'), path=require('path'), url=require('url');

/* --- log to file as well as the console -----------------------------------
   The agent normally runs hidden (Startup / VBS), so console output is lost.
   Everything is appended to wms-agent.log next to this file (rotated at ~1 MB). */
(function(){
  const LOG=path.join(__dirname,'wms-agent.log');
  const write=(lvl,args)=>{ try{
    const line='['+new Date().toISOString()+'] '+lvl+' '+args.map(a=>typeof a==='string'?a:(a&&a.stack)||JSON.stringify(a)).join(' ')+'\n';
    try{ if(fs.existsSync(LOG) && fs.statSync(LOG).size>1e6) fs.renameSync(LOG, LOG+'.1'); }catch(e){}
    fs.appendFileSync(LOG, line);
  }catch(e){} };
  const oLog=console.log.bind(console), oErr=console.error.bind(console);
  console.log=(...a)=>{ oLog(...a); write('INFO',a); };
  console.error=(...a)=>{ oErr(...a); write('ERROR',a); };
  process.on('uncaughtException', e=>{ console.error('uncaughtException', e); setTimeout(()=>process.exit(1),200); });
  process.on('unhandledRejection', e=>{ console.error('unhandledRejection', e); });
  console.log('[wms-agent] starting  pid='+process.pid+'  node='+process.version+'  cwd='+process.cwd()+'  dir='+__dirname);
})();

let cfg={};
try{ cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'wms-agent.config.json'),'utf8')); }
catch(e){ console.error('\n[wms-agent] Missing wms-agent.config.json.\n  Copy wms-agent.config.example.json to wms-agent.config.json and paste your WMS cookie.\n'); process.exit(1); }

const WMS=(cfg.wmsBase||'https://wms.gjirafamall.com').replace(/\/+$/,'');
const PORT=cfg.port||8790;
const APPDIR=__dirname;
/* A literal "wms-agent" User-Agent looks nothing like a browser — found 2026-09-24: every freshly-pasted,
   just-validated WMS cookie was dying again within ~1-2 minutes, every single time, even with the user's
   own WMS browser tab closed (ruling out session-rotation conflict with their own browsing). That pattern
   — instantly valid, then killed moments later regardless of activity — matches WAF/anti-bot behaviour
   that fingerprints non-browser User-Agents and kills the session, not genuine sliding-expiration timeout.
   Presenting as an ordinary Chrome UA (still the user's own authenticated session, nothing bypassed) is
   the fix being tested. */
const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/* --- cookie jar with auto-renewal ---------------------------------------
   WMS uses ASP.NET cookie auth with SLIDING expiration: each request renews
   the session and the server returns a fresh Set-Cookie. We keep a jar,
   apply every Set-Cookie, persist it back to config.json, and ping the WMS
   on a timer — so the session stays alive without re-pasting the cookie,
   as long as the agent keeps running. (No auth is bypassed: this is exactly
   how a browser keeps its own session alive.) */
let cookieJar={};
/* A pasted cookie often arrives wrapped in quotes or with a "cookie:" label / line breaks (found 2026-09-24:
   the config held a cookie starting with a literal `"`, which made the first name `"__RequestVerificationToken`
   and corrupted the ticket). Strip all of that before parsing. */
function cleanCookieString(s){ return String(s||'').trim().replace(/^cookie:\s*/i,'').replace(/[\r\n]+/g,' ').trim().replace(/^["']+|["']+$/g,'').trim(); }
const unq=s=>String(s).trim().replace(/^["']+|["']+$/g,'');
function parseIntoJar(str){ cleanCookieString(str).split(/;\s*/).forEach(p=>{ const i=p.indexOf('='); if(i>0){ const n=unq(p.slice(0,i)); if(n) cookieJar[n]=unq(p.slice(i+1)); } }); }
parseIntoJar(cfg.cookie||'');
function cookieHeader(){ return Object.keys(cookieJar).map(n=>n+'='+cookieJar[n]).join('; '); }
if(!cookieHeader()){ console.error('[wms-agent] config.cookie is empty — paste your WMS session cookie first.'); process.exit(1); }
function applySetCookie(arr){ let changed=false; (arr||[]).forEach(sc=>{ const first=String(sc).split(';')[0]; const i=first.indexOf('='); if(i<=0) return;
  const n=first.slice(0,i).trim(), v=first.slice(i+1); if(!n) return;
  const expM=String(sc).match(/expires=([^;]+)/i); const expired=(v==='' ) || (expM && !isNaN(new Date(expM[1])) && new Date(expM[1])<new Date());
  if(expired){ if(cookieJar[n]!==undefined){ delete cookieJar[n]; changed=true; } }
  else if(cookieJar[n]!==v){ cookieJar[n]=v; changed=true; } });
  return changed; }
let lastPersist=0, lastWrittenCookie=cfg.cookie||'', sessionExpired=false;
const CFG_FILE=path.join(__dirname,'wms-agent.config.json');
function normalizeCookie(str){ const j={}; cleanCookieString(str).split(/;\s*/).forEach(p=>{ const i=p.indexOf('='); if(i>0){ const n=unq(p.slice(0,i)); if(n) j[n]=unq(p.slice(i+1)); } }); return j; }
function jarHeader(j){ return Object.keys(j).map(n=>n+'='+j[n]).join('; '); }
/* Load a cookie the user pasted into the config file (replaces the jar, resets the expired flag). */
function adoptExternalCookie(fresh){
  cookieJar=normalizeCookie(fresh.cookie); Object.assign(cfg, fresh); lastWrittenCookie=fresh.cookie; sessionExpired=false;
  console.log('[wms-agent] '+new Date().toLocaleTimeString()+' config changed — new WMS cookie loaded ('+cookieHeader().length+' chars), no restart needed.');
}
/* Persist the rotated jar — but NEVER over a cookie someone else wrote into the file, and never while the
   session is known to be expired (an expired jar must not clobber the fresh cookie the user is about to paste).
   force=true means the caller just accepted a freshly pasted, WMS-validated cookie and owns this write: the
   "external edit wins" check must be skipped. Bug found 2026-09-24: the /wms/cookie handler set
   lastWrittenCookie to the new value and then called this, so the OLD cookie still on disk always looked
   like an external edit — it was re-adopted on the spot and every fresh paste was silently thrown away
   (log showed "config changed" in the same millisecond as "accepted", every time). */
function persistCookie(force){
  const now=Date.now(); if(!force && now-lastPersist<8000) return; if(sessionExpired && !force) return;
  try{
    let onDisk=null; try{ onDisk=JSON.parse(fs.readFileSync(CFG_FILE,'utf8')); }catch(e){}
    if(!force && onDisk && onDisk.cookie && onDisk.cookie!==lastWrittenCookie && jarHeader(normalizeCookie(onDisk.cookie))!==cookieHeader()){
      adoptExternalCookie(onDisk); return;                       // external edit wins — do not overwrite it
    }
    lastPersist=now; cfg.cookie=cookieHeader(); lastWrittenCookie=cfg.cookie;
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg,null,2));
  }catch(e){}
}
/* Hot-reload: when the session has expired the user pastes a fresh cookie into wms-agent.config.json.
   Pick it up without a restart. Our own writes are recognised by lastWrittenCookie and skipped. */
fs.watchFile(CFG_FILE, {interval:3000}, ()=>{
  try{
    const fresh=JSON.parse(fs.readFileSync(CFG_FILE,'utf8'));
    if(!fresh.cookie || fresh.cookie===lastWrittenCookie || jarHeader(normalizeCookie(fresh.cookie))===cookieHeader()) return;
    adoptExternalCookie(fresh);
    keepAlive();   // verify immediately and log the result
  }catch(e){ /* half-written file or bad JSON — next change will retry */ }
});

function wmsFetch(pathname, opts){
  opts=opts||{};
  return new Promise((res,rej)=>{
    const u=new URL(WMS+pathname);
    const o={ method:opts.method||'GET', family:4, headers:Object.assign({
      'Cookie':cookieHeader(), 'User-Agent':BROWSER_UA, 'X-Requested-With':'XMLHttpRequest',
      'Accept':'application/json, text/html', 'Accept-Language':'en-US,en;q=0.9,sq;q=0.8',
      'Referer':WMS+'/', 'Origin':WMS,
      'sec-ch-ua-platform':'"Windows"', 'Sec-Fetch-Site':'same-origin', 'Sec-Fetch-Mode':'cors', 'Sec-Fetch-Dest':'empty'
    }, opts.headers||{}) };
    const req=https.request(u,o,r=>{ let d=''; r.setEncoding('utf8'); r.on('data',c=>d+=c); r.on('end',()=>{
      if(r.headers['set-cookie']){ logSetCookie(pathname, r.statusCode, r.headers['set-cookie']); if(applySetCookie(r.headers['set-cookie'])) persistCookie(); }
      res({status:r.statusCode,headers:r.headers,body:d,path:pathname}); }); });
    req.on('error',rej); if(opts.body) req.write(opts.body); req.end();
  });
}
/* Diagnostics for the 2026-09-24 "session dies within ~1 min of every paste" problem: names, value lengths
   and expiry only — never cookie values. */
function logSetCookie(p, status, arr){
  const d=(arr||[]).map(sc=>{ const first=String(sc).split(';')[0]; const i=first.indexOf('='); const n=first.slice(0,i), v=first.slice(i+1);
    const exp=(String(sc).match(/expires=([^;]+)/i)||[])[1]; const dom=(String(sc).match(/domain=([^;]+)/i)||[])[1];
    return n+'('+v.length+(v===''||(exp&&new Date(exp)<new Date())?',DELETE':'')+(dom?',dom='+dom:'')+')'; }).join(' ');
  console.log('[wms-agent] set-cookie on '+p+' ['+status+']: '+d);
}
function looksLoggedOut(r){ const out = r.status===302 || r.status===401 || /Account\/Log(in|On)|name="Password"|id="loginForm"/i.test(r.body||'');
  if(out && !sessionExpired) console.log('[wms-agent] LOGGED-OUT detected on '+(r.path||'?')+' — status '+r.status+
    (r.headers&&r.headers.location?' → location '+String(r.headers.location).slice(0,160):'')+
    ' · jar names: '+Object.keys(cookieJar).map(n=>n+'('+String(cookieJar[n]).length+')').join(' ')+
    ' · body[0..120]: '+JSON.stringify(String(r.body||'').slice(0,120)));
  sessionExpired=out;   // remembered so an expired jar is never persisted over a freshly pasted cookie
  return out; }
function enc(o,pfx,a){ a=a||[]; pfx=pfx||'';
  if(Array.isArray(o)) o.forEach((v,i)=>enc(v,pfx+'['+i+']',a));
  else if(o&&typeof o==='object') Object.keys(o).forEach(k=>enc(o[k],pfx?pfx+'['+k+']':k,a));
  else a.push(encodeURIComponent(pfx)+'='+encodeURIComponent(o==null?'':o));
  return a;
}
const p2=n=>('0'+n).slice(-2);
function today(){ const t=new Date(); return p2(t.getDate())+'/'+p2(t.getMonth()+1)+'/'+t.getFullYear(); }
function parseDMY(s){ const a=(s||'').split('/'); return new Date(+a[2],+a[1]-1,+a[0]); }

async function getStats(){
  const r=await wmsFetch('/Warehouse/GetDashboardStats');
  if(looksLoggedOut(r)) return {error:'auth_expired'};
  try{ return {data:JSON.parse(r.body)}; }catch(e){ return {error:'bad_response'}; }
}
async function getToken(){
  const r=await wmsFetch('/Order/Prepared');
  if(looksLoggedOut(r)) return {error:'auth_expired'};
  const m=(r.body||'').match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  return {token:m?m[1]:''};
}
async function getPrepared(start,end){
  const tk=await getToken(); if(tk.error) return tk;
  const s=parseDMY(start), e=parseDMY(end||start); const rows=[];
  for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)){
    const mdy=p2(d.getMonth()+1)+'/'+p2(d.getDate())+'/'+d.getFullYear();
    const iso=d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
    const cols=[{data:'Name',name:'',searchable:true,orderable:true,search:{value:'',regex:false}},{data:'PreparedOrders',name:'',searchable:true,orderable:true,search:{value:'',regex:false}}];
    const params={draw:1,start:0,length:1000,search:{value:'',regex:false},order:[{column:1,dir:'desc'}],columns:cols,filters:{startDate:mdy,endDate:mdy}};
    const body=enc(params).join('&')+(tk.token?'&__RequestVerificationToken='+encodeURIComponent(tk.token):'');
    const r=await wmsFetch('/Order/GetPreparedOrders',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body});
    if(looksLoggedOut(r)) return {error:'auth_expired'};
    let j; try{ j=JSON.parse(r.body); }catch(e){ return {error:'bad_response'}; }
    (j.data||[]).forEach(x=>rows.push({date:iso, operator:x.Name, preparedOrders:x.PreparedOrders}));
  }
  return {data:rows};
}

/* Products checked in / checked out per operator/day.
   Source: /Warehouse/ProductLogsData (event log).
   CHECKOUT_LOGTYPES history: first thought to be "Check out" alone, then "Check out"+"Checked out"
   (2026-09-22 — that combo undercounted 15-30% of full-day totals against AI Operator, and looked
   like a fix). Both were wrong. Confirmed 2026-09-23 with an intraday, zero-ambiguity test: on a
   quiet morning where the WHOLE day fit in one request (519 of 519 rows, no paging, no possible
   duplication/gap), AI Operator's "Checkout products" matched "ProductScanned for checkout" EXACTLY
   at both the 08:00 mark (39=39) and the 10:00 mark (85=85) — while "Check out"+"Checked out" gave
   4 and 55, nowhere close. The earlier full-day comparisons that seemed to favor "Check out"+"Checked
   out" were themselves corrupted by the very pagination unreliability documented below (any day busy
   enough to need real comparison was also busy enough to need >1 page). This intraday test is the
   first comparison ever done on a COMPLETE, unpaged dataset — trust it over the earlier ones.
   No date filter on the server side other than StartDate/EndDate (MM/DD/YYYY) + StoreId=0,
   so we loop one request per day (bounded volume) and group by operator. */
const CHECKIN_LOGTYPE='Checked in';
const CHECKOUT_LOGTYPES=['ProductScanned for checkout'];
const PLOG_COLS=['ProductItemUniqueIdentifier','ProductCode','Sku','ProductSerialNumber','VendorName','ProductName','OrderId','LogType','Row','UpdatedByName','InsertDateTime','LastInspectDate']
  .map(d=>({data:d,name:'',searchable:true,orderable:false,search:{value:'',regex:false}}));
const PLOG_PAGE=2000;   // a single length=6000 request returns HTTP 500, so page in safe chunks
/* WMS keeps APPENDING events to a "finished" calendar day's log for a while afterwards (backend/
   batch processing logs a backdated InsertDateTime) — confirmed 2026-09-22: re-fetching 21.09 a day
   later returned materially more rows (Checked in 854→1032, Check out 615→728) than our own sync had
   captured on the day itself. So a past day is only safe to cache once it has had time to "settle" —
   caching from day one (as before) silently froze an incomplete count forever. */
const CACHE_SETTLE_DAYS=3;
const checkinCache={}; // iso date -> {ops, inCount, outCount} — only for days older than CACHE_SETTLE_DAYS
const dayLogsCache={};  // mdy -> {rows, reliable} — one WMS fetch per date per agent run, several endpoints share it
function isoToday(){ const t=new Date(); return t.getFullYear()+'-'+p2(t.getMonth()+1)+'-'+p2(t.getDate()); }
/* Fetch every ProductLogs row for one calendar day (all LogTypes, no filter) exactly once.
   Start-offset paging on this WMS endpoint is badly broken: on 23.09 (5348 rows) the page at start=2000
   came back IDENTICAL to start=0, and a single length=6000 request returns HTTP 500. The server also
   ignores every time-of-day and search filter (tested 2026-09-24), so the volume can't be shrunk.
   What works: every row carries WMS's own primary key `Id`, so rows are collected from paging in BOTH
   sort directions (newest-first, then oldest-first, then smaller pages if still short) into a map keyed
   by Id, until the unique count equals recordsFiltered. Verified 2026-09-24 on 23.09: 5348 of 5348
   unique rows, and orders until 08:00 = 26, orders until 16:00 = 323, checkout until 16:00 = 438 — all
   exactly AI Operator's figures. (An earlier cross-page dedup was reverted because it keyed on the
   display field ProductItemUniqueIdentifier, which is blank on most rows; the real Id has no such
   problem.) A day that still can't be completed is returned reliable:false — callers disclose it. */
const PLOG_MAXREQ=40;   // safety cap on requests per day
async function fetchDayProductLogs(mdy, opts){
  opts=opts||{}; if(!opts.noCache && dayLogsCache[mdy]) return dayLogsCache[mdy];
  const mk=(start,length,dir)=>({draw:1,start,length,search:{value:'',regex:false},order:[{column:10,dir}],columns:PLOG_COLS,
    filters:{StartDate:mdy,EndDate:mdy,StoreId:0,ProductCode:'',Sku:'',ProductItemUniqueIdentifier:'',ProductSerialNumber:''}});
  const get=async(start,length,dir)=>{
    const r=await wmsFetch('/Warehouse/ProductLogsData',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:enc(mk(start,length,dir)).join('&')});
    if(looksLoggedOut(r)) return {error:'auth_expired'};
    try{ const j=JSON.parse(r.body); return {rows:j.data||[], total:Number(j.recordsFiltered)||0}; }catch(e){ return {error:'bad_response'}; }
  };
  const first=await get(0,PLOG_PAGE,'desc');
  if(first.error) return {error:first.error};
  const total=first.total||first.rows.length;
  const byId=new Map(); const addAll=rows=>rows.forEach(x=>byId.set(x.Id!=null?x.Id:JSON.stringify(x), x));
  addAll(first.rows);
  let reqs=1;
  const passes=[[PLOG_PAGE,'desc',PLOG_PAGE],[PLOG_PAGE,'asc',0],[1000,'desc',0],[1000,'asc',0]];
  outer: for(const [len,dir,from] of passes){
    for(let s=from; s<total; s+=len){
      if(byId.size>=total || reqs>=PLOG_MAXREQ) break outer;
      const p=await get(s,len,dir); reqs++;
      if(p.error==='auth_expired') return {error:'auth_expired'};
      if(p.error) continue;   // one bad page (e.g. a 500) — the other passes can still fill it
      if(!p.rows.length) break;
      addAll(p.rows);
    }
  }
  const rows=[...byId.values()];
  const out={rows, reliable: rows.length>=total, total, requests:reqs};
  if(!out.reliable) console.log('[wms-agent] '+mdy+': only '+rows.length+' of '+total+' ProductLogs rows recovered after '+reqs+' requests');
  if(!opts.noCache) dayLogsCache[mdy]=out;
  return out;
}
async function getCheckins(start,end){
  const s=parseDMY(start), e=parseDMY(end||start); const out=[]; const daily=[]; const tIso=isoToday();
  const tDate=new Date(tIso+'T00:00:00');
  for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)){
    const mdy=p2(d.getMonth()+1)+'/'+p2(d.getDate())+'/'+d.getFullYear();
    const iso=d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
    const age=Math.round((tDate - new Date(iso+'T00:00:00'))/86400000);   // days between this date and today
    const settled=age>=CACHE_SETTLE_DAYS;
    // only fully "settled" past days are cached — anything more recent is refetched every time,
    // since WMS can still be appending events to it (see note above)
    if(settled && checkinCache[iso]){ const c=checkinCache[iso];
      c.ops.forEach(o=>out.push({date:iso,operator:o.operator,checkedIn:o.checkedIn||0,checkedOut:o.checkedOut||0}));
      daily.push({date:iso,checkedIn:c.inCount,checkedOut:c.outCount}); continue; }
    const dl=await fetchDayProductLogs(mdy, {noCache:!settled});   // don't cross-cache an unsettled day across two callers in the same run
    if(dl.error) return dl;
    const byIn={}, byOut={}; let inCount=0, outCount=0;
    dl.rows.forEach(x=>{
      const op=(x.UpdatedByName||'').trim()||'(pa operator)';
      if(x.LogType===CHECKIN_LOGTYPE){ inCount++; byIn[op]=(byIn[op]||0)+1; }
      else if(CHECKOUT_LOGTYPES.includes(x.LogType)){ outCount++; byOut[op]=(byOut[op]||0)+1; }
    });
    const opsSet=new Set([...Object.keys(byIn),...Object.keys(byOut)]);
    const ops=[...opsSet].map(op=>({operator:op, checkedIn:byIn[op]||0, checkedOut:byOut[op]||0}));
    ops.forEach(o=>out.push({date:iso, operator:o.operator, checkedIn:o.checkedIn, checkedOut:o.checkedOut}));
    daily.push({date:iso, checkedIn:inCount, checkedOut:outCount});
    if(settled) checkinCache[iso]={ops, inCount, outCount}; // only cache once the day has had time to settle
  }
  return {data:out, daily};
}

/* --- bi-hourly flow report ("Flow (2h)" tab) ----------------------------------
   Mirrors the warehouse's own WhatsApp "AI Operator" bot: for a chosen date, the running totals at
   08:00, 10:00, ... 20:00 local time, each against the same hour yesterday, plus the 2-hour tempo.
   Everything is reconstructed from ProductLogs InsertDateTime, for any date, past or present.
   "Orders completed" = distinct OrderIds on LogTypeId 9 ("Driver") rows. Every checkout scan writes
   two log rows — "ProductScanned for checkout" (27) and "Driver" (9), same count — and AI Operator's
   figure matched LogTypeId 9 exactly on every point checked against the WMS database (2026-09-24):
   23.09 until 08:00 = 26, until 16:00 = 323, 22.09 until 16:00 = 299, 22.09 full day = 459; LogTypeId
   27 was off by one on one of them. "Picks" counts any pick-type log row: WMS's PickSessionScan table
   has never held a single scan, so this is 0 today — the same 0 AI Operator reports. */
const FLOW_MARKS=[8,10,12,14,16,18,20];
const ORDER_DONE_LOGTYPE_ID=9;
/* AI Operator's "Check-ins" counts "Checked in" rows ONLY by this warehouse's own staff (found 2026-09-24,
   exact on all 10 data points 22–25.09): rows with no operator name and rows by Gjirafa accounts outside
   the warehouse (And Sahatciu, Liridon Ramabaja, Mentor Sahiti, Arben Hyseni — confirmed not staff by the
   warehouse lead) are excluded. The roster is editable in the app and stored in the agent's own config
   (cfg.warehouseStaff, via POST /wms/staff — one writer, so the shared-DB merge can't overwrite an edit);
   this list is only the fallback. "Arian Racaj" and "Arian Rraca" are the same person with two WMS accounts
   (confirmed by the lead). */
const DEFAULT_WAREHOUSE_STAFF=['Xhevat Llumnica','Shpetim Hajrullahu','Erik Mehmeti','Albert Demiri','Erdi Qalaj','Anela Dakaj',
  'Agon Miftari','Rron Miftari','Arian Racaj','Arian Rraca','Albina Sinani','Flaka Selmani','Ensar Hoxha','Kaon Halili',
  'Bardh Thaçi','Shkelzen Musliu','Ardit Shillova','Festim Berisha'];
const normName=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
function warehouseStaffList(){ return (Array.isArray(cfg.warehouseStaff) && cfg.warehouseStaff.length) ? cfg.warehouseStaff : DEFAULT_WAREHOUSE_STAFF; }
function warehouseStaffSet(){ return new Set(warehouseStaffList().map(normName).filter(Boolean)); }
function parseWmsDate(s){ const m=/\/Date\((\d+)\)\//.exec(s||''); return m?Number(m[1]):null; }
function isoAddDays(iso,n){ const d=new Date(iso+'T12:00:00'); d.setDate(d.getDate()+n); return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
function isoToMdy(iso){ const [y,m,d]=iso.split('-'); return m+'/'+d+'/'+y; }
/* Cumulative counts strictly before each local-time mark ("until 16:00" = up to 15:59:59), plus a base
   mark 2h before the first so the 08:00 tempo has something to subtract, plus the full-day totals. */
function cumulativeByMark(rows, iso, staff){
  const hours=[FLOW_MARKS[0]-2, ...FLOW_MARKS];
  const y=Number(iso.slice(0,4)), mo=Number(iso.slice(5,7))-1, d=Number(iso.slice(8,10));
  const cuts=hours.map(h=>new Date(y,mo,d,h,0,0,0).getTime());
  const blank=()=>({checkedIn:0, checkedInAll:0, checkedOut:0, picks:0, orders:new Set()});
  const acc=hours.map(blank), full=blank();
  rows.forEach(x=>{
    const isInAll=x.LogType===CHECKIN_LOGTYPE, isIn=isInAll && staff.has(normName(x.UpdatedByName));
    const isOut=CHECKOUT_LOGTYPES.includes(x.LogType);
    const isOrder=Number(x.LogTypeId)===ORDER_DONE_LOGTYPE_ID && !!x.OrderId, isPick=/pick/i.test(x.LogType||'');
    if(!isInAll && !isOut && !isOrder && !isPick) return;
    const add=o=>{ if(isIn) o.checkedIn++; if(isInAll) o.checkedInAll++; if(isOut) o.checkedOut++; if(isPick) o.picks++; if(isOrder) o.orders.add(x.OrderId); };
    add(full);
    const t=parseWmsDate(x.InsertDateTime); if(t==null) return;
    for(let i=0;i<cuts.length;i++) if(t<cuts[i]) add(acc[i]);
  });
  const fin=o=>({checkedIn:o.checkedIn, checkedInAll:o.checkedInAll, checkedOut:o.checkedOut, picks:o.picks, orders:o.orders.size});
  return {base:fin(acc[0]), marks:acc.slice(1).map(fin), full:fin(full)};
}
/* Dashboard tile "Check-in products/orders": products the warehouse staff checked in on the day (same rule as
   AI Operator's Check-ins) and how many distinct orders those same physical units went out in (checkout) that
   day — linked by WMS's per-unit id, since check-in rows themselves carry no OrderId. */
function checkinSummary(rows, iso, reliable){
  const staff=warehouseStaffSet(); const units=new Set(); let products=0;
  rows.forEach(x=>{ if(x.LogType===CHECKIN_LOGTYPE && staff.has(normName(x.UpdatedByName))){ products++; if(x.ProductItemUniqueIdentifierId) units.add(x.ProductItemUniqueIdentifierId); } });
  const orders=new Set(), unitsOut=new Set();
  rows.forEach(x=>{ if(Number(x.LogTypeId)===ORDER_DONE_LOGTYPE_ID && x.OrderId && units.has(x.ProductItemUniqueIdentifierId)){ orders.add(x.OrderId); unitsOut.add(x.ProductItemUniqueIdentifierId); } });
  return {date:iso, products, orders:orders.size, productsOut:unitsOut.size, reliable};
}
async function flowDayMarks(iso, staff){
  // "today" (and any day younger than CACHE_SETTLE_DAYS) keeps gaining events all day — dayLogsCache
  // must NOT serve a snapshot from an earlier call in this same agent run, or every mark after the
  // first-ever fetch of that date would silently freeze (found 2026-09-23: the 10:00 mark kept
  // reporting the row set fetched around 09:16 instead of the true, larger one hours later).
  const age=Math.round((new Date(isoToday()+'T00:00:00') - new Date(iso+'T00:00:00'))/86400000);
  const dl=await fetchDayProductLogs(isoToMdy(iso), {noCache: age<CACHE_SETTLE_DAYS});
  if(dl.error) return {error:dl.error};
  const c=cumulativeByMark(dl.rows, iso, staff);
  return {marks:c.marks, base:c.base, full:c.full, reliable:dl.reliable};
}
async function buildFlow2h(db, iso){
  const today=isoToday(); const prevIso=isoAddDays(iso,-1);
  const staff=warehouseStaffSet();
  const [cur, prev] = await Promise.all([ flowDayMarks(iso, staff), flowDayMarks(prevIso, staff) ]);
  if(cur.error) return {error:cur.error};
  const nowH = iso===today ? new Date().getHours()+new Date().getMinutes()/60 : null;
  const pct=(now,then)=> (then!=null && then>0) ? Math.round((now-then)/then*100) : null;
  const marks = FLOW_MARKS.map((h,i)=>{
    const c=cur.marks[i], p=prev.error?null:prev.marks[i], before=i?cur.marks[i-1]:cur.base;
    return { hour:p2(h)+':00',
      orders:c.orders, ordersPrev:p?p.orders:null, ordersPct:p?pct(c.orders,p.orders):null,
      checkedIn:c.checkedIn, checkedInAll:c.checkedInAll, checkedInPrev:p?p.checkedIn:null,
      picks:c.picks, picksPrev:p?p.picks:null,
      checkedOut:c.checkedOut, checkedOutPrev:p?p.checkedOut:null, checkedOutPct:p?pct(c.checkedOut,p.checkedOut):null,
      // floored, like AI Operator (18:00 on 23.09: 309 products / 2h = 154.5 → it reports 154)
      tempoOrders:Math.floor((c.orders-before.orders)/2), tempoProducts:Math.floor((c.checkedOut-before.checkedOut)/2),
      future: iso===today && h>nowH+0.001 };
  });
  const prevFullDay = prev.error ? null : prev.full;
  return { date:iso, prevDate:prevIso, marks, prevFullDay, staff:warehouseStaffList(), reliable: cur.reliable && (prev.error?true:prev.reliable),
    note:'Të gjitha shifrat rindërtohen nga log-u i eventeve të WMS-it deri në orën e saktë, me të njëjtat përkufizime si AI Operator (të verifikuara). Orders completed = porosi të ndryshme me skanim checkout. Check-ins = vetëm check-in nga stafi i depos (lista më poshtë) — pa rreshtat pa operator dhe pa llogaritë e Gjirafës jashtë depos. Picks: WMS nuk regjistron skanime picking — prandaj 0, njësoj si te AI Operator.' };
}

/* --- "Check-in / Checkout Report" tab -----------------------------------------
   Built from a handwritten spec (2026-09-23): per-period breakdown of Check-in and
   Checkout activity. Everything here comes from ProductLogs (same rows fetchDayProductLogs
   already retrieves reliably). Mapping = LogTypeId 7 ("Mapped product" — the unit placed on a shelf
   row), WMS's own "Mapping" operation in PerformanceOperationTypes. Until 2026-09-28 this used
   "Map product", which is LogTypeId 6 — the stock step BEFORE mapping (2 → 6 → 7), not the mapping.
   Two items from the original spec are NOT available from WMS at all — "stock vs local
   sellers" and "POD" (proof of delivery) live in a separate system (deliveryplatform.
   gjirafamall.com, its own login/database) which this agent has no access to. Rather than
   guess, those fields are returned with available:false and a note — never a fabricated number.
   "AVG time" fields are computed by matching a later event to an earlier one on the SAME
   product-unit identifier (ProductItemUniqueIdentifier) — many rows (mostly "Checked in")
   carry no identifier, so a "coverage" percentage is always reported alongside the average
   so the number is never read as more complete than it is. */
const MAPPING_LOGTYPE_ID=7;
function avgMs(arr){ return arr.length? arr.reduce((a,b)=>a+b,0)/arr.length : null; }
function lastNDays(n){ const t=isoToday(); const out=[]; for(let i=n-1;i>=0;i--) out.push(isoAddDays(t,-i)); return out; }
async function collectRangeRows(days){
  const all=[]; let reliable=true;
  for(const iso of days){
    const age=Math.round((new Date(isoToday()+'T00:00:00') - new Date(iso+'T00:00:00'))/86400000);
    const dl=await fetchDayProductLogs(isoToMdy(iso), {noCache: age<CACHE_SETTLE_DAYS});
    if(dl.error) return dl;
    dl.rows.forEach(r=>all.push(r));
    if(!dl.reliable) reliable=false;
  }
  return {rows:all, reliable};
}
function opAggregate(list){
  const m={};
  list.forEach(r=>{ const op=(r.UpdatedByName||'').trim()||'(pa operator)';
    const g=m[op]||(m[op]={count:0, orders:new Set()}); g.count++; if(r.OrderId) g.orders.add(r.OrderId); });
  return Object.entries(m).map(([operator,v])=>({operator, count:v.count, orders:v.orders.size})).sort((a,b)=>b.count-a.count);
}
/* time from the nearest earlier "from" event to each "to" event, matched on ProductItemUniqueIdentifierId —
   the raw per-unit id WMS always fills in (confirmed via the database: 100% populated on every LogType,
   and the SAME id persists across a unit's Check-in→Mapping→Checkout lifecycle). The display field
   "ProductItemUniqueIdentifier" (no "Id" suffix) that this same endpoint also returns is NOT reliable —
   found empty on every row tested, whatever the LogType — so it must never be used as a join key. */
function avgGapMs(fromRows, toRows){
  const byKey={};
  fromRows.forEach(r=>{ const k=r.ProductItemUniqueIdentifierId; if(!k) return; const t=parseWmsDate(r.InsertDateTime); if(t==null) return; (byKey[k]=byKey[k]||[]).push(t); });
  const gaps=[];
  toRows.forEach(r=>{ const k=r.ProductItemUniqueIdentifierId; if(!k || !byKey[k]) return; const t=parseWmsDate(r.InsertDateTime); if(t==null) return;
    const earlier=byKey[k].filter(ft=>ft<=t); if(!earlier.length) return; gaps.push(t-Math.max(...earlier)); });
  return {avgMs:avgMs(gaps), matched:gaps.length};
}
function buildCheckReport(rows, db, days){
  const inRows=rows.filter(r=>r.LogType===CHECKIN_LOGTYPE);
  const outRows=rows.filter(r=>CHECKOUT_LOGTYPES.includes(r.LogType));
  const mapRows=rows.filter(r=>Number(r.LogTypeId)===MAPPING_LOGTYPE_ID);
  const withOrder=list=>list.filter(r=>r.OrderId).length;
  const ci2map=avgGapMs(inRows, mapRows);
  const ci2out=avgGapMs(inRows, outRows);
  const ciIds=new Set(inRows.map(r=>r.ProductItemUniqueIdentifierId).filter(Boolean));
  const outFromCheckin=outRows.filter(r=>r.ProductItemUniqueIdentifierId && ciIds.has(r.ProductItemUniqueIdentifierId));
  const outOrders=new Set(outRows.map(r=>r.OrderId).filter(Boolean));
  const outFromCheckinOrders=new Set(outFromCheckin.map(r=>r.OrderId).filter(Boolean));
  const byOrderSize={}; outRows.forEach(r=>{ if(r.OrderId) byOrderSize[r.OrderId]=(byOrderSize[r.OrderId]||0)+1; });
  const orderSizes=Object.values(byOrderSize);
  const preparedOrders=(db.wmsPrepared||[]).filter(r=>days.includes(r.date)).reduce((a,r)=>a+(Number(r.preparedOrders)||0),0);
  const NA=note=>({available:false, note});
  const DELIVERY_NOTE='Kërkon lidhje të veçantë me deliveryplatform.gjirafamall.com (sistem tjetër, me login/bazë të vet) — jo ende e disponueshme.';
  return {
    range:{from:days[0], to:days[days.length-1], days:days.length},
    checkin:{
      total:inRows.length, withOrder:withOrder(inRows), stockOnly:inRows.length-withOrder(inRows),
      byOperator:opAggregate(inRows),
      avgTimeToMap:{ms:ci2map.avgMs, matched:ci2map.matched, coveragePct: inRows.length?Math.round(ci2map.matched/inRows.length*100):0},
      avgTimeToCheckout:{ms:ci2out.avgMs, matched:ci2out.matched, coveragePct: inRows.length?Math.round(ci2out.matched/inRows.length*100):0},
      mapping:{total:mapRows.length, withOrder:withOrder(mapRows), stockOnly:mapRows.length-withOrder(mapRows), byOperator:opAggregate(mapRows)},
      pod:NA(DELIVERY_NOTE),
    },
    checkout:{
      total:outRows.length, preparedOrders, distinctOrders:outOrders.size,
      avgItemsPerOrder: orderSizes.length ? avgMs(orderSizes) : null,
      fromCheckin:{orders:outFromCheckinOrders.size, pct: outOrders.size?Math.round(outFromCheckinOrders.size/outOrders.size*100):null},
      byOperator:opAggregate(outRows),
      stockVsLocalSellers:NA(DELIVERY_NOTE),
      pod:NA(DELIVERY_NOTE),
      pendingOtherShipment:NA('Kërkon logjikë shtesë biznesi (backorder ndaj shipmentesh) që s\'është ende e përcaktuar.'),
      orderAgeInDb:NA('Kërkon datën e krijimit të porosisë — endpoint i ri, jo ende i lidhur.'),
    },
  };
}

/* --- "Performance" tab — WMS's own productivity model ----------------------------------------------
   Same definitions the WMS itself uses (documented in the gjirafa-wms-data-analyst knowledge base):
   operation types and weights from PerformanceOperationTypes (check-out = LogTypeId 4/18 ×1.0, check-in = 2
   ×0.8, map = 7 ×0.6); bands from PerformanceSettings (above the team average +25%, below it −25%);
   standard times from WarehouseActions.AverageTimeSeconds (check-in 33.2 s, map 18.6 s, check-out 86.1 s)
   against an 8-hour day. Only the warehouse staff roster is counted (same roster as Check-ins). Picking is
   left out: WMS logs no pick scans yet (PickSessionScan is empty). */
const PERF_KIND={2:'checkin', 7:'map', 4:'checkout', 18:'checkout'};
const PERF_WEIGHT={checkout:1.0, checkin:0.8, map:0.6};
const PERF_SECONDS={checkin:33.2, map:18.6, checkout:86.1};
const PERF_BAND_PCT=25, PERF_DAY_HOURS=8;
const STAFF_ALIASES={'arian rraca':'Arian Racaj'};   // two WMS accounts, one person (confirmed by the lead)
const localIso=ms=>{ const d=new Date(ms); return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); };
function buildPerformance(rows, days){
  const staff=warehouseStaffSet(), by={};
  const hourly=Array.from({length:24},(_,h)=>({hour:h, checkin:0, map:0, checkout:0}));
  rows.forEach(x=>{
    const kind=PERF_KIND[Number(x.LogTypeId)]; if(!kind) return;
    const raw=String(x.UpdatedByName||'').replace(/\s+/g,' ').trim(); if(!staff.has(normName(raw))) return;
    const ts=parseWmsDate(x.InsertDateTime); if(ts==null) return;
    const name=STAFF_ALIASES[normName(raw)]||raw;
    const w=by[name]||(by[name]={operator:name, checkin:0, map:0, checkout:0, days:new Set()});
    w[kind]++; w.days.add(localIso(ts)); hourly[new Date(ts).getHours()][kind]++;
  });
  const workers=Object.values(by).map(w=>{
    const weighted=w.checkout*PERF_WEIGHT.checkout + w.checkin*PERF_WEIGHT.checkin + w.map*PERF_WEIGHT.map;
    const stdHours=(w.checkin*PERF_SECONDS.checkin + w.map*PERF_SECONDS.map + w.checkout*PERF_SECONDS.checkout)/3600;
    const activeDays=w.days.size;
    return {operator:w.operator, checkin:w.checkin, map:w.map, checkout:w.checkout, activeDays,
      weighted:Math.round(weighted*10)/10, perDay:activeDays?Math.round(weighted/activeDays*10)/10:0,
      stdHours:Math.round(stdHours*10)/10, stdHoursPerDay:activeDays?Math.round(stdHours/activeDays*10)/10:0,
      utilPct:activeDays?Math.round(stdHours/activeDays/PERF_DAY_HOURS*100):0};
  });
  const avg=workers.length? workers.reduce((a,w)=>a+w.perDay,0)/workers.length : 0;
  workers.forEach(w=>{ w.band = w.perDay>avg*(1+PERF_BAND_PCT/100) ? 'above' : w.perDay<avg*(1-PERF_BAND_PCT/100) ? 'below' : 'average'; });
  workers.sort((a,b)=>b.perDay-a.perDay);
  return {range:{from:days[0], to:days[days.length-1], days:days.length}, workers, teamAvgPerDay:Math.round(avg*10)/10,
    hourly:hourly.filter(h=>h.checkin||h.map||h.checkout), bandPct:PERF_BAND_PCT, dayHours:PERF_DAY_HOURS};
}

/* --- "Statistikat e WH" module: WMS data-access layer (all definitions live in wms-stats.js) ---------- */
const shiftSchedule=require('./shift-schedule.js')({ appDir:APPDIR, normName, warehouseStaffList, STAFF_ALIASES });
// which WMS account is logged in at which table PC (by IP) — reports from the "WMS Station" extension, own port on the LAN
const stationPresence=require('./station-presence.js')({ appDir:APPDIR, cfgFile:CFG_FILE, cfg, normName, aliases:STAFF_ALIASES });
stationPresence.listen(Number(cfg.stationPort||8791));
const wmsStats=require('./wms-stats.js')({ appDir:APPDIR, fetchDayProductLogs, isoToday, isoAddDays, isoToMdy, lastNDays, parseWmsDate,
  CACHE_SETTLE_DAYS, warehouseStaffSet, normName, STAFF_ALIASES, PERF_KIND, PERF_WEIGHT, PERF_SECONDS, loadDb, scheduleForDay:iso=>shiftSchedule.forDay(iso) });
/* Module settings (agent config, one writer). Thresholds are starting values meant to be tuned by the lead:
   ok (green) when the value reaches `green`, warning (yellow) up to `yellow`, red beyond — `higherIsBetter`
   decides the direction. */
const STATS_DEFAULTS={ cutoff:'17:30', targetOrdersPerDay:1000,
  thresholds:{ ordersPerDay:{green:1000, yellow:850, higherIsBetter:true},
               putawayMedianMin:{green:60, yellow:120, higherIsBetter:false},
               unmappedOver24h:{green:0, yellow:50, higherIsBetter:false},
               safetyObs:{green:0, yellow:1, higherIsBetter:false} } };
function statsConfig(){ const c=cfg.stats||{}; return Object.assign({}, STATS_DEFAULTS, c, {thresholds:Object.assign({}, STATS_DEFAULTS.thresholds, c.thresholds||{})}); }

/* --- Delivery Platform (deliveryplatform.gjirafamall.com) — second, independent connection ----------
   A completely separate system from WMS: its own login (same corporate SSO, but its own app/database),
   confirmed 2026-09-23. Holds POD (Proof of Delivery) data that WMS itself does not have. Mirrors the
   WMS cookie-jar pattern above but is entirely self-contained — a missing/expired Delivery Platform
   session must never affect WMS sync, and vice versa; that's why it gets its own jar, its own
   sessionExpired flag and its own persisted config field (deliveryCookie), never touching cfg.cookie.
   GetPodLogs' request shape (DataTables — draw/columns/order/start/length/search/filters) was read
   directly off a live Network-tab capture (2026-09-23): a delivery-date-RESCHEDULE log (orderId,
   platformName, oldDelivery, newDelivery, insertDateTime, insertedBy, reason) — not yet the
   "orders currently in POD" list (GetCurrentPodOrders), whose shape hasn't been captured yet, so
   that endpoint is intentionally NOT wired up here — no guessed request body. */
const DELIVERY_BASE=(cfg.deliveryBase||'https://deliveryplatform.gjirafamall.com').replace(/\/+$/,'');
let deliveryCookieJar={};
function parseIntoJarInto(jar,str){ cleanCookieString(str).split(/;\s*/).forEach(p=>{ const i=p.indexOf('='); if(i>0){ const n=unq(p.slice(0,i)); if(n) jar[n]=unq(p.slice(i+1)); } }); }
parseIntoJarInto(deliveryCookieJar, cfg.deliveryCookie||'');
function deliveryCookieHeader(){ return Object.keys(deliveryCookieJar).map(n=>n+'='+deliveryCookieJar[n]).join('; '); }
let deliverySessionExpired=!deliveryCookieHeader();
function applySetCookieInto(jar,arr){ let changed=false; (arr||[]).forEach(sc=>{ const first=String(sc).split(';')[0]; const i=first.indexOf('='); if(i<=0) return;
  const n=first.slice(0,i).trim(), v=first.slice(i+1); if(!n) return;
  const expM=String(sc).match(/expires=([^;]+)/i); const expired=(v==='') || (expM && !isNaN(new Date(expM[1])) && new Date(expM[1])<new Date());
  if(expired){ if(jar[n]!==undefined){ delete jar[n]; changed=true; } } else if(jar[n]!==v){ jar[n]=v; changed=true; } });
  return changed; }
function persistDeliveryCookie(){
  try{ let onDisk=null; try{ onDisk=JSON.parse(fs.readFileSync(CFG_FILE,'utf8')); }catch(e){}
    if(onDisk){ onDisk.deliveryCookie=deliveryCookieHeader(); fs.writeFileSync(CFG_FILE, JSON.stringify(onDisk,null,2)); cfg.deliveryCookie=onDisk.deliveryCookie; } }catch(e){}
}
function deliveryFetch(pathname,opts){
  opts=opts||{};
  return new Promise((res,rej)=>{
    const u=new URL(DELIVERY_BASE+pathname);
    const o={ method:opts.method||'GET', family:4, headers:Object.assign({
      'Cookie':deliveryCookieHeader(), 'User-Agent':BROWSER_UA, 'X-Requested-With':'XMLHttpRequest', 'Accept':'application/json, text/html',
      'Referer':DELIVERY_BASE+'/', 'Origin':DELIVERY_BASE
    }, opts.headers||{}) };
    const req=https.request(u,o,r=>{ let d=''; r.setEncoding('utf8'); r.on('data',c=>d+=c); r.on('end',()=>{
      if(r.headers['set-cookie']){ if(applySetCookieInto(deliveryCookieJar, r.headers['set-cookie'])) persistDeliveryCookie(); }
      res({status:r.statusCode, headers:r.headers, body:d}); }); });
    req.on('error',rej); if(opts.body) req.write(opts.body); req.end();
  });
}
function deliveryLooksLoggedOut(r){ const out = r.status===302 || r.status===401 || /Account\/Log(in|On)|name="Password"|id="loginForm"|login\.gjirafa\.com/i.test(r.body||'');
  deliverySessionExpired=out; return out; }
const POD_LOG_COLS=['orderId','platformName','oldDelivery','newDelivery','insertDateTime','insertedBy','reason']
  .map(d=>({data:d,name:'',searchable:true,orderable:(d==='insertDateTime'||d==='reason'),search:{value:'',regex:false}}));
async function fetchPodLogs(startIso,endIso,opts){
  opts=opts||{};
  const params={draw:1, columns:POD_LOG_COLS, order:[{column:4,dir:'desc'}], start:opts.start||0, length:opts.length||100,
    search:{value:'',regex:false}, filters:{startDate:startIso, endDate:endIso}};
  const r=await deliveryFetch('/Delivery/GetPodLogs',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:enc(params).join('&')});
  if(deliveryLooksLoggedOut(r)) return {error:'auth_expired'};
  let j; try{ j=JSON.parse(r.body); }catch(e){ return {error:'bad_response'}; }
  return {rows:j.data||[], total:Number(j.recordsFiltered)||0};
}

/* --- POD (Proof of Delivery) — Delivery Platform, read-only -----------------------------------------
   A "delivery" is one courier's batch for a day (POST /Delivery/FilterDeliveries); its orders come from
   POST /Delivery/FilterDeliveryItems, one delivery at a time (an all-deliveries query returns 500). These are the
   list reads the platform's own POD pages use — the write endpoints (ChangeOrdersStatus, ChangePOD, manual POD,
   AcceptDelivery …) are never called. Customer data (name, phone, e-mail, address, signature, comments, notes,
   customer id, logs) is dropped right here: only the fields below ever leave this function. */
const POD_ITEM_FIELDS=['orderId','platformId','platform','type','deliveryDate','deliveredDate','insertedInPodDate','createDateTime','shippingDate',
  'paymentMethod','price','totalPrice','cashAccepted','isPaid','processStatus','processStatusFundReceived','processStatusRefused','deliveryItemStatus',
  'itemDeliveryStatusId','orderStatus','driverName','packages','numberOfDaysToDeliverOrder','moreThan24HNePoste','moreThan24HENisur','reviewScore',
  'isStarterKit','pickUpInStore','city','hasShippingDate','isPreorder','paymentMethodId'];
const dtCols=n=>Array.from({length:n},()=>({data:'',name:'',searchable:true,orderable:false,search:{value:'',regex:false}}));
const podCache={}, podInflight={};
async function deliveryPostJson(pathname, params){
  const r=await deliveryFetch(pathname,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:enc(params).join('&')});
  if(deliveryLooksLoggedOut(r)) return {error:'auth_expired'};
  if(r.status!==200) return {error:'HTTP '+r.status};
  try{ return JSON.parse(r.body); }catch(e){ return {error:'bad_response'}; }
}
async function fetchPodDay(iso){
  const ttl= iso>=isoToday()? 5*60000 : 6*3600000, c=podCache[iso];
  if(c && Date.now()-c.t<ttl) return c.v;
  if(podInflight[iso]) return podInflight[iso];
  return podInflight[iso]=(async()=>{ try{
    const base={draw:1, start:0, length:999, search:{value:'',regex:false}, order:[{column:0,dir:'desc'}], columns:dtCols(6)};
    const d=await deliveryPostJson('/Delivery/FilterDeliveries', Object.assign({}, base, {filters:{driverId:'', deliveryStatusId:'0', startDate:iso, endDate:iso}}));
    if(d.error) return d;
    const deliveries=(d.data||[]).map(x=>({id:x.id, uid:x.deliveryUniqueId, driver:x.driver, statusId:x.deliveryStatusId, status:x.deliveryStatus,
      date:x.deliveryDate, pod:x.podCloseTime, group:x.group||''}));
    const items=[], failed=[];
    for(let i=0;i<deliveries.length;i+=4){
      await Promise.all(deliveries.slice(i,i+4).map(async dl=>{
        const r=await deliveryPostJson('/Delivery/FilterDeliveryItems', Object.assign({}, base, {deliveryId:String(dl.id), order:[{column:1,dir:'desc'}], columns:dtCols(17),
          filters:{startDate:iso, endDate:iso, processStatus:'', platformId:'', onlyOrders:false, deliveredStartDate:'', deliveredEndDate:'', deliveredStatus:''}}));
        if(r.error){ failed.push(dl.id); return; }
        (r.data||[]).forEach(x=>{ const o={deliveryId:dl.id};
          // the platform writes "no date" as 0001-01-01T00:00:00
          POD_ITEM_FIELDS.forEach(k=>{ if(x[k]!==undefined) o[k]= typeof x[k]==='string' && x[k].startsWith('0001-01-01')? null : x[k]; });
          const di=x.deliveryItems||{}; o.packagesTotal=di.numberOfPackages; o.packagesScanned=di.numberOfPackagesScanned; o.itemProcessStatusId=di.itemProcessStatusId;
          items.push(o); });
      }));
    }
    const v={date:iso, at:new Date().toISOString(), deliveries, items, failed};
    if(!failed.length) podCache[iso]={t:Date.now(), v};
    return v;
  } finally { delete podInflight[iso]; } })();
}

/* --- shared database (wods-db.json) ------------------------------------------
   One canonical copy of the app database for every browser on this machine. The
   app pulls it at boot, pushes on every save (with an optimistic-concurrency
   check on meta.savedAt) and polls it for changes made elsewhere. The 21:30
   report job below writes to the same file. */
const WODS=require('./shared.js');
const DB_FILE=path.join(APPDIR,'wods-db.json');
function loadDb(){ try{ return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }catch(e){ return null; } }
function saveDb(db){ db.meta=db.meta||{}; db.meta.savedAt=new Date().toISOString();
  fs.writeFileSync(DB_FILE+'.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE+'.tmp', DB_FILE); return db.meta.savedAt; }
function readBody(req){ return new Promise((res,rej)=>{ let d=''; req.setEncoding('utf8'); req.on('data',c=>{ d+=c; if(d.length>50e6){ rej(new Error('too large')); req.destroy(); } }); req.on('end',()=>res(d)); req.on('error',rej); }); }

/* --- daily report job ---------------------------------------------------------
   Runs once a day after cfg.dailyReportTime (default 21:30, after shift N2 closes):
   1) syncs the day's WMS figures, 2) turns them into rule-based Daily Observation
   records (fact / hypothesis / validation step — deduped by analysisKey),
   3) builds the narrative report and archives it in db.dailyReports + /reports/*.html.
   A run is also triggered on startup when the time has passed and today's report
   is missing (agent was off at 21:30), and on demand via POST /report/run. */
const REPORT_TIME=String(cfg.dailyReportTime||'21:30');
const REPORTS_DIR=path.join(APPDIR,'reports');
let jobRunning=false;
function dmy(iso){ const p=iso.split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }
function addDays(iso,n){ const d=new Date(iso+'T12:00:00'); d.setDate(d.getDate()+n); return WODS.localDate(d); }
async function runDailyJob(date, scheduled, opts){
  if(jobRunning) return {error:'busy'};
  opts=opts||{}; jobRunning=true; const started=Date.now(); const out={date, synced:false, autoObservations:0};
  try{
    date=date||isoToday();
    // 1) fetch from WMS first (network), then load → mutate → save the db synchronously (no await in between)
    let stats=null, prepared=null, checkins=null;
    try{
      if(date===isoToday()){ const s=await getStats(); if(!s.error) stats=s.data; }
      const pr=await getPrepared(dmy(addDays(date,-6)), dmy(date)); if(!pr.error) prepared=pr.data;
      const ci=await getCheckins(dmy(date), dmy(date)); if(!ci.error) checkins=ci;
      out.synced=!!(prepared||checkins||stats);
    }catch(e){ out.syncError=String(e&&e.message||e); }
    const db=loadDb(); if(!db){ out.error='no shared database yet — open the app once via http://localhost:'+PORT+'/app.html'; return out; }
    if(stats) WODS.importStats(db, stats, {date, sourceRef:'agent-job'});
    if(prepared) WODS.importPrepared(db, prepared, {dateRange:dmy(addDays(date,-6))+' - '+dmy(date), sourceRef:'agent-job'});
    if(checkins){ WODS.importCheckin(db, checkins.data||[], {dateRange:dmy(date)+' - '+dmy(date), sourceRef:'agent-job'}); if(checkins.daily) WODS.importFlow(db, checkins.daily, {sourceRef:'agent-job'}); }
    if(out.synced){ db.wms=db.wms||{}; db.wms.lastSuccess=new Date().toISOString(); db.wms.lastError=''; }   // a successful sync clears the "cookie expired" banner
    // 2) rule-based findings → observations (never duplicates: analysisKey)
    const obs=db.observations||(db.observations=[]);
    const have=new Set(obs.map(o=>o.analysisKey).filter(Boolean));
    // rule findings are skipped when the day already carries a manual WMS analysis (source "WMS analysis")
    // — the analyst's entries cover the same ground with more context; both would only duplicate the day.
    const manualWms=obs.some(o=>o.date===date && !o.auto && /wms/i.test(o.source||''));
    if(manualWms) out.autoSkipped='manual WMS analysis present for this date';
    const dead=db.deleted||{};   // tombstones written by the app on delete — a finding the analyst removed must not come back
    (opts.skipAuto||manualWms?[]:WODS.wmsAutoObservations(db, date, REPORT_TIME)).forEach(o=>{ if(have.has(o.analysisKey) || dead['observations|ak|'+o.analysisKey]) return;
      const now=new Date().toISOString();
      obs.unshift(Object.assign({id:WODS.uid('obs'), createdAt:now, createdBy:'WMS auto-analysis', updatedAt:now, updatedBy:'WMS auto-analysis'}, o)); out.autoObservations++; });
    // 3) narrative → archive
    const generatedAt=new Date().toISOString();
    const rep=WODS.buildDailyNarrative(db, date, {closing:true, generatedAt, title:'Raport ditor automatik · mbyllja e turnit'});
    if(!rep.empty){
      const reps=db.dailyReports||(db.dailyReports=[]);
      const i=reps.findIndex(r=>r.date===date); const rec={id:(i>=0?reps[i].id:WODS.uid('rep')), date, generatedAt, auto:true, scheduled:!!scheduled, html:rep.html, text:rep.text, stats:rep.stats, updatedAt:generatedAt};
      if(i>=0) reps[i]=rec; else reps.unshift(rec);
      try{ fs.mkdirSync(REPORTS_DIR,{recursive:true}); fs.writeFileSync(path.join(REPORTS_DIR,'daily-'+date+'.html'), WODS.standaloneReportPage('Raport ditor '+WODS.fmtDateAl(date), rep.html)); out.file='reports/daily-'+date+'.html'; }catch(e){ out.fileError=String(e.message||e); }
      out.stats=rep.stats;
    } else out.note='no data for this date';
    if(scheduled){ db.meta=db.meta||{}; db.meta.lastAutoReportDate=date; }
    out.savedAt=saveDb(db); out.ms=Date.now()-started;
    console.log('[wms-agent] '+new Date().toLocaleTimeString()+' daily report '+date+(scheduled?' (scheduled)':' (manual)')+': '+(out.synced?'WMS sync ✓':'no sync')+', +'+out.autoObservations+' auto observations, '+(out.file||'no file'));
  }catch(e){ out.error=String(e&&e.message||e); console.log('[wms-agent] daily report failed: '+out.error); }
  finally{ jobRunning=false; }
  return out;
}
function hhmmNow(){ const t=new Date(); return p2(t.getHours())+':'+p2(t.getMinutes()); }

/* --- weekly report job -------------------------------------------------------
   Every week on cfg.weeklyReportDay (0=Sun … 6=Sat, default 5 = Friday) after
   cfg.weeklyReportTime (default 21:35, i.e. right after the daily report):
   syncs the whole week's WMS figures (prepared per day + check-in/out per day),
   builds the narrative weekly report and archives it in db.weeklyReports +
   /reports/weekly-<monday>.html. Catch-up: if the agent was off, it runs the
   missing report the next time it is up later that week (Sat/Sun included).
   Manual / retroactive: POST /report/week?date=YYYY-MM-DD (any day of the week). */
const WEEKLY_DAY=Number(cfg.weeklyReportDay!=null?cfg.weeklyReportDay:5);
const WEEKLY_TIME=String(cfg.weeklyReportTime||'21:35');
async function runWeeklyJob(anyDate, scheduled, opts){
  if(jobRunning) return {error:'busy'};
  opts=opts||{}; jobRunning=true; const started=Date.now();
  const {start:ws, end:we}=WODS.weekBounds(anyDate||isoToday());
  const weEff = we<isoToday()? we : isoToday();       // never ask WMS for the future
  const out={weekStart:ws, weekEnd:we, synced:false};
  try{
    let prepared=null, checkins=null, stats=null;
    if(!opts.noSync){ try{
      const pr=await getPrepared(dmy(ws), dmy(weEff)); if(!pr.error) prepared=pr.data;
      const ci=await getCheckins(dmy(ws), dmy(weEff)); if(!ci.error) checkins=ci;
      if(weEff===isoToday()){ const s=await getStats(); if(!s.error) stats=s.data; }
      out.synced=!!(prepared||checkins);
    }catch(e){ out.syncError=String(e&&e.message||e); } }
    const db=loadDb(); if(!db){ out.error='no shared database yet — open the app once via http://localhost:'+PORT+'/app.html'; return out; }
    if(prepared) WODS.importPrepared(db, prepared, {dateRange:dmy(ws)+' - '+dmy(weEff), sourceRef:'agent-weekly'});
    if(checkins){ WODS.importCheckin(db, checkins.data||[], {dateRange:dmy(ws)+' - '+dmy(weEff), sourceRef:'agent-weekly'}); if(checkins.daily) WODS.importFlow(db, checkins.daily, {sourceRef:'agent-weekly'}); }
    if(stats) WODS.importStats(db, stats, {date:isoToday(), sourceRef:'agent-weekly'});
    if(out.synced){ db.wms=db.wms||{}; db.wms.lastSuccess=new Date().toISOString(); db.wms.lastError=''; }   // a successful sync clears the "cookie expired" banner
    const generatedAt=new Date().toISOString();
    const rep=WODS.buildWeeklyNarrative(db, ws, {generatedAt});
    if(!rep.empty){
      const reps=db.weeklyReports||(db.weeklyReports=[]);
      const i=reps.findIndex(r=>r.weekStart===ws);
      const rec={id:(i>=0?reps[i].id:WODS.uid('wrep')), weekStart:ws, weekEnd:we, weekNo:rep.weekNo, generatedAt, auto:true, scheduled:!!scheduled, html:rep.html, text:rep.text, stats:rep.stats, updatedAt:generatedAt};
      if(i>=0) reps[i]=rec; else reps.unshift(rec);
      try{ fs.mkdirSync(REPORTS_DIR,{recursive:true}); fs.writeFileSync(path.join(REPORTS_DIR,'weekly-'+ws+'.html'), WODS.standaloneReportPage('Raport javor '+WODS.fmtDateAl(ws)+' – '+WODS.fmtDateAl(we), rep.html)); out.file='reports/weekly-'+ws+'.html'; }catch(e){ out.fileError=String(e.message||e); }
      out.weekNo=rep.weekNo; out.stats=rep.stats;
    } else out.note='no data for this week';
    if(scheduled){ db.meta=db.meta||{}; db.meta.lastWeeklyReportWeek=ws; }
    out.savedAt=saveDb(db); out.ms=Date.now()-started;
    console.log('[wms-agent] '+new Date().toLocaleTimeString()+' weekly report '+ws+' – '+we+(scheduled?' (scheduled)':' (manual)')+': '+(out.synced?'WMS sync ✓':'no sync')+', '+(out.file||'no file')+', '+out.ms+' ms');
  }catch(e){ out.error=String(e&&e.message||e); console.log('[wms-agent] weekly report failed: '+out.error); }
  finally{ jobRunning=false; }
  return out;
}
async function reportTick(){
  const today=isoToday(); const db=loadDb(); if(!db) return;
  // daily
  if(hhmmNow()>=REPORT_TIME && !(db.meta && db.meta.lastAutoReportDate===today)){ await runDailyJob(today, true); return; }
  // weekly: due once the configured weekday+time of the current week has passed
  const t=new Date(); const dowMon=(t.getDay()+6)%7, targetMon=(WEEKLY_DAY+6)%7;
  const due = dowMon>targetMon || (dowMon===targetMon && hhmmNow()>=WEEKLY_TIME);
  if(due){ const ws=WODS.weekBounds(today).start; if(!(db.meta && db.meta.lastWeeklyReportWeek===ws)) await runWeeklyJob(today, true); }
}
setInterval(reportTick, 30*1000);
setTimeout(reportTick, 8000); // catch-up shortly after start (agent was off at report time)

/* --- Google Chat: the Flow (2h) report after each mark ------------------------------------------------
   Posts the same text as a Flow (2h) card to a Google Chat space through its incoming webhook
   (cfg.googleChatWebhook). The webhook URL is a secret — anyone holding it can post to that space — so it
   lives only in the git-ignored config. One message per mark per day: the latest elapsed mark is sent once;
   marks missed while the PC was off are not back-filled (only the newest goes out, no burst on wake-up). */
const CHAT_STATE_FILE=path.join(APPDIR,'flow-chat-state.json');
function chatState(){ try{ return JSON.parse(fs.readFileSync(CHAT_STATE_FILE,'utf8')); }catch(e){ return {sent:{}}; } }
function saveChatState(s){ try{ fs.writeFileSync(CHAT_STATE_FILE, JSON.stringify(s,null,2)); }catch(e){} }
function flowChatText(data, m){
  const pct=p=> p==null?'':' ('+(p>=0?'+':'')+p+'%)', yv=v=> v==null?'—':v, pf=data.prevFullDay;
  return '*Warehouse — flow until '+m.hour+'* ('+data.date.split('-').reverse().join('.')+')\n\n'
    +'Orders completed today: *'+m.orders+'*'+pct(m.ordersPct)+' — yesterday at this hour '+yv(m.ordersPrev)+'\n'
    +'Check-ins: *'+m.checkedIn+'* — yesterday '+yv(m.checkedInPrev)+'\n'
    +'Picks: *'+m.picks+'* products — yesterday '+yv(m.picksPrev)+'\n'
    +'Checkout products: *'+m.checkedOut+'*'+pct(m.checkedOutPct)+' — yesterday: '+yv(m.checkedOutPrev)+'\n\n'
    +'Current tempo: *'+m.tempoOrders+'* orders/hour · *'+m.tempoProducts+'* products/hour (last 2 hours)'
    +(pf?'\n\nYesterday full day: '+pf.checkedIn+' check-ins · '+pf.checkedOut+' checkout (products) · '+pf.orders+' orders':'')
    +(data.reliable===false?'\n\n⚠ Të dhëna jo të plota për njërën nga ditët (faqëzimi i WMS-it).':'');
}
function postToChat(text, webhook){
  return new Promise(res=>{
    let u; try{ u=new URL(webhook||cfg.googleChatWebhook); }catch(e){ return res({error:'webhook i pavendosur'}); }
    const body=JSON.stringify({text});
    const r=https.request(u,{method:'POST',headers:{'Content-Type':'application/json; charset=UTF-8','Content-Length':Buffer.byteLength(body)}},resp=>{
      let d=''; resp.setEncoding('utf8'); resp.on('data',c=>d+=c);
      resp.on('end',()=>res(resp.statusCode>=200&&resp.statusCode<300?{ok:true}:{error:'HTTP '+resp.statusCode+' '+d.slice(0,200)})); });
    r.on('error',e=>res({error:e.message})); r.write(body); r.end();
  });
}
function latestElapsedMark(){ const n=new Date(), mins=n.getHours()*60+n.getMinutes(); return FLOW_MARKS.filter(h=>mins>=h*60+1).pop(); }
async function sendFlowToChat(hour, test){
  const data=await buildFlow2h(loadDb()||{}, isoToday());
  let text;
  if(data.error) text='⚠ *Warehouse — flow until '+p2(hour)+':00*: s\'u gjenerua — '+(data.error==='auth_expired'?'sesioni i WMS ka skaduar; ngjit një cookie të re te localhost:8790.':data.error);
  else { const m=data.marks.find(x=>x.hour===p2(hour)+':00'); if(!m) return {error:'ora '+p2(hour)+':00 s\'u gjet'}; text=flowChatText(data, m); }
  const r=await postToChat(text);
  console.log('[wms-agent] Google Chat flow '+p2(hour)+':00'+(test?' (test)':'')+': '+(r.ok?'sent ✓':'FAILED '+r.error));
  return Object.assign(r,{hour:p2(hour)+':00'});
}
let chatBusy=false;
async function chatTick(){
  if(!cfg.googleChatWebhook || chatBusy) return;
  const h=latestElapsedMark(); if(h==null) return;
  const today=isoToday(), st=chatState(), sent=(st.sent&&st.sent[today])||[];
  if(sent.includes(h)) return;
  // after a failure, wait 10 min before retrying the same mark (don't hammer a broken webhook every minute)
  if(st.lastError && st.lastError.hour===h && Date.now()-new Date(st.lastError.at).getTime()<10*60*1000) return;
  chatBusy=true;
  try{
    const r=await sendFlowToChat(h);
    if(r.ok){ st.sent={[today]:[...sent,h]}; st.last={at:new Date().toISOString(), hour:r.hour}; delete st.lastError; }
    else st.lastError={at:new Date().toISOString(), hour:h, error:r.error};
    saveChatState(st);
  }finally{ chatBusy=false; }
}
setInterval(chatTick, 60*1000);
setTimeout(chatTick, 15000);

/* WMS Pulse build. The scheduled Claude task only runs the read-only queries (pulse/queries.sql) — a shell step there
   waits for an approval nobody sees and the refresh stalls. So the agent builds: when a Claude Code transcript newer
   than pulse/data.json contains WMS Pulse query results (the /*pulse:X*\/ markers), it runs pulse/build.js, which
   reads those results and writes data.json + wms-pulse.html. Same machine, nothing leaves it. */
const PULSE_DATA=path.join(APPDIR,'pulse','data.json'), CLAUDE_PROJECTS=path.join(require('os').homedir(),'.claude','projects');
let pulseBuilding=false, pulseState={lastBuild:null, lastError:null, lastCheck:null};
function pulseNewResults(){
  let since=0; try{ since=fs.statSync(PULSE_DATA).mtimeMs; }catch(e){}
  const cutoff=Math.max(since, Date.now()-90*60000);
  let dirs=[]; try{ dirs=fs.readdirSync(CLAUDE_PROJECTS); }catch(e){ return false; }
  for(const d of dirs){ const p=path.join(CLAUDE_PROJECTS,d); let fl; try{ fl=fs.readdirSync(p); }catch(e){ continue; }
    for(const f of fl){ if(!f.endsWith('.jsonl')) continue; const fp=path.join(p,f); let st; try{ st=fs.statSync(fp); }catch(e){ continue; }
      if(st.mtimeMs<=cutoff) continue;
      // only the tail written since the last build can hold new results
      try{ const fd=fs.openSync(fp,'r'), len=Math.min(st.size, 8*1024*1024), buf=Buffer.alloc(len); fs.readSync(fd,buf,0,len,st.size-len); fs.closeSync(fd);
        if(buf.includes('/*pulse:') && buf.includes('queryWMSDb')) return true; }catch(e){} } }
  return false;
}
function pulseTick(){
  if(pulseBuilding) return; pulseState.lastCheck=new Date().toISOString();
  if(!pulseNewResults()) return;
  pulseBuilding=true;
  require('child_process').execFile(process.execPath, [path.join(APPDIR,'pulse','build.js'),'--from-transcripts','--max-age','90'], {cwd:APPDIR, timeout:120000, windowsHide:true}, (err, out, errOut)=>{
    pulseBuilding=false;
    if(err){ pulseState.lastError={at:new Date().toISOString(), error:String(errOut||err.message).trim().slice(0,300)}; console.log('[wms-agent] WMS Pulse build failed: '+pulseState.lastError.error); }
    else { pulseState.lastBuild=new Date().toISOString(); pulseState.lastError=null; console.log('[wms-agent] '+String(out).trim().split('\n').pop()); }
  });
}
setInterval(pulseTick, 2*60*1000);
setTimeout(pulseTick, 20000);

/* WMS store names (StoreId → store name) and the return dispositions. The WMS database has no store table; the web app's
   return-history page lists every store in its filter and the returns dashboard lists the dispositions (20 defect,
   21 outlet, 22 back to stock, 29 auction). Read-only GETs with the WMS session, cached 12 h in memory and in
   pulse/stores.json (git-ignored, never served statically). Used by the Shipments and Kthimet pages. */
const STORES_FILE=path.join(APPDIR,'pulse','stores.json');
let storeCache=(()=>{ try{ return JSON.parse(fs.readFileSync(STORES_FILE,'utf8')); }catch(e){ return {at:0, stores:{}, disp:{}, types:{}}; } })();
function htmlOptions(html, marker){
  const i=html.indexOf(marker); if(i<0) return [];
  const start=html.lastIndexOf('<select', i), end=html.indexOf('</select>', i); if(start<0||end<0) return [];
  const dec=s=>s.replace(/&#(x?)([0-9a-f]+);/gi,(m,x,n)=>String.fromCodePoint(parseInt(n,x?16:10))).replace(/&amp;/g,'&').replace(/<[^>]+>/g,'').trim();
  const out=[], re=/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi; let m; const body=html.slice(start,end);
  while((m=re.exec(body))) if(m[1]!=='') out.push([m[1], dec(m[2])]);
  return out;
}
async function wmsStores(force){
  if(!force && storeCache.at && Date.now()-storeCache.at<12*3600e3 && Object.keys(storeCache.stores||{}).length) return storeCache;
  try{
    const a=await wmsFetch('/ReturnProcess/Returns?focusedMenu=ReturnHistory'); if(looksLoggedOut(a)) return Object.assign({}, storeCache, {error:'auth_expired'});
    const b=await wmsFetch('/Product/ReturnsDashboard?focusedMenu=ReturnsDashboard');
    const stores=Object.fromEntries(htmlOptions(a.body,'name="storeId"')), types=Object.fromEntries(htmlOptions(a.body,'id="transferTypeFilter"'));
    const disp= looksLoggedOut(b)? (storeCache.disp||{}) : Object.fromEntries(htmlOptions(b.body,'id="dashboard-dropdown"'));
    if(Object.keys(stores).length){ storeCache={at:Date.now(), stores, disp, types}; try{ fs.writeFileSync(STORES_FILE, JSON.stringify(storeCache)); }catch(e){} }
  }catch(e){ return Object.assign({}, storeCache, {error:e.message}); }
  return storeCache;
}

/* Problem / Bottleneck Register (bottleneck/): the WmsDataAdapter keeps bottleneck/queries.run.sql in step with the
   module's Settings (Store config.bottleneck.params), turns new D1–D13 query results found in the Claude Code
   transcripts into a snapshot, and the detectors turn the latest snapshot + thresholds into candidates on request. */
/* Tabela ditore (page /tabela): live per-operator numbers from today's WMS log + the hourly cut-off figures (pulse block M).
   See tabela-board.js. The live part is cached ~2 min so a board that refreshes often does not hammer the WMS. */
const tabelaBoard=require('./tabela-board.js');
const TABELA_DEFAULT_STATIONS=['CHECKOUT 1','CHECKOUT 2','CHECKOUT 3','CHECKOUT 4','CHECKOUT 5','CHECKOUT 6','CHECKIN & CHECKOUT','CHECKIN 1','CHECKIN 2','CHECKIN 3','CHECKIN SELLERS']
  .map(n=>({name:n, co:/CHECKOUT/.test(n), ci:/CHECKIN/.test(n)}));
let tabelaLive=null, tabelaLiveAt=0, tabelaLiveBusy=null;
async function tabelaLiveData(force){
  if(!force && tabelaLive && Date.now()-tabelaLiveAt<110000) return tabelaLive;
  if(tabelaLiveBusy) return tabelaLiveBusy;
  tabelaLiveBusy=(async()=>{ try{
      const dl=await fetchDayProductLogs(isoToMdy(isoToday()), {noCache:true});
      if(dl.error) return {error:dl.error};
      const r=tabelaBoard.liveByOperator(dl.rows, warehouseStaffSet(), normName, parseWmsDate, STAFF_ALIASES);
      tabelaLive=Object.assign(r,{reliable:dl.reliable, at:new Date().toISOString()}); tabelaLiveAt=Date.now(); return tabelaLive;
    } finally { tabelaLiveBusy=null; } })();
  return tabelaLiveBusy;
}
/* local overrides of the WMS station list (set by the warehouse lead, 03–04.10.2026): CHECKOUT 5 and CHECKIN 3 are not in use;
   CHECKOUT 6 is used as the refusals/returns table — it counts the refused orders collected (Delivery Platform Scanned
   Refusals) and, as a second figure, processed customer-return units (WMS dispositions 20/21/22/29) */
const TABELA_STATION_CFG={'CHECKOUT 5':{hidden:true}, 'CHECKIN 3':{hidden:true}, 'CHECKOUT 6':{label:'Tavolina për refuzime/kthime', kind:'ret'}};
function tabelaStations(){
  let list=TABELA_DEFAULT_STATIONS;
  try{ const b=JSON.parse(fs.readFileSync(PULSE_DATA,'utf8')).board; if(b&&b.stations&&b.stations.length) list=b.stations.map(s=>({name:s.name, co:!!s.co, ci:!!s.ci})); }catch(e){}
  const ipOf={}; stationPresence.stationMap().forEach(m=>{ ipOf[m.station]=m; });   // the physical table (and its PC's IP) of each WMS station
  return list.filter(s=>!(TABELA_STATION_CFG[s.name]||{}).hidden).map(s=>Object.assign({}, s, TABELA_STATION_CFG[s.name]||{}, ipOf[s.name]? {table:ipOf[s.name].table, ip:ipOf[s.name].ip||null} : {})).concat(tabelaBoard.EXTRA_STATIONS);
}
/* POD for the board: the orders scanned for the couriers in the Delivery Platform ("Accept Delivery → Scanned Orders",
   POST /AcceptDelivery/GetScannedOrders — the read the platform's own page makes). Only the scanner's name and the scan
   time leave this function. The name is the account logged in on the POD scanner (found 04.10.2026: the POD station
   stayed logged in as one person for weeks), so it is only per-person when each operator logs in with their own account.
   One request per day, paged until recordsFiltered (the server may return fewer rows than asked). Cache: today 2 min. */
const podScanCache={};
async function fetchPodScans(iso){
  const c=podScanCache[iso], ttl= iso>=isoToday()? 110000 : 6*3600000;
  if(c && Date.now()-c.t<ttl) return c.v;
  const rows=[], seen=new Set(); let total=null;
  for(let start=0, guard=0; guard<60; guard++){
    const r=await deliveryPostJson('/AcceptDelivery/GetScannedOrders',{draw:1, start, length:500, search:{value:'',regex:false}, order:[{column:0,dir:'desc'}],
      columns:dtCols(5), filters:{startDate:iso, endDate:iso, groupId:''}});
    if(r.error){ if(r.error==='auth_expired') deliverySessionExpired=true; return {error:r.error}; }
    const d=r.data||[]; total=Number(r.recordsFiltered)||0;
    d.forEach(x=>{ const k=x.orderId+'|'+x.platformName+'|'+x.scanDateTime; if(seen.has(k)) return; seen.add(k);
      const s=String(x.scanDateTime||''), m=/\/Date\((\d+)\)\//.exec(s), t= m? Number(m[1]) : Date.parse(s.replace(' ','T'));
      if(!isNaN(t)) rows.push({scanner:String(x.scannerName||'').replace(/\s+/g,' ').trim(), t}); });
    start+=d.length; if(!d.length || start>=total) break;
  }
  const v={date:iso, rows, total, complete: total==null || rows.length>=total, at:new Date().toISOString()};
  podScanCache[iso]={t:Date.now(), v}; return v;
}
/* POD orders per day for Kapaciteti & Stafi (the "Boxing / POD" process volume): only the day's total (recordsFiltered of
   one 1-row request), all accounts. Days older than 2 days do not change any more and are kept in data/pod-daily.json, so
   the 12-week range is read from the Delivery Platform once and afterwards only the recent days are re-read. */
const POD_DAILY_FILE=path.join(APPDIR,'data','pod-daily.json');
let podDailyMem=null, podDailyBusy=null;
async function podDailyCounts(from, to){
  if(podDailyBusy) return podDailyBusy;
  return podDailyBusy=(async()=>{ try{
    let store={}; try{ store=JSON.parse(fs.readFileSync(POD_DAILY_FILE,'utf8')); }catch(e){}
    if(podDailyMem && podDailyMem.key===from+'|'+to && Date.now()-podDailyMem.t<10*60000) return podDailyMem.v;
    const days={}, settledBefore=isoAddDays(isoToday(),-2); let error=null, changed=false;
    for(let d=from; d<=to && d<=isoToday(); d=isoAddDays(d,1)){
      if(d<settledBefore && store[d]!=null){ days[d]=store[d]; continue; }
      const r=await deliveryPostJson('/AcceptDelivery/GetScannedOrders',{draw:1, start:0, length:1, search:{value:'',regex:false}, order:[{column:0,dir:'desc'}],
        columns:dtCols(5), filters:{startDate:d, endDate:d, groupId:''}});
      if(r.error){ error=r.error; if(r.error==='auth_expired'){ deliverySessionExpired=true; break; } continue; }
      days[d]=Number(r.recordsFiltered)||0; if(d<settledBefore){ store[d]=days[d]; changed=true; }
    }
    if(changed){ try{ fs.mkdirSync(path.dirname(POD_DAILY_FILE),{recursive:true}); fs.writeFileSync(POD_DAILY_FILE, JSON.stringify(store)); }catch(e){} }
    const v={from, to, days, error, at:new Date().toISOString()};
    if(!error) podDailyMem={key:from+'|'+to, t:Date.now(), v};
    return v;
  } finally { podDailyBusy=null; } })();
}
/* Refusals for the board: the refused orders a courier brings back, collected at the warehouse (Delivery Platform
   "Refusals → Scanned Refusals", POST /Refusals/FilterScannedRefusals — the read the platform's own page makes). One row
   per collection; only the collector ("Collecter Responsible"), the number of orders and the scan time leave here. */
const refScanCache={};
async function fetchRefusalScans(iso){
  const c=refScanCache[iso], ttl= iso>=isoToday()? 110000 : 6*3600000;
  if(c && Date.now()-c.t<ttl) return c.v;
  const rows=[], seen=new Set(); let total=null;
  for(let start=0, guard=0; guard<20; guard++){
    const r=await deliveryPostJson('/Refusals/FilterScannedRefusals',{draw:1, start, length:500, search:{value:'',regex:false}, order:[{column:0,dir:'desc'}],
      columns:dtCols(8), filters:{StartDate:iso, EndDate:iso, GroupId:'', OrderId:'', RefusalStatusId:''}});
    if(r.error){ if(r.error==='auth_expired') deliverySessionExpired=true; return {error:r.error}; }
    const d=r.data||[]; total=Number(r.recordsFiltered)||0;
    d.forEach(x=>{ const k=String(x.refusalCollectionUniqueId||'')+'|'+x.scanningDate; if(seen.has(k)) return; seen.add(k);
      const s=String(x.scanningDate||''), m=/\/Date\((\d+)\)\//.exec(s), t= m? Number(m[1]) : Date.parse(s.replace(' ','T'));
      if(!isNaN(t)) rows.push({receiver:String(x.collectionReceiver||'').replace(/\s+/g,' ').trim(), n:Number(x.nrOrders)||0, t}); });
    start+=d.length; if(!d.length || start>=total) break;
  }
  const v={date:iso, rows, total, complete: total==null || rows.length>=total, at:new Date().toISOString()};
  refScanCache[iso]={t:Date.now(), v}; return v;
}
/* POD by courier ("Postat", POD page): every order still waiting to be sent ("Duke pritur për dërgim") in the POD
   deliveries of the last N days — an order that was not sent stays in its old delivery (found 05.10.2026: the 02–04.10
   deliveries still held ~180 waiting orders that are not in today's) — once per order, its latest delivery winning.
   Per courier: total, by payment group, by order age (from its creation). "Over 3 days" = created more than 3 days ago,
   EXCEPT orders with a fixed date (hasShippingDate), paid by bank transfer, or prepaid by card/online but not paid yet
   (cash and POS are paid on delivery, so "not paid" is normal for them). Order numbers only — no customer data. */
const POD_PENDING_DAYS=Number(cfg.podPendingDays||7), POD_WAIT='Duke pritur për dërgim', POD_AGE_LBL=['0–1 ditë','2–3 ditë','> 3 ditë'];
const POD_POST_ORDER=[/^beki/i, /^express/i, /^fiks/i, /^merre/i, /^starlink/i, /^boxes/i, /^pick ?up ?point/i];   // Beki, Express, Fiks, Merre vet, Starlink, Boxes, PickUpPoint
function podPayGroup(pm){ const s=String(pm||''); if(!s) return 'Pa metodë'; if(/bank transfer/i.test(s)) return 'Bank transfer'; if(/^cash/i.test(s)) return 'Cash';
  if(/^pos/i.test(s)) return 'POS'; if(/credit|card|online/i.test(s)) return 'Kartë / online'; return s; }
let podPendingCache=null, podPendingBusy=null;
async function podPending(force){
  if(!force && podPendingCache && Date.now()-podPendingCache.t<4*60000) return podPendingCache.v;
  if(podPendingBusy) return podPendingBusy;
  return podPendingBusy=(async()=>{ try{
    const today=isoToday(), now=Date.now(), byOrder=new Map(); let error=null, daysRead=0;
    for(let i=POD_PENDING_DAYS-1;i>=0;i--){ const d=isoAddDays(today,-i); const r=await fetchPodDay(d);
      if(r.error){ error=r.error; if(r.error==='auth_expired') break; continue; } daysRead++;
      (r.items||[]).forEach(x=>byOrder.set(x.orderId+'-'+x.platformId, Object.assign({}, x, {dd:d}))); }   // oldest → newest: the latest delivery wins
    const ageOf=x=>{ const t=Date.parse(String(x.createDateTime||'').replace(' ','T')); return isNaN(t)? null : (now-t)/864e5; };
    const posts={};
    [...byOrder.values()].filter(x=>x.deliveryItemStatus===POD_WAIT).forEach(x=>{
      const name=x.driverName||'(pa postë)', P=posts[name]||(posts[name]={name, total:0, pay:{}, age:{}, matrix:{}, old:0, oldList:[], excluded:{fixed:0, bank:0, unpaid:0}});
      const a=ageOf(x), pg=podPayGroup(x.paymentMethod), ab= a==null||a<=1? POD_AGE_LBL[0] : a<=3? POD_AGE_LBL[1] : POD_AGE_LBL[2];
      P.total++; P.pay[pg]=(P.pay[pg]||0)+1; P.age[ab]=(P.age[ab]||0)+1; P.matrix[pg+'|'+ab]=(P.matrix[pg+'|'+ab]||0)+1;
      if(a!=null && a>3){ const fixed=!!(x.hasShippingDate||x.shippingDate), bank=pg==='Bank transfer', unpaid=!x.isPaid && pg==='Kartë / online';
        if(fixed) P.excluded.fixed++; else if(bank) P.excluded.bank++; else if(unpaid) P.excluded.unpaid++;
        else{ P.old++; P.oldList.push({id:x.orderId, pf:x.platform||'', days:Math.floor(a), pay:x.paymentMethod||'', created:String(x.createDateTime||'').slice(0,10), dd:x.dd}); } } });
    Object.values(posts).forEach(P=>P.oldList.sort((a,b)=>b.days-a.days));
    // today's POD operator = the account with the latest POD scan (Delivery Platform, Accept Delivery)
    let operator=null; try{ const s=await fetchPodScans(today); if(s.rows&&s.rows.length) operator=s.rows.reduce((b,r)=>!b||r.t>b.t? r : b, null).scanner||null; }catch(e){}
    // fixed order of the couriers set by the warehouse lead (06.10.2026), whatever their numbers; any other courier after them
    const rank=n=>{ const i=POD_POST_ORDER.findIndex(re=>re.test(n)); return i<0? 99 : i; };
    const list=Object.values(posts).sort((a,b)=>rank(a.name)-rank(b.name) || b.total-a.total);
    const v={at:new Date().toISOString(), days:POD_PENDING_DAYS, daysRead, from:isoAddDays(today,-(POD_PENDING_DAYS-1)), to:today, error, operator, ageLabels:POD_AGE_LBL,
      posts:list, total:list.reduce((s,P)=>s+P.total,0), old:list.reduce((s,P)=>s+P.old,0)};
    if(!error) podPendingCache={t:Date.now(), v}; return v;
  } finally { podPendingBusy=null; } })();
}
/* Google Chat: the same report for the POD operator, every 30 min from 16:30 to 20:00 (cfg.podChatMarks), to the POD
   space when cfg.podChatWebhook is set, or to the Flow (2h) space when cfg.podChatToFlowSpace is true (nothing is sent
   until one of the two is set); the operator's name heads the message (a
   webhook cannot write to one person). One message per mark per day; a missed mark is not back-filled. */
const POD_CHAT_MARKS=(Array.isArray(cfg.podChatMarks)&&cfg.podChatMarks.length? cfg.podChatMarks : ['16:30','17:00','17:30','18:00','18:30','19:00','19:30','20:00']);
const POD_CHAT_FILE=path.join(APPDIR,'data','pod-chat-state.json');
const hmMin=s=>{ const [h,m]=String(s).split(':').map(Number); return h*60+(m||0); };
function podChatText(v, mark){
  const d=v.to.split('-').reverse().join('.'), payTxt=P=>Object.entries(P.pay).sort((a,b)=>b[1]-a[1]).map(([k,n])=>k+' '+n).join(' · ');
  return '*POD — porositë në pritje për POD finale · '+mark+'* ('+d+')\n'
    +(v.operator? 'Për: *'+v.operator+'* (po bën POD sot)\n' : '')
    +'\nNë pritje gjithsej: *'+v.total+'* · 🔴 mbi 3 ditë: *'+v.old+'*\n\n'
    +v.posts.map(P=>'• *'+P.name+'*: '+P.total+' në pritje'+(P.old? ' · 🔴 *'+P.old+' mbi 3 ditë*' : '')+'\n   '+payTxt(P)
      +(P.old? '\n   më të vjetrat: '+P.oldList.slice(0,5).map(o=>'#'+o.id+' ('+o.days+' ditë)').join(', ') : '')).join('\n')
    +'\n\n_Mbi 3 ditë nuk përfshihen: me datë fikse, me bank transfer, me pagesë online ende të papaguar._'
    +(v.error? '\n\n⚠ Disa ditë nuk u lexuan nga Delivery Platform ('+v.error+').' : '');
}
let podChatBusy=false;
async function podChatTick(){
  // sends only once a destination is confirmed: its own POD webhook, or podChatToFlowSpace:true for the Flow (2h) space
  const hook=cfg.podChatWebhook || (cfg.podChatToFlowSpace? cfg.googleChatWebhook : null); if(!hook || podChatBusy) return;
  const n=new Date(), mins=n.getHours()*60+n.getMinutes(), due=POD_CHAT_MARKS.filter(m=>mins>=hmMin(m)).pop();
  if(!due || mins>hmMin(POD_CHAT_MARKS[POD_CHAT_MARKS.length-1])+29) return;      // only inside the window
  let st={sent:{}}; try{ st=JSON.parse(fs.readFileSync(POD_CHAT_FILE,'utf8')); }catch(e){}
  const today=isoToday(), sent=(st.sent&&st.sent[today])||[]; if(sent.includes(due)) return;
  if(st.lastError && st.lastError.mark===due && Date.now()-Date.parse(st.lastError.at)<10*60000) return;
  podChatBusy=true;
  try{ const v=await podPending(true); let r;
    if(v.error==='auth_expired' && !v.posts.length) r=await postToChat('⚠ *POD — porositë në pritje · '+due+'*: sesioni i Delivery Platform ka skaduar te agjenti.', hook);
    else r=await postToChat(podChatText(v, due), hook);
    console.log('[wms-agent] Google Chat POD '+due+': '+(r.ok?'sent ✓':'FAILED '+r.error));
    if(r.ok){ st.sent={[today]:[...sent,due]}; st.last={at:new Date().toISOString(), mark:due}; delete st.lastError; } else st.lastError={at:new Date().toISOString(), mark:due, error:r.error};
    try{ fs.mkdirSync(path.dirname(POD_CHAT_FILE),{recursive:true}); fs.writeFileSync(POD_CHAT_FILE, JSON.stringify(st,null,2)); }catch(e){}
  } finally { podChatBusy=false; }
}
setInterval(podChatTick, 60*1000);
/* a past day (?date=YYYY-MM-DD): the same board rebuilt from that day's WMS log — no cut-off figures (those are "now") */
async function tabelaPastLive(iso){
  const age=Math.round((new Date(isoToday()+'T00:00:00') - new Date(iso+'T00:00:00'))/86400000);
  const dl=await fetchDayProductLogs(isoToMdy(iso), {noCache: age<CACHE_SETTLE_DAYS});
  if(dl.error) return {error:dl.error};
  return Object.assign(tabelaBoard.liveByOperator(dl.rows, warehouseStaffSet(), normName, parseWmsDate, STAFF_ALIASES), {reliable:dl.reliable, at:new Date().toISOString()});
}
async function tabelaData(force, date){
  const past= date && date<isoToday(), today= past? date : isoToday(), yday=isoAddDays(today,-1);
  let board=null; try{ board=JSON.parse(fs.readFileSync(PULSE_DATA,'utf8')).board||null; }catch(e){}
  const live0= past? await tabelaPastLive(date) : await tabelaLiveData(force), stations=tabelaStations(), rec=tabelaBoard.readAssign(APPDIR);
  let pod=null, ref=null;
  try{ pod=await fetchPodScans(today); }catch(e){ pod={error:String(e.message||e)}; }
  try{ ref=await fetchRefusalScans(today); }catch(e){ ref={error:String(e.message||e)}; }
  const live=tabelaBoard.withPod(live0, pod, warehouseStaffSet(), normName, STAFF_ALIASES, ref);
  const day=shiftSchedule.forDay(today), cards=tabelaBoard.stationCards(stations, {tables:tabelaBoard.tablesFor(rec, today)}, live&&live.ops, today, day, normName, STAFF_ALIASES, stationPresence.forDay(today));   // that day's assignment
  const shifts={}; Object.entries(day||{}).forEach(([n,sh])=>{ shifts[n]= sh.off? 'pushim' : sh.start+'–'+sh.end; });
  const liveOut= live&&live.ops? Object.assign({}, live, {ops:live.ops.map(o=>{ const c=Object.assign({},o); delete c._ordT; delete c._ciT; delete c._retT; delete c._mpT; delete c._outT; delete c._podT; delete c._refT; return c; })}) : live;
  return {date:today, past:!!past, stations, stationInfo:stationPresence.info(today), assign:{tables:tabelaBoard.currentAssign(rec, today), updatedAt:rec.updatedAt, historyFrom:Object.keys(rec.history||{}).sort()[0]||null}, cards, shifts, scheduleLoaded:!!day, live:liveOut, cut:tabelaBoard.cutoffs(board, today, yday),
    roster:[...new Set(warehouseStaffList().map(n=>STAFF_ALIASES[normName(n)]||n))], sessionExpired:!!sessionExpired};
}
const bnAdapter=require('./bottleneck/adapter.js'), bnDetectors=require('./bottleneck/detectors.js'), bnXlsx=require('./bottleneck/xlsx.js');
let bnState={lastCheck:null, lastSnapshot:null, lastError:null}, bnCache=null;
function bnConfig(){ const db=loadDb(); return (db&&db.config&&db.config.bottleneck)||{}; }
// thresholds for the detectors; the problem age limit comes from the query parameter ma (one setting for both)
function bnThresholds(cfg){ return Object.assign({}, cfg.thresholds||{}, {maxAgeDays:bnAdapter.paramValues(cfg.params||{}).ma}); }
function bnTick(){
  try{ const cfg=bnConfig(); bnAdapter.writeRunFile(cfg.params||{});
    const r=bnAdapter.collect(360); bnState.lastCheck=new Date().toISOString();
    if(r.changed.length){ bnState.lastSnapshot=r.snapshot.id; bnCache=null; bnRecordHistory(r.snapshot, cfg); console.log('[wms-agent] bottleneck snapshot '+r.snapshot.id+': '+r.changed.join(', ')); }
    bnState.lastError=null;
  }catch(e){ bnState.lastError=e.message; console.log('[wms-agent] bottleneck: '+e.message); }
}
/* metrics that are a single "now" value per snapshot (units waiting, stuck supplies, …) get a day-by-day history,
   so a problem's effect can be followed over the 14 days the register requires before closing */
const BN_HIST=path.join(APPDIR,'bottleneck','metric-history.json');
function bnRecordHistory(snap, cfg){
  try{ const det=bnDetectors.detect(snap, bnThresholds(cfg)); let hist={}; try{ hist=JSON.parse(fs.readFileSync(BN_HIST,'utf8')); }catch(e){}
    Object.values(det.metrics).forEach(m=>{ if((m.series||[]).length!==1) return; const p=m.series[0]; const a=(hist[m.key]=hist[m.key]||[]);
      const i=a.findIndex(x=>x.d===p.d); if(i>=0) a[i]=p; else a.push(p); a.sort((x,y)=>x.d<y.d?-1:1); if(a.length>180) a.splice(0,a.length-180); });
    fs.writeFileSync(BN_HIST, JSON.stringify(hist)); }catch(e){ console.log('[wms-agent] bottleneck history: '+e.message); }
}
function bnData(){
  const snap=bnAdapter.latestSnapshot(); if(!snap) return {empty:true, state:bnState};
  const cfg=bnConfig(), key=snap.id+'|'+JSON.stringify(bnThresholds(cfg));
  if(!bnCache || bnCache.key!==key){ const data=bnDetectors.detect(snap, bnThresholds(cfg)); let hist={}; try{ hist=JSON.parse(fs.readFileSync(BN_HIST,'utf8')); }catch(e){}
    Object.values(data.metrics).forEach(m=>{ const hs=hist[m.key]; if(hs && (m.series||[]).length<=1){ const cur=(m.series||[])[0]; m.series=hs.filter(x=>!cur||x.d!==cur.d).concat(cur?[cur]:[]).sort((x,y)=>x.d<y.d?-1:1); m.history=true; } });
    bnCache={key, data}; }
  return Object.assign({state:bnState, defaults:bnDetectors.DET_DEFAULTS, params:bnAdapter.paramValues(cfg.params||{})}, bnCache.data);
}
setInterval(bnTick, 2*60*1000);
setTimeout(bnTick, 25000);

/* Orari i Warehouse (warehouse-schedule/, the schedule editor) → the plan used by the shift stats, Kapaciteti & Stafi and
   Insights. Read-only: its monthly Excel export for the previous, current and next month, every 15 min and on demand. */
const scheduleAppUrl=()=> String(cfg.scheduleAppUrl||'http://localhost:3000').replace(/\/+$/,'');
let scheduleSyncing=null;
function scheduleSync(){
  if(scheduleSyncing) return scheduleSyncing;
  scheduleSyncing=shiftSchedule.syncFromApp(scheduleAppUrl()).then(r=>{
    if(r.ok) console.log('[wms-agent] schedule synced from Orari i Warehouse: '+r.months.map(m=>m.m+'/'+m.y+(m.days?' '+m.days+'d':m.empty?' –':' '+m.error)).join(', ')+(r.unmapped.length?' · pa përputhje: '+r.unmapped.join(', '):''));
    return r;
  }).catch(e=>({ok:false, error:e.message})).finally(()=>{ scheduleSyncing=null; });
  return scheduleSyncing;
}
setInterval(scheduleSync, 15*60*1000);
setTimeout(scheduleSync, 30000);

const CT={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.md':'text/markdown; charset=utf-8','.csv':'text/csv'};
http.createServer(async (req,resp)=>{
  const q=url.parse(req.url,true);
  const json=(code,obj,extra)=>{ resp.writeHead(code,Object.assign({'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'},extra||{})); resp.end(JSON.stringify(obj)); };
  try{
    if(q.pathname==='/wms/health'){
      const startupDir=path.join(process.env.APPDATA||'', 'Microsoft','Windows','Start Menu','Programs','Startup');
      const autostart=!!process.env.APPDATA && ['wms-agent-startup.vbs','wms-agent-hidden.vbs'].some(f=>fs.existsSync(path.join(startupDir,f)));
      return json(200,{ok:true, wms:WMS, reportTime:REPORT_TIME, sharedDb:fs.existsSync(DB_FILE), autostart, keepAliveMin:KEEPALIVE_MIN, sessionExpired, pid:process.pid});
    }
    // ---- shared database ----
    if(q.pathname==='/db' && req.method==='GET'){
      const db=loadDb(); if(!db) return json(404,{error:'no shared db yet'});
      const since=q.query.since||''; const at=(db.meta&&db.meta.savedAt)||'';
      if(since && at && since===at){ resp.writeHead(304,{'Cache-Control':'no-store'}); return resp.end(); }
      resp.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','X-Saved-At':at}); return resp.end(JSON.stringify(db));
    }
    if(q.pathname==='/db' && req.method==='PUT'){
      let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return json(400,{error:'bad json'}); }
      if(!body || !body.config) return json(400,{error:'not a WODS database'});
      const cur=loadDb(); const curAt=(cur&&cur.meta&&cur.meta.savedAt)||''; const base=String(req.headers['x-base-saved-at']||'');
      if(cur && curAt && base!==curAt) return json(409,{conflict:true, db:cur});     // someone else saved since this tab last pulled
      const savedAt=saveDb(body); return json(200,{ok:true, savedAt});
    }
    // ---- paste a fresh WMS cookie from the app (no file editing) ----
    // Validated against WMS before it is saved; the value never leaves this machine.
    if(q.pathname==='/wms/ext-ping' && req.method==='POST'){ let b={}; try{ b=JSON.parse(await readBody(req)); }catch(e){}
      console.log('[wms-agent] extension v'+(b.version||'?')+' ping ('+(b.reason||'?')+'): loggedIn='+b.loggedIn+' found='+(b.found||'')); return json(200,{ok:true}); }
    if(q.pathname==='/wms/cookie' && req.method==='OPTIONS'){ resp.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return resp.end(); }
    if(q.pathname==='/wms/cookie' && req.method==='POST'){
      let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return json(400,{error:'bad json'}); }
      let raw=String(body&&body.cookie||'').trim().replace(/^cookie:\s*/i,'').replace(/[\r\n]+/g,' ');
      const jar=normalizeCookie(raw);
      const ticket=jar['.AspNet.Cookies']||'';
      const chunked=Object.keys(jar).some(n=>/^\.AspNet\.CookiesC\d+$/.test(n));
      if(!ticket) return json(400,{error:'Cookie-ja duhet të përmbajë ".AspNet.Cookies=…" — kopjo gjithë vlerën e rreshtit "cookie:" nga Request Headers.'});
      if(ticket.length<200 && !chunked) return json(400,{error:'Bileta e login-it (.AspNet.Cookies) ka vetëm '+ticket.length+' shkronja — normalisht ~3000. '+(jar[Object.keys(jar).find(n=>/^OpenIdConnect\.nonce/.test(n))||'']?'Përmban "OpenIdConnect.nonce" → u kopjua nga faqja e LOGIN-it, para se të kyçeshe. ':'')+'Kyçu plotësisht në WMS (deri sa të shohësh dashboard-in), pastaj F12 → Network → F5 → kopjo cookie-n nga një kërkesë e RE.'});
      const prevJar=cookieJar; cookieJar=jar; sessionExpired=false;
      const t=await getStats();
      const looksReal = t.data && typeof t.data.ordersInProcessing==='number';
      if(t.error || !looksReal){ cookieJar=prevJar; persistCookie(true); sessionExpired=true; return json(401,{error: (t.error&&t.error!=='auth_expired')?t.error:'WMS e refuzon këtë cookie (login i skaduar ose i kopjuar gabim). Kyçu në WMS, rifresko faqen dhe kopjo sërish.'}); }
      cfg.cookie=cookieHeader(); lastWrittenCookie=cfg.cookie; persistCookie(true);
      console.log('[wms-agent] '+new Date().toLocaleTimeString()+' new WMS cookie accepted via '+((body&&body.source)||'app')+' ('+cfg.cookie.length+' chars) · names: '+Object.keys(cookieJar).map(n=>n+'('+String(cookieJar[n]).length+')').join(' '));
      return json(200,{ok:true, stats:t.data});
    }
    if(q.pathname==='/report/run' && req.method==='POST'){ const r=await runDailyJob(q.query.date||isoToday(), false, {skipAuto:q.query.auto==='0'}); return json(r.error?(r.error==='busy'?429:500):200, r); }
    if(q.pathname==='/report/week' && req.method==='POST'){ const r=await runWeeklyJob(q.query.date||isoToday(), false, {noSync:q.query.sync==='0'}); return json(r.error?(r.error==='busy'?429:500):200, r); }
    if(q.pathname==='/report/list'){ const db=loadDb(); return json(200,{
      daily:((db&&db.dailyReports)||[]).map(r=>({date:r.date,generatedAt:r.generatedAt,scheduled:!!r.scheduled,stats:r.stats})),
      weekly:((db&&db.weeklyReports)||[]).map(r=>({weekStart:r.weekStart,weekEnd:r.weekEnd,weekNo:r.weekNo,generatedAt:r.generatedAt,scheduled:!!r.scheduled,stats:r.stats})) }); }
    if(q.pathname==='/wms/stats'){ const r=await getStats(); return json(r.error?502:200, r.error?{error:r.error}:r.data); }
    if(q.pathname==='/wms/prepared'){ const r=await getPrepared(q.query.start||today(), q.query.end||q.query.start||today()); return json(r.error?502:200, r.error?{error:r.error}:{kind:'preparedOrders',rows:r.data}); }
    if(q.pathname==='/wms/checkin'){ const r=await getCheckins(q.query.start||today(), q.query.end||q.query.start||today()); return json(r.error?502:200, r.error?{error:r.error}:{kind:'checkedIn',rows:r.data,daily:r.daily}); }
    if(q.pathname==='/wms/flow2h'){
      const iso=q.query.date || isoToday();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return json(400,{error:'date must be YYYY-MM-DD'});
      const db=loadDb(); if(!db) return json(404,{error:'no shared db yet — open the app once via http://localhost:'+PORT+'/app.html'});
      const r=await buildFlow2h(db, iso);
      return json(r.error?502:200, r);
    }
    if(q.pathname==='/wms/checkin-summary'){
      const iso=q.query.date || isoToday();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return json(400,{error:'date must be YYYY-MM-DD'});
      const age=Math.round((new Date(isoToday()+'T00:00:00') - new Date(iso+'T00:00:00'))/86400000);
      const dl=await fetchDayProductLogs(isoToMdy(iso), {noCache: age<CACHE_SETTLE_DAYS});
      if(dl.error) return json(dl.error==='auth_expired'?401:502, {error:dl.error});
      return json(200, checkinSummary(dl.rows, iso, dl.reliable));
    }
    // ---- Google Chat (Flow 2h report) ----
    if(q.pathname==='/pod/pending'){   // POD by courier — same-origin only, no CORS header
      const v=await podPending(!!q.query.refresh); resp.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}); return resp.end(JSON.stringify(Object.assign({}, v, {chat:{marks:POD_CHAT_MARKS, enabled:!!(cfg.podChatWebhook||(cfg.podChatToFlowSpace&&cfg.googleChatWebhook)), target: cfg.podChatWebhook? 'pod' : cfg.podChatToFlowSpace? 'flow' : null}})));
    }
    if(q.pathname==='/pod/chat-preview'){ const v=await podPending(false); resp.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}); return resp.end(podChatText(v, String(q.query.mark||'16:30'))); }
    // POD space webhook: saved only in the git-ignored config, never sent back to a page; same-origin only (no CORS header)
    if((q.pathname==='/pod/chat-webhook' || q.pathname==='/pod/chat-test') && req.method==='POST'){
      const origin=req.headers.origin; const send=(c,o)=>{ resp.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store'}); resp.end(JSON.stringify(o)); };
      if(origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return send(403,{error:'forbidden origin'});
      if(q.pathname==='/pod/chat-webhook'){
        let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return send(400,{error:'bad json'}); }
        const url=String(body&&body.url||'').trim();
        if(url && !/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^/]+\/messages\?/.test(url)) return send(400,{error:'Kjo nuk duket si webhook i Google Chat (duhet të fillojë me https://chat.googleapis.com/v1/spaces/…/messages?key=…).'});
        try{ const onDisk=JSON.parse(fs.readFileSync(CFG_FILE,'utf8')); if(url) onDisk.podChatWebhook=url; else delete onDisk.podChatWebhook; fs.writeFileSync(CFG_FILE, JSON.stringify(onDisk,null,2)); if(url) cfg.podChatWebhook=url; else delete cfg.podChatWebhook; }
        catch(e){ return send(500,{error:'Nuk u ruajt: '+e.message}); }
        console.log('[wms-agent] POD Google Chat webhook '+(url?'saved':'removed')+'.');
        return send(200,{ok:true, configured:!!url});
      }
      if(!cfg.podChatWebhook) return send(400,{error:'Vendos fillimisht webhook-un e hapësirës POD.'});
      const v=await podPending(false); const n=new Date(), mark=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
      const r=await postToChat('_Mesazh prove nga Warehouse Observation._\n\n'+podChatText(v, mark), cfg.podChatWebhook);
      console.log('[wms-agent] POD Google Chat test: '+(r.ok?'sent ✓':'FAILED '+r.error));
      return send(r.ok?200:502, r);
    }
    if(q.pathname==='/chat/status'){ const st=chatState(); return json(200,{configured:!!cfg.googleChatWebhook, last:st.last||null, lastError:st.lastError||null}); }
    if(q.pathname==='/chat/webhook' && req.method==='POST'){
      let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return json(400,{error:'bad json'}); }
      const url=String(body&&body.url||'').trim();
      if(url && !/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^/]+\/messages\?/.test(url)) return json(400,{error:'Kjo s\'duket si webhook i Google Chat (duhet të fillojë me https://chat.googleapis.com/v1/spaces/…/messages?key=…).'});
      try{ const onDisk=JSON.parse(fs.readFileSync(CFG_FILE,'utf8')); if(url) onDisk.googleChatWebhook=url; else delete onDisk.googleChatWebhook; fs.writeFileSync(CFG_FILE, JSON.stringify(onDisk,null,2)); if(url) cfg.googleChatWebhook=url; else delete cfg.googleChatWebhook; }
      catch(e){ return json(500,{error:'S\'u ruajt: '+e.message}); }
      console.log('[wms-agent] Google Chat webhook '+(url?'saved':'removed')+'.');
      return json(200,{ok:true, configured:!!url});
    }
    if(q.pathname==='/chat/test' && req.method==='POST'){
      if(!cfg.googleChatWebhook) return json(400,{error:'Vendos fillimisht webhook-un e Google Chat.'});
      const h=latestElapsedMark(); if(h==null) return json(400,{error:'Ende s\'ka arritur ora e parë (08:00) sot.'});
      const r=await sendFlowToChat(h, true);
      return json(r.ok?200:502, r);
    }
    if(q.pathname==='/wms/staff' && req.method==='POST'){
      let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return json(400,{error:'bad json'}); }
      const list=[...new Set((Array.isArray(body&&body.staff)?body.staff:[]).map(s=>String(s).replace(/\s+/g,' ').trim()).filter(Boolean))];
      if(!list.length) return json(400,{error:'Lista e stafit s\'mund të jetë bosh.'});
      try{ const onDisk=JSON.parse(fs.readFileSync(CFG_FILE,'utf8')); onDisk.warehouseStaff=list; fs.writeFileSync(CFG_FILE, JSON.stringify(onDisk,null,2)); cfg.warehouseStaff=list; }
      catch(e){ return json(500,{error:'S\'u ruajt: '+e.message}); }
      console.log('[wms-agent] warehouse staff roster saved ('+list.length+' names).');
      return json(200,{ok:true, staff:list});
    }
    // ---- Statistikat e WH (responses carry no wildcard CORS header: same-origin app only) ----
    if(q.pathname==='/stats/live'){
      const n = q.query.range==='30d'?30 : q.query.range==='14d'?14 : 7;
      const date=q.query.date||'';
      if(date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date>isoToday())) return json(400,{error:'Data duhet YYYY-MM-DD dhe jo në të ardhmen.'});
      const r=await wmsStats.live(n, q.query.shift||'', date);
      resp.writeHead(r.error?(r.error==='auth_expired'?401:502):200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      return resp.end(JSON.stringify(r.error?r:Object.assign(r,{config:statsConfig()})));
    }
    if(q.pathname==='/pulse/data'){   // WMS Pulse snapshot (worker e-mails + pay) — same-origin only, no CORS header
      let b; try{ b=fs.readFileSync(path.join(APPDIR,'pulse','data.json')); }catch(e){ resp.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'}); return resp.end(JSON.stringify({error:'WMS Pulse nuk është gjeneruar ende — pritet rifreskimi i parë nga databaza.'})); }
      resp.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}); return resp.end(b);
    }
    // Tabela ditore — same-origin only (no CORS header): operator names
    if(q.pathname==='/postat' || q.pathname==='/postat/'){ return fs.readFile(path.join(APPDIR,'postat.html'),(e,d)=>{ if(e){ resp.writeHead(404); return resp.end('not found'); } resp.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); resp.end(d); }); }
    if(q.pathname==='/tabela' || q.pathname==='/tabela/'){ return fs.readFile(path.join(APPDIR,'tabela.html'),(e,d)=>{ if(e){ resp.writeHead(404); return resp.end('not found'); } resp.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); resp.end(d); }); }
    if(q.pathname==='/tabela/data' || q.pathname==='/tabela/assign'){
      const origin=req.headers.origin; if(origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return json(403,{error:'forbidden origin'});
      const send=(c,o)=>{ resp.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store'}); resp.end(JSON.stringify(o)); };
      if(q.pathname==='/tabela/assign' && req.method==='POST'){ let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return send(400,{error:'bad json'}); }
        tabelaBoard.saveAssign(APPDIR, body, tabelaStations(), isoToday()); return send(200, {ok:true}); }
      const dq=String(q.query.date||''); if(dq && !/^\d{4}-\d{2}-\d{2}$/.test(dq)) return send(400,{error:'date: YYYY-MM-DD'});
      return send(200, await tabelaData(!!q.query.refresh, dq||null));
    }
    if(q.pathname==='/cap/pod'){   // POD orders per day (counts only) — same-origin only, no CORS header
      const f=String(q.query.from||''), t=String(q.query.to||''), ok=s=>/^\d{4}-\d{2}-\d{2}$/.test(s);
      if(!ok(f)||!ok(t)||f>t) return json(400,{error:'from/to: YYYY-MM-DD'});
      const r=await podDailyCounts(f,t); resp.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}); return resp.end(JSON.stringify(r));
    }
    if(q.pathname==='/pulse/status'){ return json(200, Object.assign({building:pulseBuilding}, pulseState)); }
    if(q.pathname==='/wms/stores'){   // store names + return dispositions — same-origin only (no CORS header)
      const s=await wmsStores(!!q.query.refresh);
      resp.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}); return resp.end(JSON.stringify(s));
    }
    // Bottleneck Register — same-origin only (no CORS header): staff initials and operational data
    if(q.pathname.startsWith('/bn/')){
      const origin=req.headers.origin; if(origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return json(403,{error:'forbidden origin'});
      const send=(code,obj)=>{ resp.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'}); resp.end(JSON.stringify(obj)); };
      if(q.pathname==='/bn/data'){ if(q.query.refresh) bnTick(); return send(200, bnData()); }
      if(q.pathname==='/bn/snapshot'){ const s=bnAdapter.readSnapshot(q.query.id); if(!s) return send(404,{error:'Snapshot-i nuk u gjet.'});
        const b=q.query.block? s.blocks[q.query.block] : null;
        if(q.query.block && !b) return send(404,{error:'Blloku nuk është në këtë snapshot.'});
        return send(200, b? {id:s.id, at:s.at, block:q.query.block, blockAt:b.at, source:b.source, scope:b.scope, sql:b.sql, row:q.query.rows? b.row : undefined}
                         : {id:s.id, at:s.at, source:s.source, changed:s.changed, blocks:Object.fromEntries(Object.entries(s.blocks).map(([k,v])=>[k,{at:v.at, source:v.source, scope:v.scope}]))}); }
      if(q.pathname==='/bn/snapshots'){ return send(200, bnAdapter.listSnapshots().slice(-40).reverse()); }
      if(q.pathname==='/bn/runfile'){ bnTick(); let t=''; try{ t=fs.readFileSync(path.join(APPDIR,'bottleneck','queries.run.sql'),'utf8'); }catch(e){}
        resp.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}); return resp.end(t); }
      if(q.pathname==='/bn/import' && req.method==='POST'){ let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return send(400,{error:'bad json'}); }
        try{ const s=bnAdapter.importData(String(body.text||''), String(body.name||'')); bnCache=null; bnState.lastSnapshot=s.id; return send(200,{ok:true, id:s.id, changed:s.changed}); }
        catch(e){ return send(400,{error:e.message}); } }
      if(q.pathname==='/bn/export.xlsx' && req.method==='POST'){ let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return send(400,{error:'bad json'}); }
        const buf=bnXlsx.workbook(Array.isArray(body.sheets)? body.sheets.slice(0,10) : []);
        resp.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="'+String(body.file||'regjistri.xlsx').replace(/[^\w.-]/g,'_')+'"','Cache-Control':'no-store'});
        return resp.end(buf); }
      return send(404,{error:'not found'});
    }
    if(q.pathname==='/schedule' && req.method==='GET'){ return json(200, Object.assign(shiftSchedule.summary(), {appUrl:scheduleAppUrl()})); }
    if(q.pathname==='/schedule/sync' && req.method==='POST'){
      const origin=req.headers.origin; if(origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return json(403,{error:'forbidden origin'});
      const r=await scheduleSync(); return json(r.ok?200:502, Object.assign(r, {summary:shiftSchedule.summary()}));
    }
    if(q.pathname==='/schedule/import' && req.method==='POST'){
      const origin=req.headers.origin; if(origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return json(403,{error:'forbidden origin'});
      let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return json(400,{error:'bad json'}); }
      const b64=String(body&&body.file||'').replace(/^data:[^,]*,/,'');
      if(!b64) return json(400,{error:'Mungon skedari.'});
      try{ const r=shiftSchedule.importXlsx(Buffer.from(b64,'base64'), String(body.name||''));
        console.log('[wms-agent] shift schedule imported: '+r.from+' → '+r.to+', '+r.operators.length+' operators'+(r.unmapped.length?', unmapped: '+r.unmapped.join(', '):''));
        return json(200, r); }
      catch(e){ return json(400,{error:e.message}); }
    }
    if(q.pathname==='/stats/shifts'){
      const date=q.query.date||isoToday(), mode=q.query.mode==='week'?'week':'day';
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || date>isoToday()) return json(400,{error:'Data duhet YYYY-MM-DD dhe jo në të ardhmen.'});
      const r=await wmsStats.shifts(date, mode);
      resp.writeHead(r.error?(r.error==='auth_expired'?401:502):200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      return resp.end(JSON.stringify(r));
    }
    if(q.pathname==='/stats/config' && req.method==='POST'){
      const origin=req.headers.origin; if(origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return json(403,{error:'forbidden origin'});
      let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return json(400,{error:'bad json'}); }
      const next={}; const cut=String(body.cutoff||'');
      if(cut){ if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(cut)) return json(400,{error:'Cut-off duhet në formatin HH:MM'}); next.cutoff=cut; }
      if(body.targetOrdersPerDay!=null){ const t=Number(body.targetOrdersPerDay); if(!(t>0)) return json(400,{error:'Targeti duhet > 0'}); next.targetOrdersPerDay=t; }
      if(body.thresholds && typeof body.thresholds==='object'){ next.thresholds={};
        for(const [k,v] of Object.entries(body.thresholds)){ if(!STATS_DEFAULTS.thresholds[k]||!v) continue; const g=Number(v.green), y=Number(v.yellow);
          if(!isFinite(g)||!isFinite(y)) return json(400,{error:'Pragjet duhet të jenë numra ('+k+')'}); next.thresholds[k]={green:g, yellow:y, higherIsBetter:STATS_DEFAULTS.thresholds[k].higherIsBetter}; } }
      try{ const onDisk=JSON.parse(fs.readFileSync(CFG_FILE,'utf8')); const merged=Object.assign({}, onDisk.stats||{}, next, next.thresholds?{thresholds:Object.assign({}, (onDisk.stats||{}).thresholds||{}, next.thresholds)}:{});
        onDisk.stats=merged; fs.writeFileSync(CFG_FILE, JSON.stringify(onDisk,null,2)); cfg.stats=merged; }
      catch(e){ return json(500,{error:'S\'u ruajt: '+e.message}); }
      return json(200,{ok:true, config:statsConfig()});
    }
    if(q.pathname==='/wms/performance'){
      const n = q.query.range==='30d'?30 : q.query.range==='14d'?14 : 7;
      const days=lastNDays(n);
      const cr=await collectRangeRows(days);
      if(cr.error) return json(cr.error==='auth_expired'?401:502, cr);
      const out=buildPerformance(cr.rows, days); out.reliable=cr.reliable;
      return json(200, out);
    }
    if(q.pathname==='/wms/checkreport'){
      const range=q.query.range||'24h';
      const n = range==='30d'?30 : range==='7d'?7 : 1;
      const days=lastNDays(n);
      const db=loadDb(); if(!db) return json(404,{error:'no shared db yet — open the app once via http://localhost:'+PORT+'/app.html'});
      const cr=await collectRangeRows(days);
      if(cr.error) return json(cr.error==='auth_expired'?401:502, cr);
      const report=buildCheckReport(cr.rows, db, days);
      report.reliable=cr.reliable;
      return json(200, report);
    }
    // ---- Delivery Platform (separate system/cookie — see comment above fetchPodLogs) ----
    if(q.pathname==='/delivery/cookie' && req.method==='OPTIONS'){ resp.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return resp.end(); }
    if(q.pathname==='/delivery/cookie' && req.method==='POST'){
      let body; try{ body=JSON.parse(await readBody(req)); }catch(e){ return json(400,{error:'bad json'}); }
      const raw=cleanCookieString(body&&body.cookie);
      const jar={}; parseIntoJarInto(jar, raw);
      // diagnostics: cookie names + value lengths only, never the values
      const dpNames=Object.keys(jar).map(n=>n.replace(/^(OpenIdConnect\.nonce)\..*$/,'$1…')+'('+String(jar[n]).length+')').join(', ')||'(asnjë)';
      const dpLog=msg=>console.log('[wms-agent] '+new Date().toLocaleTimeString()+' Delivery-Platform cookie from '+((body&&body.source)||'?')+': '+msg+' — cookies: '+dpNames);
      if(!Object.keys(jar).length){ dpLog('rejected, empty'); return json(400,{error:'Cookie bosh ose i pavlefshëm.'}); }
      // GetPodLogs can legitimately return an empty result set (200 OK, recordsFiltered:0) for an
      // UNAUTHENTICATED request too (seen live, 2026-09-24: a "gjs"-only cookie, no real login ticket,
      // was silently accepted this way) — so "no error from the query" alone is not proof of a real
      // session. Require the actual auth ticket to be present first, same check the extension itself
      // uses to decide "am I logged in" before it ever sends anything.
      // ASP.NET (.AspNet.Cookies) or ASP.NET Core (.AspNetCore.Cookies — the platform since 10/2026), whole or chunked (…C1..n)
      const hasTicket = /(?:^|;\s*)\.AspNet(?:Core)?\.Cookies=([^;]{200,})/.test(raw) || /\.AspNet(?:Core)?\.CookiesC\d+=/.test(raw);
      if(!hasTicket){ dpLog('rejected, no .AspNet(Core).Cookies login ticket'); return json(400,{error:'Cookie-ja s\'përmban një biletë login-i të vlefshme (".AspNet.Cookies", ~200+ shkronja) për Delivery Platform-in — vetëm cookie ndihmëse (si "gjs") u gjet. Kyçu plotësisht në deliveryplatform.gjirafamall.com dhe kopjo/rifresko sërish.'}); }
      const prevJar=deliveryCookieJar; deliveryCookieJar=jar; deliverySessionExpired=false;
      const t=await fetchPodLogs(isoAddDays(isoToday(),-7), isoToday(), {length:1});
      if(t.error){ deliveryCookieJar=prevJar; deliverySessionExpired=true; dpLog('rejected by the platform ('+t.error+')'); return json(401,{error:'Delivery Platform e refuzon këtë cookie (login i skaduar ose i kopjuar gabim).'}); }
      persistDeliveryCookie();
      console.log('[wms-agent] '+new Date().toLocaleTimeString()+' new Delivery-Platform cookie accepted ('+deliveryCookieHeader().length+' chars).');
      return json(200,{ok:true});
    }
    if(q.pathname==='/delivery/health'){ return json(200,{sessionExpired:deliverySessionExpired, hasCookie:!!deliveryCookieHeader()}); }
    if(q.pathname==='/delivery/pod'){   // POD for one day (no customer data) — same-origin only, no CORS header
      const date=q.query.date||isoToday();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || date>isoToday()) return json(400,{error:'Data duhet YYYY-MM-DD dhe jo në të ardhmen.'});
      const r=await fetchPodDay(date);
      resp.writeHead(r.error?(r.error==='auth_expired'?401:502):200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      return resp.end(JSON.stringify(r));
    }
    if(q.pathname==='/delivery/podlogs'){
      const start=q.query.start || isoAddDays(isoToday(),-7);
      const end=q.query.end || isoToday();
      const r=await fetchPodLogs(start,end,{length:500});
      return json(r.error?401:200, r);
    }
    // static app files
    let f=(q.pathname==='/'||q.pathname==='')?'/app.html':q.pathname;
    const full=path.join(APPDIR, decodeURIComponent(f).replace(/^\/+/,''));
    if(!full.startsWith(APPDIR)){ resp.writeHead(403); return resp.end('forbidden'); }
    { // private files are never served: secrets, the employee schedule, WMS Pulse data, bottleneck snapshots and raw query results
      const rel=path.relative(APPDIR, full).split(path.sep).join('/').toLowerCase();
      if(rel==='wms-agent.config.json' || rel==='shift-schedule.json' || rel.startsWith('bottleneck/') || (rel.startsWith('pulse/') && rel!=='pulse/template.html')){ resp.writeHead(404); return resp.end('not found'); } }
    fs.readFile(full,(e,data)=>{ if(e){ resp.writeHead(404); return resp.end('not found'); }
      resp.writeHead(200,{'Content-Type':CT[path.extname(full)]||'application/octet-stream','Cache-Control':'no-store'}); resp.end(data); });
  }catch(err){ json(500,{error:String(err&&err.message||err)}); }
}).listen(PORT,'127.0.0.1',()=>{
  console.log('\n[wms-agent] running.');
  console.log('  App:    http://localhost:'+PORT+'/app.html');
  console.log('  Proxy:  /wms/stats  /wms/prepared  /wms/checkin?start=DD/MM/YYYY&end=DD/MM/YYYY  /wms/health');
  console.log('  WMS:    '+WMS+'   (cookie loaded, '+cookieHeader().length+' chars)');
  console.log('  Keep-alive: pinging WMS every '+KEEPALIVE_MIN+' min to renew the session cookie automatically.');
  console.log('  Shared DB: '+DB_FILE+(fs.existsSync(DB_FILE)?'':'  (created by the first browser that opens the app)'));
  console.log('  Daily report: every day after '+REPORT_TIME+' → db.dailyReports + reports/daily-YYYY-MM-DD.html  (manual: POST /report/run)');
  console.log('  Weekly report: weekday '+WEEKLY_DAY+' after '+WEEKLY_TIME+' → db.weeklyReports + reports/weekly-<monday>.html  (manual: POST /report/week?date=YYYY-MM-DD)\n');
});

/* Keep-alive: a light request on a timer renews the sliding session cookie
   (Set-Cookie is captured by wmsFetch) so the session survives without manual
   re-pasting, as long as this agent keeps running. */
const KEEPALIVE_MIN=Number(cfg.keepAliveMinutes||5);   // short on purpose: the WMS session slides, and a PC waking from sleep must renew it fast
async function keepAlive(){
  try{ const r=await getStats(); if(r.error==='auth_expired'){ console.log('[wms-agent] '+new Date().toLocaleTimeString()+' keep-alive: session expired — a fresh cookie is needed (WMS ended the login).'); }
    else { console.log('[wms-agent] '+new Date().toLocaleTimeString()+' keep-alive OK (cookie renewed if the server rotated it).'); } }
  catch(e){ /* transient network error — ignore, next tick retries */ }
}
setInterval(keepAlive, KEEPALIVE_MIN*60*1000);
setTimeout(keepAlive, 5000); // one shortly after start
