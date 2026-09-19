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

/* Products checked in per operator/day.
   Source: /Warehouse/ProductLogsData (event log). Filter LogType === "Checked in".
   No date filter on the server side other than StartDate/EndDate (MM/DD/YYYY) + StoreId=0,
   so we loop one request per day (bounded volume) and group by operator. */
const CHECKIN_LOGTYPE='Checked in';
const CHECKOUT_LOGTYPE='Check out'; // main checkout action (products dispatched/shipped that day)
const PLOG_COLS=['ProductItemUniqueIdentifier','ProductCode','Sku','ProductSerialNumber','VendorName','ProductName','OrderId','LogType','Row','UpdatedByName','InsertDateTime','LastInspectDate']
  .map(d=>({data:d,name:'',searchable:true,orderable:false,search:{value:'',regex:false}}));
const PLOG_PAGE=2000;   // length>~3000 makes the server 500 on busy days, so page in safe chunks
const PLOG_MAXPAGES=15; // safety cap per day (30k events)
const checkinCache={}; // iso date -> {ops:[{operator,checkedIn}], inCount, outCount} for PAST days (immutable)
function isoToday(){ const t=new Date(); return t.getFullYear()+'-'+p2(t.getMonth()+1)+'-'+p2(t.getDate()); }
async function getCheckins(start,end){
  const s=parseDMY(start), e=parseDMY(end||start); const out=[]; const daily=[]; const tIso=isoToday();
  for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)){
    const mdy=p2(d.getMonth()+1)+'/'+p2(d.getDate())+'/'+d.getFullYear();
    const iso=d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
    // past days never change → serve from cache to avoid re-paging the whole event log
    if(iso!==tIso && checkinCache[iso]){ const c=checkinCache[iso];
      c.ops.forEach(o=>out.push({date:iso,operator:o.operator,checkedIn:o.checkedIn||0,checkedOut:o.checkedOut||0}));
      daily.push({date:iso,checkedIn:c.inCount,checkedOut:c.outCount}); continue; }
    const byIn={}, byOut={}; let inCount=0, outCount=0; let start2=0, total=Infinity, pages=0;
    while(start2<total && pages<PLOG_MAXPAGES){
      const params={draw:1,start:start2,length:PLOG_PAGE,search:{value:'',regex:false},order:[{column:10,dir:'desc'}],columns:PLOG_COLS,
        filters:{StartDate:mdy,EndDate:mdy,StoreId:0,ProductCode:'',Sku:'',ProductItemUniqueIdentifier:'',ProductSerialNumber:''}};
      const body=enc(params).join('&');
      const r=await wmsFetch('/Warehouse/ProductLogsData',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body});
      if(looksLoggedOut(r)) return {error:'auth_expired'};
      let j; try{ j=JSON.parse(r.body); }catch(e2){ return {error:'bad_response'}; }
      const rows=j.data||[]; total=Number(j.recordsFiltered)||rows.length;
      rows.forEach(x=>{
        const op=(x.UpdatedByName||'').trim()||'(pa operator)';
        if(x.LogType===CHECKIN_LOGTYPE){ inCount++; byIn[op]=(byIn[op]||0)+1; }
        else if(x.LogType===CHECKOUT_LOGTYPE){ outCount++; byOut[op]=(byOut[op]||0)+1; }
      });
      pages++; if(!rows.length) break; start2+=PLOG_PAGE;
    }
    const opsSet=new Set([...Object.keys(byIn),...Object.keys(byOut)]);
    const ops=[...opsSet].map(op=>({operator:op, checkedIn:byIn[op]||0, checkedOut:byOut[op]||0}));
    ops.forEach(o=>out.push({date:iso, operator:o.operator, checkedIn:o.checkedIn, checkedOut:o.checkedOut}));
    daily.push({date:iso, checkedIn:inCount, checkedOut:outCount});
    if(iso!==tIso) checkinCache[iso]={ops, inCount, outCount}; // cache immutable past days
  }
  return {data:out, daily};
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
    if(q.pathname==='/wms/health') return json(200,{ok:true, wms:WMS, reportTime:REPORT_TIME, sharedDb:fs.existsSync(DB_FILE)});
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
    if(q.pathname==='/report/run' && req.method==='POST'){ const r=await runDailyJob(q.query.date||isoToday(), false, {skipAuto:q.query.auto==='0'}); return json(r.error?(r.error==='busy'?429:500):200, r); }
    if(q.pathname==='/report/week' && req.method==='POST'){ const r=await runWeeklyJob(q.query.date||isoToday(), false, {noSync:q.query.sync==='0'}); return json(r.error?(r.error==='busy'?429:500):200, r); }
    if(q.pathname==='/report/list'){ const db=loadDb(); return json(200,{
      daily:((db&&db.dailyReports)||[]).map(r=>({date:r.date,generatedAt:r.generatedAt,scheduled:!!r.scheduled,stats:r.stats})),
      weekly:((db&&db.weeklyReports)||[]).map(r=>({weekStart:r.weekStart,weekEnd:r.weekEnd,weekNo:r.weekNo,generatedAt:r.generatedAt,scheduled:!!r.scheduled,stats:r.stats})) }); }
    if(q.pathname==='/wms/stats'){ const r=await getStats(); return json(r.error?502:200, r.error?{error:r.error}:r.data); }
    if(q.pathname==='/wms/prepared'){ const r=await getPrepared(q.query.start||today(), q.query.end||q.query.start||today()); return json(r.error?502:200, r.error?{error:r.error}:{kind:'preparedOrders',rows:r.data}); }
    if(q.pathname==='/wms/checkin'){ const r=await getCheckins(q.query.start||today(), q.query.end||q.query.start||today()); return json(r.error?502:200, r.error?{error:r.error}:{kind:'checkedIn',rows:r.data,daily:r.daily}); }
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
const KEEPALIVE_MIN=20;
async function keepAlive(){
  try{ const r=await getStats(); if(r.error==='auth_expired'){ console.log('[wms-agent] '+new Date().toLocaleTimeString()+' keep-alive: session expired — a fresh cookie is needed (WMS ended the login).'); }
    else { console.log('[wms-agent] '+new Date().toLocaleTimeString()+' keep-alive OK (cookie renewed if the server rotated it).'); } }
  catch(e){ /* transient network error — ignore, next tick retries */ }
}
setInterval(keepAlive, KEEPALIVE_MIN*60*1000);
setTimeout(keepAlive, 5000); // one shortly after start
