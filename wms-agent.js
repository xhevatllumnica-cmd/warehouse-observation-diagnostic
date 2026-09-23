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

/* --- cookie jar with auto-renewal ---------------------------------------
   WMS uses ASP.NET cookie auth with SLIDING expiration: each request renews
   the session and the server returns a fresh Set-Cookie. We keep a jar,
   apply every Set-Cookie, persist it back to config.json, and ping the WMS
   on a timer — so the session stays alive without re-pasting the cookie,
   as long as the agent keeps running. (No auth is bypassed: this is exactly
   how a browser keeps its own session alive.) */
let cookieJar={};
function parseIntoJar(str){ (str||'').split(/;\s*/).forEach(p=>{ const i=p.indexOf('='); if(i>0){ const n=p.slice(0,i).trim(); if(n) cookieJar[n]=p.slice(i+1); } }); }
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
function normalizeCookie(str){ const j={}; String(str||'').split(/;\s*/).forEach(p=>{ const i=p.indexOf('='); if(i>0){ const n=p.slice(0,i).trim(); if(n) j[n]=p.slice(i+1); } }); return j; }
function jarHeader(j){ return Object.keys(j).map(n=>n+'='+j[n]).join('; '); }
/* Load a cookie the user pasted into the config file (replaces the jar, resets the expired flag). */
function adoptExternalCookie(fresh){
  cookieJar=normalizeCookie(fresh.cookie); Object.assign(cfg, fresh); lastWrittenCookie=fresh.cookie; sessionExpired=false;
  console.log('[wms-agent] '+new Date().toLocaleTimeString()+' config changed — new WMS cookie loaded ('+cookieHeader().length+' chars), no restart needed.');
}
/* Persist the rotated jar — but NEVER over a cookie someone else wrote into the file, and never while the
   session is known to be expired (an expired jar must not clobber the fresh cookie the user is about to paste). */
