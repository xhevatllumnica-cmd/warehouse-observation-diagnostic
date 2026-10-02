/* Minimal .xlsx writer (no dependencies): sheets of plain rows → an Office Open XML workbook in a stored (uncompressed)
   zip. Numbers stay numbers, everything else is an inline string; the first row of each sheet is bold. */
'use strict';
const CRC=(()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c= c&1? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
function crc32(buf){ let c=0xFFFFFFFF; for(let i=0;i<buf.length;i++) c=CRC[(c^buf[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'');
function col(i){ let s=''; i++; while(i>0){ const m=(i-1)%26; s=String.fromCharCode(65+m)+s; i=Math.floor((i-1)/26); } return s; }

function sheetXml(rows, widths){
  const cols= widths&&widths.length? '<cols>'+widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')+'</cols>' : '';
  const body=rows.map((r,ri)=>'<row r="'+(ri+1)+'">'+r.map((v,ci)=>{ const ref=col(ci)+(ri+1), st= ri===0? ' s="1"' : ' s="2"';
    if(v==null||v==='') return '';
    if(typeof v==='number' && isFinite(v)) return `<c r="${ref}"${ri===0?' s="1"':''}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${esc(v)}</t></is></c>`; }).join('')+'</row>').join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+cols+'<sheetData>'+body+'</sheetData></worksheet>';
}
function zip(files){
  const parts=[], central=[]; let off=0;
  files.forEach(f=>{ const name=Buffer.from(f.name,'utf8'), data=Buffer.isBuffer(f.data)? f.data : Buffer.from(f.data,'utf8'), crc=crc32(data);
    const h=Buffer.alloc(30); h.writeUInt32LE(0x04034b50,0); h.writeUInt16LE(20,4); h.writeUInt16LE(0x0800,6); h.writeUInt16LE(0,8); h.writeUInt32LE(0,10);
    h.writeUInt32LE(crc,14); h.writeUInt32LE(data.length,18); h.writeUInt32LE(data.length,22); h.writeUInt16LE(name.length,26); h.writeUInt16LE(0,28);
    parts.push(h,name,data);
    const c=Buffer.alloc(46); c.writeUInt32LE(0x02014b50,0); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x0800,8); c.writeUInt16LE(0,10); c.writeUInt32LE(0,12);
    c.writeUInt32LE(crc,16); c.writeUInt32LE(data.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(name.length,28); c.writeUInt32LE(off,42);
    central.push(c,name); off+=30+name.length+data.length; });
  const cd=Buffer.concat(central), e=Buffer.alloc(22); e.writeUInt32LE(0x06054b50,0); e.writeUInt16LE(files.length,8); e.writeUInt16LE(files.length,10);
  e.writeUInt32LE(cd.length,12); e.writeUInt32LE(off,16);
  return Buffer.concat([...parts, cd, e]);
}
/* sheets: [{name, rows:[[...]], widths:[...]}] */
function workbook(sheets){
  const safe=sheets.map((s,i)=>({...s, name:String(s.name||('Fleta '+(i+1))).replace(/[\\/?*[\]:]/g,' ').slice(0,31)}));
  const files=[
    {name:'[Content_Types].xml', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+safe.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>'},
    {name:'_rels/.rels', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
    {name:'xl/workbook.xml', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+safe.map((s,i)=>`<sheet name="${esc(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')+'</sheets></workbook>'},
    {name:'xl/_rels/workbook.xml.rels', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+safe.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')+`<Relationship Id="rId${safe.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name:'xl/styles.xml', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>'},
    ...safe.map((s,i)=>({name:`xl/worksheets/sheet${i+1}.xml`, data:sheetXml(s.rows||[], s.widths)}))
  ];
  return zip(files);
}
module.exports={ workbook };
