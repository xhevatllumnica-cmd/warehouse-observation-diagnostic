/* Lexues pa varësi të jashtme për skedarët e Excel-it që përdor depo — vetëm lexim.
   readWorkbook(file) → {format, sheets:[{name, rows:[[vlera…]…], merges, note}]}
     · .xlsx (Office Open XML): ZIP i lexuar me zlib (inflateRaw), sharedStrings, stilet (për të njohur datat) dhe fletët;
     · XML Spreadsheet 2003 (.xls që WMS-i e eksporton si XML): <Worksheet>/<Table>/<Row>/<Cell>/<Data>, me ss:Index.
   Vlerat: numër, tekst, true/false, ose datë si 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM' kur qeliza ka format date. Qelizat bosh = null. */
const fs=require('fs'), zlib=require('zlib');

const ent=s=>String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(m,e)=>{ const k=e.toLowerCase();
  if(k[0]==='#') return String.fromCodePoint(k[1]==='x'? parseInt(k.slice(2),16) : parseInt(k.slice(1),10));
  return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[k]; });
const attr=(tag,name)=>{ const m=new RegExp('(?:^|\\s)'+name+'="([^"]*)"').exec(tag); return m? ent(m[1]) : null; };

// ---------------------------------------------------------------- ZIP
function unzip(buf){
  let eocd=-1; for(let i=buf.length-22; i>=Math.max(0,buf.length-65557); i--){ if(buf.readUInt32LE(i)===0x06054b50){ eocd=i; break; } }
  if(eocd<0) throw new Error('ZIP pa direktori qendror');
  const n=buf.readUInt16LE(eocd+10), cdOff=buf.readUInt32LE(eocd+16), files={};
  for(let p=cdOff, k=0; k<n; k++){
    if(buf.readUInt32LE(p)!==0x02014b50) throw new Error('ZIP: hyrje e dëmtuar');
    const method=buf.readUInt16LE(p+10), csize=buf.readUInt32LE(p+20), nlen=buf.readUInt16LE(p+28), xlen=buf.readUInt16LE(p+30), clen=buf.readUInt16LE(p+32), lo=buf.readUInt32LE(p+42);
    const name=buf.toString('utf8', p+46, p+46+nlen);
    const lnlen=buf.readUInt16LE(lo+26), lxlen=buf.readUInt16LE(lo+28), data=buf.subarray(lo+30+lnlen+lxlen, lo+30+lnlen+lxlen+csize);
    files[name]= method===0? data : method===8? zlib.inflateRawSync(data) : null;
    p+=46+nlen+xlen+clen; }
  return files;
}

// ---------------------------------------------------------------- datat (seriali i Excel-it, sistemi 1900)
const DATE_IDS=new Set([14,15,16,17,18,19,20,21,22,27,30,36,45,46,47,50,57]);
function serialToIso(v, withTime){ const ms=Math.round((v-25569)*864e5), d=new Date(ms); if(isNaN(d)) return v;
  const iso=d.toISOString(); return withTime && (v%1)!==0? iso.slice(0,10)+' '+iso.slice(11,16) : iso.slice(0,10); }