function persistCookie(force){
  const now=Date.now(); if(!force && now-lastPersist<8000) return; if(sessionExpired) return;
  try{
    let onDisk=null; try{ onDisk=JSON.parse(fs.readFileSync(CFG_FILE,'utf8')); }catch(e){}
    if(onDisk && onDisk.cookie && onDisk.cookie!==lastWrittenCookie && jarHeader(normalizeCookie(onDisk.cookie))!==cookieHeader()){
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
    const o={ method:opts.method||'GET', headers:Object.assign({
      'Cookie':cookieHeader(), 'User-Agent':'wms-agent', 'X-Requested-With':'XMLHttpRequest',
      'Accept':'application/json, text/html'
    }, opts.headers||{}) };
    const req=https.request(u,o,r=>{ let d=''; r.setEncoding('utf8'); r.on('data',c=>d+=c); r.on('end',()=>{
      if(r.headers['set-cookie']){ if(applySetCookie(r.headers['set-cookie'])) persistCookie(); }
      res({status:r.statusCode,headers:r.headers,body:d}); }); });
    req.on('error',rej); if(opts.body) req.write(opts.body); req.end();
  });
}
function looksLoggedOut(r){ const out = r.status===302 || r.status===401 || /Account\/Log(in|On)|name="Password"|id="loginForm"/i.test(r.body||'');
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
   WMS logs the completed check-out action under TWO distinct LogType strings — "Check out"
   AND "Checked out" (confirmed 2026-09-22 by dumping the full log for several days: on a
   representative day they were 728 and 311 rows respectively). Counting only "Check out" silently
   missed 15-30% of real checkout events every day — this is what caused our daily/weekly reports to
   under-report checkout volume against the warehouse's own WhatsApp "AI Operator" flow updates.
   No date filter on the server side other than StartDate/EndDate (MM/DD/YYYY) + StoreId=0,
   so we loop one request per day (bounded volume) and group by operator. */
const CHECKIN_LOGTYPE='Checked in';
const CHECKOUT_LOGTYPES=['Check out','Checked out'];
const PLOG_COLS=['ProductItemUniqueIdentifier','ProductCode','Sku','ProductSerialNumber','VendorName','ProductName','OrderId','LogType','Row','UpdatedByName','InsertDateTime','LastInspectDate']
  .map(d=>({data:d,name:'',searchable:true,orderable:false,search:{value:'',regex:false}}));
const PLOG_PAGE=2000;   // length>~3000 makes the server 500 on busy days, so page in safe chunks
const PLOG_MAXPAGES=15; // safety cap per day (30k events)
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
   Start-offset paging on this WMS endpoint is unreliable once a day needs more than one page —
   found 2026-09-22: a fetch-all-in-one-request (length >= recordsFiltered) can disagree with the
   paged total by double digits of percent, in EITHER direction (extra duplicate rows on "today"
   while it is still being written to; missing rows on already-settled past days too — root cause
   is most likely a non-deterministic tie-break in WMS's own ORDER BY when many rows share one
   timestamp). De-duplicating rows across pages by natural key was tried and reverted: most
   "Checked in" rows carry no ProductItemUniqueIdentifier, so that key collapsed distinct rows too
   and made settled days WORSE. The fix that actually holds up: when the WHOLE day fits under
   SINGLE_FETCH_MAX, fetch it in one request (no offset involved at all → provably exact, verified
   rows.length===recordsFiltered) instead of paging. Only a day too large for that single request
   falls back to the old incremental paging, carrying its known margin of error (returned as
   reliable:false — callers should disclose it, not hide it). */
async function fetchDayProductLogs(mdy, opts){
  opts=opts||{}; if(!opts.noCache && dayLogsCache[mdy]) return dayLogsCache[mdy];
  const mk=(start,length)=>({draw:1,start,length,search:{value:'',regex:false},order:[{column:10,dir:'desc'}],columns:PLOG_COLS,
    filters:{StartDate:mdy,EndDate:mdy,StoreId:0,ProductCode:'',Sku:'',ProductItemUniqueIdentifier:'',ProductSerialNumber:''}});
  const r=await wmsFetch('/Warehouse/ProductLogsData',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:enc(mk(0,PLOG_PAGE)).join('&')});
  if(looksLoggedOut(r)) return {error:'auth_expired'};
  let j; try{ j=JSON.parse(r.body); }catch(e2){ return {error:'bad_response'}; }
  let rowsAll=j.data||[]; const total=Number(j.recordsFiltered)||rowsAll.length; let pages=1, start2=PLOG_PAGE;
  const SINGLE_FETCH_MAX=4000;   // conservative — a length of 5000-6000 tested fine on 2026-09-22, keeping margin below the length~3000 that once 500'd on a busier day
  let reliable = rowsAll.length>=total;   // page 1 already had everything
  if(!reliable && total<=SINGLE_FETCH_MAX){
    try{
      const r2=await wmsFetch('/Warehouse/ProductLogsData',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:enc(mk(0,total)).join('&')});
      if(!looksLoggedOut(r2)){ const j2=JSON.parse(r2.body); const d2=j2.data||[];
        if(d2.length===total){ rowsAll=d2; reliable=true; } }
    }catch(e3){ /* any failure (500, bad json, short read) — fall through to incremental paging below */ }
  }
  if(!reliable && rowsAll.length<total){
    // fallback: incremental paging, starting from the page-1 rows we already have — known margin of error
    while(start2<total && pages<PLOG_MAXPAGES){
      const rp=await wmsFetch('/Warehouse/ProductLogsData',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:enc(mk(start2,PLOG_PAGE)).join('&')});
      if(looksLoggedOut(rp)) return {error:'auth_expired'};
      let jp; try{ jp=JSON.parse(rp.body); }catch(e4){ return {error:'bad_response'}; }
      const rows=jp.data||[]; rowsAll=rowsAll.concat(rows);
      pages++; if(!rows.length) break; start2+=PLOG_PAGE;
    }
  }
  const out={rows:rowsAll, reliable, total};
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
   Mirrors the warehouse's own WhatsApp "AI Operator" bot: for a chosen date, shows the running
   totals at 08:00, 10:00, ... 20:00 local time, each against the same hour yesterday, plus the
   2-hour tempo. Check-in/Check-out are reconstructed EXACTLY at each mark from ProductLogs
   InsertDateTime (works for any date, past or present — see fetchDayProductLogs above). Orders
   completed (= Prepared orders) has no per-event timestamp in WMS, so it can only be shown for
   "now" on today or the day's final total on a finished day — earlier marks are honestly left null
   rather than guessed. */
