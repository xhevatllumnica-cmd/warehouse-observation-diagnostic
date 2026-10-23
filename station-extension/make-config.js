/* Writes station-extension/config.js from the agent's config (agent address on the LAN + station key). Run on the agent PC:
   node station-extension/make-config.js [agent-ip]   — default: this PC's 10.10.1.x address. */
const fs=require('fs'), path=require('path'), os=require('os');
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'..','wms-agent.config.json'),'utf8'));
if(!cfg.stationKey){ console.error('stationKey mungon — nis agjentin njëherë që ta krijojë.'); process.exit(1); }
let ip=process.argv[2]; if(!ip) Object.values(os.networkInterfaces()).flat().forEach(a=>{ if(a.family==='IPv4' && /^10\.10\.1\./.test(a.address)) ip=a.address; });
if(!ip){ console.error('Nuk u gjet adresa 10.10.1.x e këtij PC-je — jepe si argument.'); process.exit(1); }
const port=Number(cfg.stationPort||8791);
fs.writeFileSync(path.join(__dirname,'config.js'), "const STATION_CFG={ agent:'http://"+ip+":"+port+"', key:'"+cfg.stationKey+"' };\n");
console.log('config.js u shkrua: agjenti http://'+ip+':'+port+' (çelësi nga wms-agent.config.json)');