// ---------------------------------------------------------------- .xlsx
function readXlsx(file){
  const z=unzip(fs.readFileSync(file)), txt=n=>z[n]? z[n].toString('utf8') : null;
  const ss=[]; const sst=txt('xl/sharedStrings.xml');
  if(sst) (sst.match(/<si>[\s\S]*?<\/si>/g)||[]).forEach(si=>ss.push(ent((si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)||[]).map(t=>t.replace(/<t(?:\s[^>]*)?>|<\/t>/g,'')).join(''))));
  // stilet: cellXfs → numFmtId; formatet e personalizuara me d/m/y/h janë data
  const styles=txt('xl/styles.xml')||'', custom={};
  (styles.match(/<numFmt\s[^>]*\/>/g)||[]).forEach(t=>{ custom[+attr(t,'numFmtId')]=attr(t,'formatCode')||''; });
  const xfsBlock=(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)||[])[1]||'';
  const xfDate=(xfsBlock.match(/<xf\s[^>]*?(?:\/>|>)/g)||[]).map(t=>{ const id=+attr(t,'numFmtId'); const fc=custom[id];
    return DATE_IDS.has(id) || (fc!=null && /[dmyh]/i.test(fc.replace(/"[^"]*"|\[[^\]]*\]/g,'')) && !/^General$/i.test(fc)); });
  const wb=txt('xl/workbook.xml')||'', rels=txt('xl/_rels/workbook.xml.rels')||'', relT={};
  (rels.match(/<Relationship\s[^>]*\/>/g)||[]).forEach(t=>{ relT[attr(t,'Id')]=attr(t,'Target'); });
  const sheets=(wb.match(/<sheet\s[^>]*\/>/g)||[]).map(t=>{ const name=attr(t,'name'), rid=attr(t,'r:id'); let target=relT[rid]||'';
    target=target.replace(/^\/?xl\//,''); const xml=txt('xl/'+target.replace(/^\//,''))||'';
    const rows=[]; (xml.match(/<row[\s>][\s\S]*?<\/row>|<row\s[^>]*\/>/g)||[]).forEach(rx=>{ const rn=+attr(rx.slice(0,rx.indexOf('>')+1),'r'); const row=[];
      (rx.match(/<c\s[^>]*\/>|<c\s[^>]*>[\s\S]*?<\/c>/g)||[]).forEach(cx=>{ const head=cx.slice(0,cx.indexOf('>')+1), ref=attr(head,'r'), t=attr(head,'t'), s=+(attr(head,'s')||0);
        let col=0; for(const ch of (ref||'').replace(/\d+/g,'')) col=col*26+(ch.charCodeAt(0)-64); col-=1;
        const vRaw=(/<v>([\s\S]*?)<\/v>/.exec(cx)||[])[1], isT=(/<is>([\s\S]*?)<\/is>/.exec(cx)||[])[1];
        let v=null;
        if(t==='s') v= vRaw!=null? ss[+vRaw] : null; else if(t==='inlineStr') v=ent((isT||'').replace(/<[^>]+>/g,'')); else if(t==='str') v= vRaw!=null? ent(vRaw) : null;
        else if(t==='b') v= vRaw==='1'; else if(vRaw!=null){ const num=+vRaw; v= xfDate[s]? serialToIso(num, true) : num; }
        if(typeof v==='string' && v.trim()==='') v=null;
        if(col>=0) row[col]=v; });
      rows[(rn||rows.length+1)-1]=row; });
    for(let i=0;i<rows.length;i++) if(!rows[i]) rows[i]=[];
    const merges=(xml.match(/<mergeCell\s[^>]*\/>/g)||[]).length;
    return {name, rows:rows.map(r=>Array.from(r, x=>x===undefined? null : x)), merges}; });
  return {format:'xlsx', sheets};
}

// ---------------------------------------------------------------- XML Spreadsheet 2003
function readSpreadsheetML(file){
  const x=fs.readFileSync(file,'utf8').replace(/^﻿/,'');
  const sheets=(x.match(/<Worksheet\s[^>]*>[\s\S]*?<\/Worksheet>/g)||[]).map(ws=>{ const name=attr(ws.slice(0,ws.indexOf('>')+1),'ss:Name');
    const rows=[]; let r=0;
    (ws.match(/<Row(?:\s[^>]*)?\/>|<Row(?:\s[^>]*)?>[\s\S]*?<\/Row>/g)||[]).forEach(rx=>{ const head=rx.slice(0,rx.indexOf('>')+1), ri=attr(head,'ss:Index'); r= ri? +ri : r+1;
      const row=[]; let c=0;
      (rx.match(/<Cell(?:\s[^>]*)?\/>|<Cell(?:\s[^>]*)?>[\s\S]*?<\/Cell>/g)||[]).forEach(cx=>{ const ch=cx.slice(0,cx.indexOf('>')+1), ci=attr(ch,'ss:Index'); c= ci? +ci : c+1;
        const dm=/<Data\s([^>]*)>([\s\S]*?)<\/Data>/.exec(cx); let v=null;
        if(dm){ const type=attr(' '+dm[1],'ss:Type'), raw=ent(dm[2].replace(/<[^>]+>/g,''));
          v= type==='Number'? +raw : type==='Boolean'? raw==='1' : type==='DateTime'? raw.replace('T',' ').replace(/:00(\.000)?$/,'').replace(/ 00:00$/,'') : raw; if(typeof v==='string' && v.trim()==='') v=null; }
        row[c-1]=v; const ma=attr(ch,'ss:MergeAcross'); if(ma) c+= +ma; });
      rows[r-1]=Array.from(row, z=>z===undefined? null : z); });
    for(let i=0;i<rows.length;i++) if(!rows[i]) rows[i]=[];
    return {name, rows, merges:(ws.match(/ss:MergeAcross=|ss:MergeDown=/g)||[]).length}; });
  return {format:'spreadsheetml', sheets};
}

function readWorkbook(file){
  const head=fs.readFileSync(file).subarray(0,8);
  if(head[0]===0x50 && head[1]===0x4b) return readXlsx(file);
  const s=head.toString('utf8').replace(/^﻿/,''); if(s.startsWith('<?xml') || s.startsWith('<Work')) return readSpreadsheetML(file);
  throw new Error('Format i panjohur: '+file);
}
module.exports={readWorkbook};
