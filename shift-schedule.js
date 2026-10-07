/* ============================================================================
   Monthly shift schedule (planned hours per operator per day), imported from the
   lead's Excel file, e.g. "Shift Schedule.xlsx" (sheet "Shtator 2026"):
     row "Shtator 2026 | <date> | <date> …"   → a week header (dates are Excel serials)
     row "<first name> | 07:00-15:00 | OFF | Weekly OFF | 09:00-18:00 …"
   Cells outside the header's date columns (e.g. a list of allowed values) are ignored.
   First names ("Festimi", "Kaoni") are matched to the WMS staff roster by first name,
   allowing the Albanian definite ending -i. Stored in shift-schedule.json (git-ignored:
   it is employee data), keyed by date; a new import replaces the dates it contains.
   No dependencies: .xlsx is a zip of XML, read with zlib.
   ==========================================================================*/
'use strict';
const fs=require('fs'), path=require('path'), zlib=require('zlib');

function unzip(buf){
  let eocd=-1; for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--){ if(buf.readUInt32LE(i)===0x06054b50){ eocd=i; break; } }
  if(eocd<0) throw new Error('Skedari s\'është .xlsx i vlefshëm (zip).');
  const n=buf.readUInt16LE(eocd+10); let p=buf.readUInt32LE(eocd+16); const files={};
  for(let k=0;k<n;k++){
    if(buf.readUInt32LE(p)!==0x02014b50) throw new Error('Zip i dëmtuar.');
    const method=buf.readUInt16LE(p+10), csize=buf.readUInt32LE(p+20), nl=buf.readUInt16LE(p+28), el=buf.readUInt16LE(p+30), cl=buf.readUInt16LE(p+32), off=buf.readUInt32LE(p+42);
    const name=buf.slice(p+46,p+46+nl).toString('utf8');
    const lh=off, data=buf.slice(lh+30+buf.readUInt16LE(lh+26)+buf.readUInt16LE(lh+28), lh+30+buf.readUInt16LE(lh+26)+buf.readUInt16LE(lh+28)+csize);
    files[name]= method===8 ? zlib.inflateRawSync(data) : data;
    p+=46+nl+el+cl;
  }
  return files;
}
const xmlText=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
/* first worksheet → {rowNumber: {colNumber: value}} */
function sheetGrid(files){
  const ss=files['xl/sharedStrings.xml']? files['xl/sharedStrings.xml'].toString('utf8') : '';
  const strings=[...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m=>[...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t=>xmlText(t[1])).join(''));
  const sheetName=Object.keys(files).filter(f=>/^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()[0];
  if(!sheetName) throw new Error('S\'u gjet asnjë fletë në skedar.');
  const sh=files[sheetName].toString('utf8'), grid={};
  for(const m of sh.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
    const [, col, row, attrs, inner]=m; if(!inner) continue;
    const v=(inner.match(/<v>([\s\S]*?)<\/v>/)||[])[1];
    let val= /t="s"/.test(attrs) ? strings[+v] : /t="inlineStr"/.test(attrs) ? xmlText((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)||[])[1]||'') : (v!=null? xmlText(v) : null);
    if(val==null) continue;
    const c=col.split('').reduce((a,ch)=>a*26+ch.charCodeAt(0)-64,0);
    (grid[+row]=grid[+row]||{})[c]=String(val).trim();
  }
  return grid;
}
const serialToIso=n=>{ const d=new Date(Date.UTC(1899,11,30)+Math.round(Number(n))*86400000); return d.toISOString().slice(0,10); };
const pad=t=>{ const m=/^(\d{1,2}):(\d{2})$/.exec(t); return m? m[1].padStart(2,'0')+':'+m[2] : t; };

