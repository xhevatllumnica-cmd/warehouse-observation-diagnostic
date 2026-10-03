/* ============================================================================
   WmsDataAdapter — the data layer of the Problem / Bottleneck Register.
   The app has no direct SQL connection: the read-only WMS queries (bottleneck/queries.sql, blocks D1–D13) run through
   the WMS DB connector of Claude Code (the scheduled "WMS Pulse" task at 07, 13 and 18, or on request). This adapter:
     1. renders bottleneck/queries.run.sql from the module's Settings (period, warehouse, platform, cut-off, thresholds)
        by rewriting the literals that carry a parameter comment, e.g. 35/*nd*\/ or '17:30'/*co*\/;
     2. collects the newest result of every block from the Claude Code transcripts (the /*bn:Dx*\/ marker), together
        with the EXACT SQL that produced it, including results saved to a file because they were large;
     3. stores them as an immutable snapshot bottleneck/snapshots/<id>.json = {id, at, source, blocks:{Dx:{at, sql,
        scope, row}}} — every number in the register points to a snapshot, so it can be reproduced;
     4. imports results from JSON/CSV with the same schema when the connector is not available.
   Snapshots hold staff initials and operational data: local only (git-ignored).
   ==========================================================================*/
'use strict';
const fs=require('fs'), path=require('path'), os=require('os');

const DIR=__dirname, SNAP=path.join(DIR,'snapshots');
const BLOCKS=['D1','D1o','D2','D3','D4','D5','D6','D7','D8','D9','D10','D11','D12','D13'];
const PARAMS={ wh:1, pf:0, nd:35, co:'17:30', mh:4, sh:24, gm:15, ma:30 };

