/* ============================================================================
   WMS through the Gjirafa50 MCP connector (the warehouse lead, 23.10.2026: "lidhja të jetë permanente dhe pa cookies";
   calling the connector from the agent is allowed). A minimal MCP client over Streamable HTTP — JSON-RPC 2.0 POSTs, the
   answer as JSON or as an SSE stream, the Mcp-Session-Id header kept between calls — with no new dependency.
   Tools used: queryWMSDb {query, maxRows} (read-only SELECT, at most 1000 rows) → {rowCount, rows}.
   The connector address (and its token, if it has one) are secrets: they live only in the agent's config file
   (wmsMcpUrl / wmsMcpToken), are never sent back to the page, never logged and never in git.
   ==========================================================================*/
'use strict';
const http=require('http'), https=require('https');

module.exports=function makeWmsMcp({cfg}){
  let sessionId=null, reqId=0, ready=false, busy=null;
  const state={ok:null, at:null, error:null, server:null, tools:null};

  /* The connector is protected by login.gjirafa.com (OAuth; checked 23.10.2026: 401 + resource_metadata → authorization server
     https://login.gjirafa.com, which supports client_credentials). With a machine client for the agent (wmsMcpClientId /
     wmsMcpClientSecret, optional wmsMcpScope) the agent asks the token endpoint for an access token itself and asks again a minute
     before it expires — no person, no cookie. A fixed token (wmsMcpToken) is used as it is. */
  let tok=null;   // {value, exp}
  function form(u, fields){
    return new Promise(res=>{ const data=new URLSearchParams(fields).toString();
      const r=https.request(u, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(data)}, timeout:30000}, resp=>{
        let d=''; resp.setEncoding('utf8'); resp.on('data',c=>{ d+=c; }); resp.on('end',()=>{ let j=null; try{ j=JSON.parse(d); }catch(e){} res({status:resp.statusCode, json:j}); }); });
      r.on('timeout',()=>r.destroy(new Error('timeout'))); r.on('error',e=>res({error:e.message})); r.write(data); r.end(); });
  }
  async function bearer(){
    if(cfg.wmsMcpToken) return {value:cfg.wmsMcpToken};
    if(!cfg.wmsMcpClientId || !cfg.wmsMcpClientSecret) return {value:null};
    if(tok && Date.now() < tok.exp-60000) return tok;
    const authz=String(cfg.wmsMcpAuthServer||'https://login.gjirafa.com').replace(/\/+$/,'');
    const fields={grant_type:'client_credentials', client_id:cfg.wmsMcpClientId, client_secret:cfg.wmsMcpClientSecret}; if(cfg.wmsMcpScope) fields.scope=cfg.wmsMcpScope;
    const r=await form(authz+'/connect/token', fields);
    if(r.error) return {error:'login.gjirafa.com: '+r.error};
    if(r.status!==200 || !r.json || !r.json.access_token) return {error:'login.gjirafa.com e refuzoi klientin ('+((r.json&&r.json.error)||('HTTP '+r.status))+')'};
    tok={value:r.json.access_token, exp:Date.now()+(Number(r.json.expires_in)||3600)*1000}; return tok;
  }

  async function post(body){
    const b=await bearer(); if(b.error) return {error:b.error};
    return new Promise(res=>{
      let u; try{ u=new URL(String(cfg.wmsMcpUrl||'')); }catch(e){ return res({error:'pa adresë të connector-it'}); }
      const data=JSON.stringify(body);
      const headers={'Content-Type':'application/json', 'Accept':'application/json, text/event-stream', 'Content-Length':Buffer.byteLength(data), 'MCP-Protocol-Version':'2025-06-18'};
      if(b.value) headers.Authorization='Bearer '+b.value;
      if(sessionId) headers['Mcp-Session-Id']=sessionId;
      const r=(u.protocol==='http:'? http : https).request(u, {method:'POST', headers, timeout:180000}, resp=>{
        let d=''; resp.setEncoding('utf8'); resp.on('data',c=>{ d+=c; }); resp.on('end',()=>{
          if(resp.headers['mcp-session-id']) sessionId=String(resp.headers['mcp-session-id']);
          res({status:resp.statusCode, ct:String(resp.headers['content-type']||''), body:d, auth:String(resp.headers['www-authenticate']||'')}); }); });
      r.on('timeout',()=>r.destroy(new Error('timeout (180 s)'))); r.on('error',e=>res({error:e.message}));
      r.write(data); r.end();
    });
  }
  // the JSON-RPC answer: a JSON body, or the "data:" lines of an SSE stream (the one carrying an id)
  function parse(r){
    if(/event-stream/i.test(r.ct)){ const msgs=r.body.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>{ try{ return JSON.parse(l.slice(5).trim()); }catch(e){ return null; } }).filter(Boolean);
      return msgs.find(m=>m.id!=null) || msgs[msgs.length-1] || null; }
    try{ return JSON.parse(r.body); }catch(e){ return null; }
  }
  async function rpc(method, params){
    const r=await post({jsonrpc:'2.0', id:++reqId, method, params}); if(r.error) return {error:r.error};
    if(r.status===401 || r.status===403){ tok=null;   // a token the connector does not accept is asked for again next time
      return {error: cfg.wmsMcpClientId||cfg.wmsMcpToken? 'connector-i nuk e pranon token-in e agjentit (HTTP '+r.status+')' : 'connector-i kërkon kyçje te login.gjirafa.com — duhet një klient (client ID + secret) për agjentin', auth:true}; }
    if(r.status===404 && sessionId){ sessionId=null; ready=false; return {error:'session', retry:true}; }
    if(r.status>=400) return {error:'HTTP '+r.status+' nga connector-i'};
    const m=parse(r); if(!m) return {error:'përgjigje e palexueshme nga connector-i'};
    if(m.error) return {error:String(m.error.message||'gabim në connector')};
    return {result:m.result||{}};
  }
  async function init(){
    sessionId=null; ready=false;
    const r=await rpc('initialize', {protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'wms-agent', version:'1.0'}}); if(r.error) return r;
    await post({jsonrpc:'2.0', method:'notifications/initialized'});
    ready=true; state.server=((r.result||{}).serverInfo||{}).name||null; return r;
  }
  async function call(name, args){
    if(!ready){ const i=await init(); if(i.error) return i; }
    let r=await rpc('tools/call', {name, arguments:args});
    if(r.retry){ const i=await init(); if(i.error) return i; r=await rpc('tools/call', {name, arguments:args}); }
    if(r.error) return r;
    const res=r.result, text=(res.content||[]).filter(c=>c && c.type==='text').map(c=>c.text).join('');
    if(res.isError) return {error:(text||'gabim në query').slice(0,300)};
    let json=null; try{ json=JSON.parse(text); }catch(e){}
    return {text, json};
  }
  /* one read-only SELECT → {rowCount, rows} or {error}; calls go one at a time (the connector is a shared service) */
  async function query(sql, maxRows){
    const run=async()=>{ const r=await call('queryWMSDb', {query:String(sql), maxRows:Math.min(1000, Math.max(1, Number(maxRows)||100))});
      if(r.error){ state.ok=false; state.error=r.error; state.at=new Date().toISOString(); return r; }
      if(!r.json || !Array.isArray(r.json.rows)) return {error:'rezultat i palexueshëm: '+String(r.text||'').slice(0,160)};
      state.ok=true; state.error=null; state.at=new Date().toISOString(); return r.json; };
    const prev=busy||Promise.resolve(); const p=prev.then(run, run); busy=p.catch(()=>{}); return p;
  }
  async function test(){
    const i=await init(); if(i.error){ Object.assign(state,{ok:false, error:i.error, at:new Date().toISOString()}); return {ok:false, error:i.error}; }
    const t=await rpc('tools/list', {}); const tools= t.error? null : ((t.result.tools||[]).map(x=>x.name)); state.tools=tools;
    const q=await query('SELECT 1 AS ok', 1);
    const ok=!q.error && q.rows && q.rows[0] && Number(q.rows[0].ok)===1;
    return {ok, server:state.server, tools, error: ok? null : (q.error||t.error||'query prove dështoi')};
  }
  return {query, test, configured:()=>!!cfg.wmsMcpUrl, status:()=>Object.assign({configured:!!cfg.wmsMcpUrl, hasToken:!!cfg.wmsMcpToken, hasClient:!!(cfg.wmsMcpClientId&&cfg.wmsMcpClientSecret)}, state)};
};