const FLOW_MARKS=[8,10,12,14,16,18,20];
function parseWmsDate(s){ const m=/\/Date\((\d+)\)\//.exec(s||''); return m?Number(m[1]):null; }
function isoAddDays(iso,n){ const d=new Date(iso+'T12:00:00'); d.setDate(d.getDate()+n); return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
function isoToMdy(iso){ const [y,m,d]=iso.split('-'); return m+'/'+d+'/'+y; }
/* cumulative Checked-in / Check-out(+Checked out) counts at each local-time mark, from one day's rows */
function cumulativeByMark(rows, iso){
  const cuts=FLOW_MARKS.map(h=>new Date(iso.slice(0,4), Number(iso.slice(5,7))-1, Number(iso.slice(8,10)), h,0,0,0).getTime());
  const out=FLOW_MARKS.map(()=>({checkedIn:0, checkedOut:0}));
  rows.forEach(x=>{
    const t=parseWmsDate(x.InsertDateTime); if(t==null) return;
    const isIn=x.LogType===CHECKIN_LOGTYPE, isOut=CHECKOUT_LOGTYPES.includes(x.LogType);
    if(!isIn && !isOut) return;
    for(let i=0;i<cuts.length;i++){ if(t<=cuts[i]){ if(isIn) out[i].checkedIn++; if(isOut) out[i].checkedOut++; } }
  });
  return out;
}
async function flowDayMarks(iso, dayTotals){
  const dl=await fetchDayProductLogs(isoToMdy(iso));
  if(dl.error) return {error:dl.error};
  const marks=cumulativeByMark(dl.rows, iso);
  return {marks, reliable:dl.reliable, dayTotals};
}
async function buildFlow2h(db, iso){
  const today=isoToday(); const prevIso=isoAddDays(iso,-1);
  const prep=(date)=>(db.wmsPrepared||[]).filter(r=>r.date===date).reduce((a,r)=>a+(Number(r.preparedOrders)||0),0);
  const flowRow=(date)=>(db.wmsFlow||[]).find(f=>f.date===date);
  const [cur, prev] = await Promise.all([ flowDayMarks(iso), flowDayMarks(prevIso) ]);
  if(cur.error) return {error:cur.error};
  const nowH = iso===today ? new Date().getHours()+new Date().getMinutes()/60 : null;
  const ordersToday = prep(iso);
  const marks = FLOW_MARKS.map((h,i)=>{
    const c=cur.marks[i], p=prev.error?null:prev.marks[i];
    const pct=(now,then)=> (then!=null && then>0) ? Math.round((now-then)/then*100) : null;
    // orders: only known "as of now" (today, latest mark not yet in the future) or "final" (a day already over, last mark)
    let orders=null;
    if(iso===today){ if(h<=nowH+0.001) orders = (h===FLOW_MARKS.filter(x=>x<=nowH+0.001).pop()) ? ordersToday : null; }
    else if(h===FLOW_MARKS[FLOW_MARKS.length-1]){ orders = ordersToday; }
    return { hour:p2(h)+':00', checkedIn:c.checkedIn, checkedOut:c.checkedOut,
      checkedInPrev: p?p.checkedIn:null, checkedOutPrev: p?p.checkedOut:null,
      checkedInPct: p?pct(c.checkedIn,p.checkedIn):null, checkedOutPct: p?pct(c.checkedOut,p.checkedOut):null,
      orders, future: iso===today && h>nowH+0.001 };
  });
  const prevFlow=flowRow(prevIso);
  const prevFullDay = prevFlow ? {checkedIn:prevFlow.checkedIn, checkedOut:prevFlow.checkedOut, orders:prep(prevIso)} : null;
  return { date:iso, prevDate:prevIso, marks, prevFullDay, reliable: cur.reliable && (prev.error?true:prev.reliable),
    note:'Porositë (Prepared) shfaqen vetëm për orën aktuale (sot) ose totalin final (ditë e mbyllur) — WMS s\'i ruan me vulë kohore brenda ditës.' };
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
      if(t.error || !looksReal){ cookieJar=prevJar; sessionExpired=true; return json(401,{error: (t.error&&t.error!=='auth_expired')?t.error:'WMS e refuzon këtë cookie (login i skaduar ose i kopjuar gabim). Kyçu në WMS, rifresko faqen dhe kopjo sërish.'}); }
      cfg.cookie=cookieHeader(); lastWrittenCookie=cfg.cookie; persistCookie(true);
      console.log('[wms-agent] '+new Date().toLocaleTimeString()+' new WMS cookie accepted via app ('+cfg.cookie.length+' chars).');
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
    // static app files
    let f=(q.pathname==='/'||q.pathname==='')?'/app.html':q.pathname;
    const full=path.join(APPDIR, decodeURIComponent(f).replace(/^\/+/,''));
    if(!full.startsWith(APPDIR)){ resp.writeHead(403); return resp.end('forbidden'); }
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