/* Settings → parameter values (derived ones included) */
function paramValues(cfg){
  const p=Object.assign({}, PARAMS, cfg||{});
  const nd=Math.max(14, Math.min(120, parseInt(p.nd,10)||35));
  return { wh:parseInt(p.wh,10)||1, pf:[0,1,2].includes(+p.pf)? +p.pf : 0, nd, nd7:nd+7, 'nd+1':nd+1,
    co:/^\d{2}:\d{2}$/.test(p.co)? p.co : '17:30', mh:Math.max(1, +p.mh||4), sh:Math.max(1, +p.sh||24), gm:Math.max(5, +p.gm||15),
    ma:Math.max(7, Math.min(120, parseInt(p.ma,10)||30)) };
}
/* rewrite every "<literal>/*name*\/" with the configured value (numbers stay numbers, strings stay quoted) */
function renderSql(sql, cfg){
  const v=paramValues(cfg);
  return sql.replace(/('[^']*'|\d+(?:\.\d+)?)\/\*([a-z0-9+]+)\*\//g, (m, lit, name)=>{
    if(!(name in v)) return m;
    const val=v[name]; return (lit.startsWith("'")? "'"+String(val).replace(/'/g,"''")+"'" : String(val))+'/*'+name+'*/';
  });
}
/* the scope a SQL text was run with, read back from its parameter literals */
function scopeOf(sql){
  const s={}; String(sql||'').replace(/('[^']*'|\d+(?:\.\d+)?)\/\*([a-z0-9+]+)\*\//g, (m, lit, name)=>{ if(!(name in s)) s[name]= lit.startsWith("'")? lit.slice(1,-1) : +lit; return m; });
  return s;
}
function writeRunFile(cfg){
  const src=fs.readFileSync(path.join(DIR,'queries.sql'),'utf8');
  const out=renderSql(src, cfg);
  const file=path.join(DIR,'queries.run.sql');
  let prev=''; try{ prev=fs.readFileSync(file,'utf8'); }catch(e){}
  if(prev!==out) fs.writeFileSync(file, out);
  return file;
}

/* newest result per block from Claude Code transcripts modified within maxAgeMin (default 6 h) */
function fromTranscripts(maxAgeMin){
  const root=path.join(os.homedir(),'.claude','projects'), since=Date.now()-(maxAgeMin||360)*60000, found={};
  let dirs=[]; try{ dirs=fs.readdirSync(root); }catch(e){ return found; }
  for(const d of dirs){ const p=path.join(root,d); let fl; try{ fl=fs.readdirSync(p); }catch(e){ continue; }
    for(const f of fl){ if(!f.endsWith('.jsonl')) continue; const fp=path.join(p,f); let st; try{ st=fs.statSync(fp); }catch(e){ continue; }
      if(st.mtimeMs<since) continue;
      let text; try{ text=fs.readFileSync(fp,'utf8'); }catch(e){ continue; }
      if(!text.includes('/*bn:')) continue;
      const uses={};
      for(const line of text.split('\n')){ if(!line || !line.includes('"tool_')) continue; let o; try{ o=JSON.parse(line); }catch(e){ continue; }
        const c=o.message&&o.message.content; if(!Array.isArray(c)) continue;
        for(const b of c){
          if(b.type==='tool_use' && /queryWMSDb/.test(b.name||'')){ const q=(b.input&&b.input.query)||''; const m=/\/\*bn:(D\d+o?)\*\//.exec(q); if(m) uses[b.id]={g:m[1], ts:Date.parse(o.timestamp)||0, sql:q}; }
          if(b.type==='tool_result' && uses[b.tool_use_id]){
            const u=uses[b.tool_use_id]; let t=Array.isArray(b.content)? b.content.map(x=>x.text||'').join('') : String(b.content||'');
            const saved=/saved to (\S+?\.txt)/.exec(t);                       // large results are saved to a file
            if(saved){ try{ t=fs.readFileSync(saved[1],'utf8'); }catch(e){ continue; } } else if(b.is_error) continue;
            let j; try{ j=JSON.parse(t); }catch(e){ continue; }
            const row=j.rows&&j.rows[0]; if(!row) continue;
            if(!found[u.g] || found[u.g].ts<u.ts) found[u.g]={ts:u.ts, sql:u.sql, row};
          } } } } }
  return found;
}

function listSnapshots(){
  let fl=[]; try{ fl=fs.readdirSync(SNAP).filter(f=>f.endsWith('.json')).sort(); }catch(e){}
  return fl.map(f=>f.slice(0,-5));
}
function readSnapshot(id){
  if(!/^[0-9A-Za-z_-]+$/.test(String(id||''))) return null;
  try{ return JSON.parse(fs.readFileSync(path.join(SNAP,id+'.json'),'utf8')); }catch(e){ return null; }
}
function latestSnapshot(){ const l=listSnapshots(); return l.length? readSnapshot(l[l.length-1]) : null; }
function snapId(d){ const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds()); }

/* Build a new snapshot when a block has a result newer than the latest snapshot's copy of it. Blocks with no newer
   result are carried over from the previous snapshot (each block keeps its own time, SQL and scope). */
function collect(maxAgeMin){
  const found=fromTranscripts(maxAgeMin), prev=latestSnapshot();
  const blocks=Object.assign({}, prev&&prev.blocks||{});
  let changed=[];
  Object.entries(found).forEach(([g,r])=>{ const at=new Date(r.ts).toISOString();
    if(!blocks[g] || blocks[g].at<at){ blocks[g]={at, sql:r.sql, scope:scopeOf(r.sql), source:'wms', row:r.row}; changed.push(g); } });
  if(!changed.length) return {snapshot:prev, changed};
  return {snapshot:saveSnapshot(blocks, 'wms', changed), changed};
}
function saveSnapshot(blocks, source, changed){
  fs.mkdirSync(SNAP,{recursive:true});
  const now=new Date(); let id=snapId(now); if(fs.existsSync(path.join(SNAP,id+'.json'))) id+='b';
  const snap={id, at:now.toISOString(), source, changed:changed||Object.keys(blocks), blocks};
  fs.writeFileSync(path.join(SNAP,id+'.json'), JSON.stringify(snap));
  // keep the last 120 snapshots (≈ 40 days at three runs a day); older ones are only needed while a problem cites them
  const all=listSnapshots(); if(all.length>120) all.slice(0, all.length-120).forEach(x=>{ try{ fs.unlinkSync(path.join(SNAP,x+'.json')); }catch(e){} });
  return snap;
}

/* Import: JSON {blocks:{D1:{row|rows, sql?, at?}}} or {D1:{…}}, or CSV with columns block,column,value (one row per
   block column; list columns hold the JSON text exactly as the query returns it). */
function importData(text, name){
  let obj=null; const t=String(text||'').trim();
  if(t.startsWith('{')){ obj=JSON.parse(t); obj=obj.blocks||obj; }
  else {
    obj={}; const lines=t.split(/\r?\n/).filter(Boolean); const head=parseCsvLine(lines.shift()).map(s=>s.toLowerCase());
    const bi=head.indexOf('block'), ci=head.indexOf('column'), vi=head.indexOf('value');
    if(bi<0||ci<0||vi<0) throw new Error('CSV duhet të ketë kolonat block, column, value.');
    lines.forEach(l=>{ const c=parseCsvLine(l); const b=c[bi]; (obj[b]=obj[b]||{row:{}}).row[c[ci]]=c[vi]; });
  }
  const prev=latestSnapshot(), blocks=Object.assign({}, prev&&prev.blocks||{}), changed=[];
  Object.entries(obj).forEach(([g,v])=>{ if(!BLOCKS.includes(g)) return;
    const row= v.row || (Array.isArray(v.rows)? v.rows[0] : null); if(!row) return;
    const sql= v.sql || '';
    blocks[g]={at:v.at||new Date().toISOString(), sql, scope:scopeOf(sql), source:'import'+(name?': '+name:''), row}; changed.push(g); });
  if(!changed.length) throw new Error('Asnjë bllok i njohur (D1–D13) në skedar.');
  return saveSnapshot(blocks, 'import', changed);
}
function parseCsvLine(l){ const out=[]; let cur='', q=false;
  for(let i=0;i<l.length;i++){ const ch=l[i];
    if(q){ if(ch==='"'){ if(l[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=ch; }
    else if(ch==='"') q=true; else if(ch===','){ out.push(cur); cur=''; } else cur+=ch; }
  out.push(cur); return out; }

module.exports={ BLOCKS, PARAMS, paramValues, renderSql, scopeOf, writeRunFile, fromTranscripts, collect, importData, listSnapshots, readSnapshot, latestSnapshot };
