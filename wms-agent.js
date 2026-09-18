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
let lastPersist=0;
function persistCookie(force){ const now=Date.now(); if(!force && now-lastPersist<8000) return; lastPersist=now;
  try{ cfg.cookie=cookieHeader(); fs.writeFileSync(path.join(__dirname,'wms-agent.config.json'), JSON.stringify(cfg,null,2)); }catch(e){} }

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
function looksLoggedOut(r){ return r.status===302 || r.status===401 || /Account\/Log(in|On)|name="Password"|id="loginForm"/i.test(r.body||''); }
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

const CT={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.md':'text/markdown; charset=utf-8','.csv':'text/csv'};
http.createServer(async (req,resp)=>{
  const q=url.parse(req.url,true);
  const json=(code,obj)=>{ resp.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}); resp.end(JSON.stringify(obj)); };
  try{
    if(q.pathname==='/wms/health') return json(200,{ok:true, wms:WMS});
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
  console.log('  Keep-alive: pinging WMS every '+KEEPALIVE_MIN+' min to renew the session cookie automatically.\n');
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