module.exports=function makeSchedule(d){
  const FILE=path.join(d.appDir,'shift-schedule.json');
  let data=null; try{ data=JSON.parse(fs.readFileSync(FILE,'utf8')); }catch(e){}

  function matchName(raw){
    const k=d.normName(raw), k2=k.endsWith('i')? k.slice(0,-1) : null;
    // a full name (as the Orari i Warehouse export writes it) matches the roster directly
    if(k.includes(' ')){ const full=d.warehouseStaffList().find(r=>d.normName(r)===k); if(full) return d.STAFF_ALIASES[d.normName(full)]||full; }
    const hits=[...new Set(d.warehouseStaffList().filter(r=>{ const f=d.normName(r).split(' ')[0]; return f===k || (k2 && f===k2); })
      .map(r=>d.STAFF_ALIASES[d.normName(r)]||r))];
    return hits.length===1? hits[0] : null;
  }
  function parse(buf){
    const grid=sheetGrid(unzip(buf)); const days={}, unmapped=new Set(), names=new Set(); let cols=null;
    Object.keys(grid).map(Number).sort((a,b)=>a-b).forEach(r=>{
      const row=grid[r], dateCols=Object.entries(row).filter(([c,v])=>Number(c)>1 && /^\d{5}(\.\d+)?$/.test(v) && Number(v)>40000);
      if(dateCols.length>=3){ cols=Object.fromEntries(dateCols.map(([c,v])=>[c, serialToIso(v)])); return; }   // a week header
      if(!cols || !row[1]) return;
      const raw=row[1]; const name=matchName(raw); if(!name){ unmapped.add(raw); return; } names.add(name);
      Object.entries(cols).forEach(([c,iso])=>{ const v=(row[c]||'').replace(/\s+/g,' ').trim(); if(!v) return;
        const m=/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/.exec(v);
        // statuses as both the lead's Excel and the Orari i Warehouse export write them; sick / annual leave = planned absence
        const slot= m? {start:pad(m[1]), end:pad(m[2])} : /off/i.test(v)? {off:true, weekly:/weekly/i.test(v)}
          : /sick|sëmur|semur/i.test(v)? {off:true, reason:'sick'} : /pushim|annual|leave|vjetor/i.test(v)? {off:true, reason:'leave'} : null;
        if(slot) (days[iso]=days[iso]||{})[name]=slot; });
    });
    const dates=Object.keys(days).sort();
    if(!dates.length) throw new Error('S\'u gjet asnjë ditë me orar në skedar (pritet rreshti "Muaji | data | data …" dhe më poshtë emrat me oraret).');
    return {days, dates, operators:[...names].sort(), unmapped:[...unmapped]};
  }
  function importXlsx(buf, fileName, source){
    const p=parse(buf);
    const merged=Object.assign({}, (data&&data.days)||{}, p.days);
    data=Object.assign({}, data||{}, {days:merged, importedAt:new Date().toISOString(), lastFile:fileName||'', lastRange:[p.dates[0], p.dates[p.dates.length-1]]});
    if(source) data.source=source;
    fs.writeFileSync(FILE, JSON.stringify(data));
    return {ok:true, from:p.dates[0], to:p.dates[p.dates.length-1], days:p.dates.length, operators:p.operators, unmapped:p.unmapped};
  }
  /* Orari i Warehouse (the schedule editor, warehouse-schedule/, normally http://localhost:3000) is the source of the
     plan when it runs: its own monthly Excel export (/api/export/excel) is read for the previous, current and next
     month and merged by date — the same parser as a manual upload. Nothing is written back to it. */
  async function syncFromApp(baseUrl){
    const now=new Date(), months=[-1,0,1].map(k=>{ const t=new Date(now.getFullYear(), now.getMonth()+k, 1); return [t.getFullYear(), t.getMonth()+1]; });
    const res={ok:true, months:[], unmapped:new Set(), at:new Date().toISOString()};
    for(const [y,m] of months){
      let r; try{ r=await fetch(baseUrl.replace(/\/+$/,'')+'/api/export/excel?year='+y+'&month='+m, {signal:AbortSignal.timeout(20000)}); }
      catch(e){ const err='Orari i Warehouse nuk përgjigjet në '+baseUrl+' ('+e.message+')'; data=Object.assign({}, data||{days:{}}, {syncError:err, syncTriedAt:res.at}); fs.writeFileSync(FILE, JSON.stringify(data)); return {ok:false, error:err}; }
      if(!r.ok){ res.months.push({y,m,error:'HTTP '+r.status}); continue; }
      try{ const out=importXlsx(Buffer.from(await r.arrayBuffer()), 'Orari i Warehouse '+m+'/'+y, 'app'); res.months.push({y,m,days:out.days}); out.unmapped.forEach(n=>res.unmapped.add(n)); }
      catch(e){ res.months.push({y,m,empty:true}); }        // a month with no schedule yet has no week rows
    }
    data=Object.assign({}, data, {lastSync:res.at, syncError:null, syncUnmapped:[...res.unmapped]}); fs.writeFileSync(FILE, JSON.stringify(data));
    return Object.assign(res, {unmapped:[...res.unmapped]});
  }
  function summary(){
    if(!data||!data.days) return {loaded:false};
    const dates=Object.keys(data.days).sort(); const ops=new Set(); dates.forEach(x=>Object.keys(data.days[x]).forEach(n=>ops.add(n)));
    const hours={}; dates.forEach(x=>Object.values(data.days[x]).forEach(s=>{ if(!s.off){ const k=s.start+'–'+s.end; hours[k]=(hours[k]||0)+1; } }));
    return {loaded:true, from:dates[0], to:dates[dates.length-1], days:dates.length, operators:ops.size, names:[...ops].sort(), slots:hours, importedAt:data.importedAt, lastFile:data.lastFile,
      source:data.source||'excel', lastSync:data.lastSync||null, syncError:data.syncError||null, syncUnmapped:data.syncUnmapped||[]};
  }
  const forDay=iso=> (data && data.days && data.days[iso]) || null;
  return {importXlsx, summary, forDay, syncFromApp, parse};
};
