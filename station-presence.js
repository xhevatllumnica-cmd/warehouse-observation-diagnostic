/* Station presence — which WMS account is logged in at which warehouse table, identified by the table PC's IP address.
   The WMS cannot tell (it sees only the warehouse's public address and stores no station per scan), so each table PC
   runs the small "WMS Station" Chrome extension (station-extension/): about once a minute it reads the name of the
   account logged in to the WMS in that browser and sends it here. The table is known from the IP the report comes from
   (data/station-ips.json, from the warehouse lead's list of 05.10.2026). From the reports the agent keeps, per day and
   table, the intervals "account X logged in from … to …" (data/station-presence.json, 14 days). The board credits an
   operator's work to the table where their account was logged in at that moment.
   Listens on its own port (default 8791) on the local network — only POST /beacon and GET /hello, only from 10.10.1.x
   (or this PC), only with the station key. The rest of the app stays on 127.0.0.1. */
const fs=require('fs'), path=require('path'), http=require('http'), crypto=require('crypto');

const DEFAULT_MAP=[
  {ip:'10.10.1.148', table:'Tavolina 1', station:'CHECKOUT 1'},
  {ip:'10.10.1.239', table:'Tavolina 2', station:'CHECKOUT 2'},
  {ip:'10.10.1.193', table:'Tavolina 3', station:'CHECKOUT 3'},
  {ip:'10.10.1.211', table:'Tavolina 4', station:'CHECKOUT 4'},
  {ip:'',            table:'Tavolina 5', station:'CHECKIN & CHECKOUT', note:'jo funksionale tani · funksion i dyfishtë check-in/check-out'},
  {ip:'10.10.1.209', table:'Tavolina 6', station:'CHECKIN 1'},
  {ip:'10.10.1.241', table:'Tavolina 7', station:'CHECKIN 2'}];
const LIVE_MS=3*60000;          // a table counts as "logged in now" if it reported within 3 minutes
const GAP_MS=3*60000;           // reports further apart than this start a new interval
const KEEP_DAYS=14;

module.exports=function({appDir, cfgFile, cfg, normName, aliases}){
  const MAP_FILE=path.join(appDir,'data','station-ips.json'), PRES_FILE=path.join(appDir,'data','station-presence.json');
  const iso=ms=>{ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const canon=n=>(aliases&&aliases[normName(n)])||n;

  function stationMap(){ try{ const m=JSON.parse(fs.readFileSync(MAP_FILE,'utf8')); if(Array.isArray(m)&&m.length) return m; }catch(e){} return DEFAULT_MAP; }
  try{ if(!fs.existsSync(MAP_FILE)){ fs.mkdirSync(path.dirname(MAP_FILE),{recursive:true}); fs.writeFileSync(MAP_FILE, JSON.stringify(DEFAULT_MAP,null,2)); } }catch(e){}
  const byIp=ip=>stationMap().find(m=>m.ip && m.ip===ip);

  // the shared secret the extension sends; created once and kept in the agent's config file (never served by the app)
  function stationKey(){
    if(cfg.stationKey) return cfg.stationKey;
    const k=crypto.randomBytes(18).toString('base64url');
    try{ const onDisk=JSON.parse(fs.readFileSync(cfgFile,'utf8')); onDisk.stationKey=k; fs.writeFileSync(cfgFile, JSON.stringify(onDisk,null,2)); }catch(e){}
    cfg.stationKey=k; return k;
  }

  let pres={days:{}}; try{ pres=JSON.parse(fs.readFileSync(PRES_FILE,'utf8')); if(!pres.days) pres={days:{}}; }catch(e){}
  let saveT=null; const save=()=>{ clearTimeout(saveT); saveT=setTimeout(()=>{ try{ fs.mkdirSync(path.dirname(PRES_FILE),{recursive:true}); fs.writeFileSync(PRES_FILE, JSON.stringify(pres)); }catch(e){} }, 1500); };

  /* one report: user = the WMS account's display name, empty = nobody logged in (closes the open interval) */
  function beacon(ip, body){
    const m=byIp(ip); if(!m) return {ok:false, error:'IP '+ip+' nuk është në listën e tavolinave'};
    const now=Date.now(), day=iso(now), user=String((body&&body.user)||'').replace(/\s+/g,' ').trim().slice(0,80);
    const D=pres.days[day]||(pres.days[day]={}), list=D[ip]||(D[ip]=[]), last=list[list.length-1];
    if(!user){ if(last && !last.closed){ last.closed=true; save(); } return {ok:true, table:m.table, station:m.station, user:null}; }
    if(last && !last.closed && last.u===user && now-last.to<=GAP_MS) last.to=now;
    else{ if(last && !last.closed) last.closed=true; list.push({u:user, from:now, to:now}); }
    Object.keys(pres.days).sort().slice(0,-KEEP_DAYS).forEach(d=>delete pres.days[d]);
    save(); return {ok:true, table:m.table, station:m.station, user};
  }

  /* intervals for one day per WMS station name: [{op (roster name), a, b, live}] */
  function forDay(day){
    const D=(pres.days||{})[day]||{}, out={}, now=Date.now();
    stationMap().forEach(m=>{ if(!m.ip || !D[m.ip]) return;
      out[m.station]=D[m.ip].map(x=>({op:canon(x.u), a:x.from, b:x.to, live:!x.closed && now-x.to<=LIVE_MS})); });
    return out;
  }
  function info(day){ const D=(pres.days||{})[day]||{}, now=Date.now();
    return stationMap().map(m=>{ const l=(m.ip&&D[m.ip])||[], last=l[l.length-1];
      return {ip:m.ip, table:m.table, station:m.station, note:m.note||null, reports:l.length, lastSeen: last? new Date(last.to).toISOString() : null,
        liveUser: last && !last.closed && now-last.to<=LIVE_MS? canon(last.u) : null}; }); }

  function listen(port){
    stationKey();   // created at start, so the extension config can be generated
    const srv=http.createServer((req,res)=>{
      const ip=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
      const send=(c,o)=>{ res.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, X-Station-Key','Access-Control-Allow-Methods':'GET, POST, OPTIONS'}); res.end(JSON.stringify(o)); };
      if(!(/^10\.10\.1\.\d{1,3}$/.test(ip) || ip==='127.0.0.1')) return send(403,{error:'forbidden'});
      if(req.method==='OPTIONS') return send(204,{});
      if(req.headers['x-station-key']!==stationKey()) return send(401,{error:'çelësi i stacionit mungon ose është gabim'});
      const url=String(req.url||'').split('?')[0];
      if(url==='/hello' && req.method==='GET'){ const m=byIp(ip); return send(200,{ok:!!m, ip, table:m&&m.table, station:m&&m.station}); }
      if(url==='/beacon' && req.method==='POST'){ let b=''; req.setEncoding('utf8');
        req.on('data',c=>{ b+=c; if(b.length>2048){ req.destroy(); } });
        req.on('end',()=>{ let j={}; try{ j=JSON.parse(b||'{}'); }catch(e){ return send(400,{error:'bad json'}); } send(200, beacon(ip, j)); });
        return; }
      send(404,{error:'not found'});
    });
    srv.on('error',e=>console.log('[wms-agent] station port '+port+': '+e.message));
    srv.listen(port,'0.0.0.0',()=>console.log('[wms-agent] station reports on :'+port+' (only 10.10.1.x, with the station key)'));
    return srv;
  }
  return {stationMap, stationKey, beacon, forDay, info, listen};
};
