/* Inspektimi i tre skedarëve të depos — skript i riprodhueshëm, vetëm lexim.
   Përdorimi:  node analysis-tools/files_inspect.js <WMS-dashboard.xls> <Warehouse Check.xlsx> <Schedule.xlsx> <dosja-dalëse>
   Lexon skedarët me analysis-tools/sheet_read.js (pa varësi të jashtme) dhe nuk shkruan asgjë te hyrjet.
   Dalja: raporti.md, anomalite.csv (të tre skedarët), profili.json, verifikimi.json, run.json dhe për secilin skedar:
     wms-dashboard_produktiviteti.csv, wms-dashboard_kontrollet.csv,
     warehouse-check_e-pastruar.csv, warehouse-check_permbledhje.csv,
     schedule_e-normalizuar.csv, schedule_permbledhje-person-muaj.csv.
   Përveç run.json, daljet janë deterministe (i njëjti input → të njëjtat bajte). */
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const {readWorkbook}=require('./sheet_read.js');
const [,, F_WMS, F_WC, F_SCH, OUT]=process.argv;
if(!F_WMS||!F_WC||!F_SCH||!OUT){ console.error('Përdorimi: node files_inspect.js <WMS-dashboard.xls> <Warehouse Check.xlsx> <Schedule.xlsx> <dosja>'); process.exit(2); }
fs.mkdirSync(OUT,{recursive:true});
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const IN={wms:F_WMS, wc:F_WC, sch:F_SCH}, inHash=Object.fromEntries(Object.entries(IN).map(([k,f])=>[k,sha(f)]));

// ---------------------------------------------------------------- ndihmës
const isNum=v=>typeof v==='number'&&isFinite(v), isDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}/.test(v);
const numText=v=>typeof v==='string'&&/^\s*-?\d+(?:[.,]\d+)?\s*$/.test(v);
const sorted=a=>a.filter(isNum).slice().sort((x,y)=>x-y);
const q=(a,p)=>{ const s=sorted(a); if(!s.length) return null; const i=(s.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo); };
const med=a=>q(a,0.5), sum=a=>a.reduce((x,y)=>x+(isNum(y)?y:0),0), mad=a=>{ const m=med(a); return m==null? null : med(a.filter(isNum).map(x=>Math.abs(x-m))); };
const r=(x,d=1)=> x==null||!isFinite(x)? null : Math.round(x*10**d)/10**d;
const dow=d=>new Date(d.slice(0,10)+'T12:00:00Z').getUTCDay();
const dayType=d=>{ const w=dow(d); return w===0? 'e diel' : w===6? 'e shtunë' : 'ditë pune'; };
const addDay=(d,n)=>{ const x=new Date(d+'T12:00:00Z'); x.setUTCDate(x.getUTCDate()+n); return x.toISOString().slice(0,10); };
const csv=(rows,cols)=>[cols.join(',')].concat(rows.map(o=>cols.map(c=>{ const v=o[c]; if(v==null) return ''; const s=String(v); return /[",\n\r]/.test(s)? '"'+s.replace(/"/g,'""')+'"' : s; }).join(','))).join('\n')+'\n';
const write=(f,s)=>fs.writeFileSync(path.join(OUT,f),s);
const A=[]; const an=(skedari,fleta,rreshti,fusha,vlera,rregulli,detaje)=>A.push({skedari,fleta,rreshti,fusha,vlera:vlera==null?'':String(vlera).replace(/\r/g,'\\r'),rregulli,detaje:detaje||''});
const V=[]; const check=(skedari,emri,ok,detaje)=>V.push({skedari,kontrolli:emri,rezultati:ok?'OK':'DËSHTOI',detaje});

/* profili i një tabele (rreshti i titujve + rreshtat e të dhënave): për kolonë tipi, bosh, të ndryshme, numra si tekst,
   hapësira në fillim/fund, karaktere kontrolli (\r \n); numrat: min, mediana, maks */
function profileTable(skedari, fleta, header, rows, firstRowNo){
  const cols=header.map((h,j)=>({j, emri:h==null? '(pa titull, kolona '+String.fromCharCode(65+j)+')' : String(h)}));
  const used=cols.filter(c=>rows.some(r=>r[c.j]!=null) || header[c.j]!=null);
  const out={fleta, rreshta:rows.length, kolona_gjithsej:header.length, kolona_me_te_dhena:used.length, kolonat:{}};
  used.forEach(c=>{ const vals=rows.map(r=>r[c.j]), filled=vals.filter(v=>v!=null), nums=filled.filter(isNum);
    const types=[...new Set(filled.map(v=>isNum(v)? 'numër' : isDate(v)? 'datë' : typeof v==='boolean'? 'po/jo' : 'tekst'))];
    const info={tipi:types.join('|')||'—', bosh:vals.length-filled.length, te_ndryshme:new Set(filled.map(String)).size,
      numra_si_tekst:filled.filter(numText).length, hapesira:filled.filter(v=>typeof v==='string'&&v!==v.trim()).length, kontroll:filled.filter(v=>typeof v==='string'&&/[\r\n\t]/.test(v)).length,
      min:nums.length? Math.min(...nums) : null, mediana:r(med(nums),2), maks:nums.length? Math.max(...nums) : null};
    out.kolonat[c.emri]=info;
    if(header[c.j]==null && filled.length) an(skedari, fleta, firstRowNo-1, c.emri, '', 'kolonë pa titull', filled.length+' vlera');
    const isId=/barcode|sku|code|invoice|fatur/i.test(c.emri);
    if(isId && types.includes('numër') && types.includes('tekst')) rows.forEach((rw,i)=>{ if(isNum(rw[c.j])) an(skedari, fleta, firstRowNo+i, c.emri, rw[c.j], 'kod i ruajtur si numër', 'kolona e kodeve ka edhe tekst; si numër humbasin zerot në fillim'); });
    if(!isId && info.numra_si_tekst && types.includes('numër')) rows.forEach((rw,i)=>{ if(numText(rw[c.j])) an(skedari, fleta, firstRowNo+i, c.emri, rw[c.j], 'numër i ruajtur si tekst', 'në të njëjtën kolonë ka edhe numra'); });
    rows.forEach((rw,i)=>{ const v=rw[c.j]; if(typeof v==='string'){ if(/[\r\n\t]/.test(v)) an(skedari, fleta, firstRowNo+i, c.emri, v.slice(0,40), 'karakter kontrolli në tekst', '\\r / \\n / tab'); else if(v!==v.trim()) an(skedari, fleta, firstRowNo+i, c.emri, v, 'hapësirë në fillim/fund', ''); } }); });
  const unusedFormatted=header.length-used.length; if(unusedFormatted>0) out.kolona_bosh_ne_fund=unusedFormatted;
  return out;
}
/* seritë ditore: brenda të njëjtit lloj dite, z robust > 4 = shumë e lartë; ditë pune < 25% e medianës = shumë e ulët */
function outliers(skedari, fleta, rows, dateOf, valOf, fusha){
  ['ditë pune','e shtunë','e diel'].forEach(tp=>{ const g=rows.filter(o=>dayType(dateOf(o))===tp), vals=g.map(valOf), m=med(vals), s=mad(vals);
    g.forEach(o=>{ const v=valOf(o), d=dateOf(o); if(!isNum(v)||m==null) return;
      if(s>0 && (v-m)/(1.4826*s)>4) an(skedari, fleta, d, fusha, v, 'shumë e lartë (z robust > 4)', `${tp}: mediana ${r(m)}`);
      if(tp==='ditë pune' && v<0.25*m) an(skedari, fleta, d, fusha, v, 'shumë e ulët (< 25% e medianës)', `ditë pune: mediana ${r(m)}`); }); }); }
const profile={}, report={};

// ================================================================ 1. WMS dashboard
{ const S='WMS-dashboard'; const wb=readWorkbook(F_WMS); profile[S]={formati:wb.format, fleta:[]};
  const sheet=n=>wb.sheets.find(s=>s.name===n);
  const tables={}; wb.sheets.forEach(s=>{ const h=s.rows[0]||[], rows=s.rows.slice(1).filter(r=>r.some(v=>v!=null)); tables[s.name]={h,rows}; profile[S].fleta.push(profileTable(S, s.name, h, rows, 2)); });
  // dublikatat: Date në tabelat "by day", Date + Operator në "by operator"
  const dupCheck=(name,keyIdx)=>{ const t=tables[name]; if(!t) return 0; const seen=new Map(); let n=0; t.rows.forEach((rw,i)=>{ const k=keyIdx.map(j=>rw[j]).join('|'); if(seen.has(k)){ n++; an(S,name,i+2,keyIdx.map(j=>t.h[j]).join('+'),k,'dublikatë e çelësit','edhe në rreshtin '+(seen.get(k)+2)); } else seen.set(k,i); }); return n; };
  const byDay=['Prepared by day','Checked In by day','Checked Out by day'], byOp=['Prepared by operator','Checked In by operator','Checked Out by operator'];
  let dups=0; byDay.forEach(n=>dups+=dupCheck(n,[0])); byOp.forEach(n=>dups+=dupCheck(n,[0,1])); dups+=dupCheck('Same-day flow',[0]);
  check(S,'asnjë dublikatë (Date / Date + Operator)', dups===0, dups+' raste');
  // datat që mungojnë (pa të dielat) brenda periudhës së secilës tabelë ditore
  byDay.concat(['Same-day flow']).forEach(n=>{ const ds=tables[n].rows.map(rw=>String(rw[0]).slice(0,10)).sort(); for(let d=ds[0]; d<=ds[ds.length-1]; d=addDay(d,1)) if(!ds.includes(d) && dow(d)!==0) an(S,n,'',  'Date', d, 'ditë që mungon', dayType(d)); });
  // rreshta me 0 te "by operator": operatori është në listë, por pa punë atë ditë
  const zeroRows=Object.fromEntries(byOp.map(n=>[n, tables[n].rows.filter(rw=>rw[2]===0).length]));   // eksporti liston çdo operator çdo ditë, edhe me 0
  byDay.forEach(n=>outliers(S,n,tables[n].rows.map(rw=>({d:String(rw[0]).slice(0,10),v:rw[1]})),o=>o.d,o=>o.v,tables[n].h[1]));
  /* kontrolli i shumave: për çdo datë, Σ "by operator" = "by day"; "By operator (2026-10-02)" = rreshtat e 02.10 te "by operator";
     "Same-day flow": Diff = In − Out, Out/In % = round(Out ÷ In × 100), dhe In / Out = tabelat ditore */
  const K=[]; const pairs=[['Prepared by day','Prepared by operator'],['Checked In by day','Checked In by operator'],['Checked Out by day','Checked Out by operator']];
  pairs.forEach(([dn,on])=>{ const opSum={}; tables[on].rows.forEach(rw=>{ const d=String(rw[0]).slice(0,10); opSum[d]=(opSum[d]||0)+(+rw[2]||0); });
    tables[dn].rows.forEach(rw=>{ const d=String(rw[0]).slice(0,10), a=+rw[1]||0, b=opSum[d]; if(b==null) return; K.push({kontrolli:dn+' = Σ '+on, data:d, vlera_dite:a, vlera_operatoret:b, diferenca:b-a});
      if(a!==b) an(S,dn,d,tables[dn].h[1],a,'totali ditor ≠ Σ operatorëve',`Σ operatorëve ${b} (diferenca ${b-a})`); }); });
  const bo=tables['By operator (2026-10-02)'];
  if(bo){ const bdate='2026-10-02', lookup=(n,name)=>{ const rw=tables[n].rows.find(x=>String(x[0]).slice(0,10)===bdate && x[1]===name); return rw? +rw[2] : 0; };
    bo.rows.forEach((rw,i)=>{ [['Prepared by operator',1],['Checked In by operator',2],['Checked Out by operator',3]].forEach(([n,j])=>{ const a=+rw[j]||0, b=lookup(n,rw[0]);
      K.push({kontrolli:'By operator (2026-10-02) = '+n, data:bdate, vlera_dite:a, vlera_operatoret:b, diferenca:b-a, operatori:rw[0]});
      if(a!==b) an(S,'By operator (2026-10-02)',i+2,bo.h[j],a,'nuk përputhet me fletën '+n,`${rw[0]}: ${b}`); }); }); }
  const sf=tables['Same-day flow'], dayVal=(n,d)=>{ const rw=tables[n].rows.find(x=>String(x[0]).slice(0,10)===d); return rw? +rw[1] : null; };
  sf.rows.forEach((rw,i)=>{ const d=String(rw[0]).slice(0,10), ci=+rw[1], co=+rw[2], diff=+rw[3], pct=+rw[4];
    if(diff!==ci-co) an(S,'Same-day flow',i+2,'Diff (In-Out)',diff,'Diff ≠ In − Out',`${ci} − ${co} = ${ci-co}`);
    const expPct= ci? Math.round(co/ci*100) : 0; if(pct!==expPct) an(S,'Same-day flow',i+2,'Out/In %',pct,'Out/In % ≠ Out ÷ In × 100',`pritej ${expPct}`);
    const ciD=dayVal('Checked In by day',d), coD=dayVal('Checked Out by day',d);
    if(ciD!=null && ciD!==ci) an(S,'Same-day flow',i+2,'Checked In',ci,'ndryshon nga fleta Checked In by day',String(ciD));
    if(coD!=null && coD!==co) an(S,'Same-day flow',i+2,'Check out',co,'ndryshon nga fleta Checked Out by day',String(coD));
    if(ci===0 && co===0) an(S,'Same-day flow',i+2,'Date',d,'ditë me zero','ditë e papërfunduar ose pa aktivitet'); });
  write('wms-dashboard_kontrollet.csv', csv(K,['kontrolli','data','operatori','vlera_dite','vlera_operatoret','diferenca']));
  /* produktiviteti sipas operatorit (vetëm kolonat e skedarit): ditë me vlerë > 0, totali, mediana për ditë aktive */
  const P={}; byOp.forEach((n,k)=>{ const key=['prepared','checkin','checkout'][k]; tables[n].rows.forEach(rw=>{ const o=P[rw[1]]||(P[rw[1]]={operatori:rw[1]}); if(+rw[2]>0){ (o[key+'_v']=o[key+'_v']||[]).push(+rw[2]); } }); });
  const prod=Object.values(P).map(o=>{ const x={operatori:o.operatori}; ['prepared','checkin','checkout'].forEach(k=>{ const v=o[k+'_v']||[]; x[k+'_dite']=v.length; x[k+'_gjithsej']=sum(v); x[k+'_mediana_ne_dite']=r(med(v)); }); return x; })
    .sort((a,b)=>(b.checkout_gjithsej+b.checkin_gjithsej+b.prepared_gjithsej)-(a.checkout_gjithsej+a.checkin_gjithsej+a.prepared_gjithsej) || String(a.operatori).localeCompare(String(b.operatori)));
  write('wms-dashboard_produktiviteti.csv', csv(prod,['operatori','prepared_dite','prepared_gjithsej','prepared_mediana_ne_dite','checkin_dite','checkin_gjithsej','checkin_mediana_ne_dite','checkout_dite','checkout_gjithsej','checkout_mediana_ne_dite']));
  const sumOk=K.filter(k=>k.kontrolli.includes('Σ')), sumBad=sumOk.filter(k=>k.diferenca!==0);
  report[S]={wb, tables, K, sumOk, sumBad, prod, zeroRows, snapshot:tables['Snapshot'].rows};
  check(S,'çdo totali ditor krahasohet me Σ operatorëve', sumOk.length>0, sumOk.length+' krahasime, '+sumBad.length+' ndryshojnë');
}

// ================================================================ 2. Warehouse Check
{ const S='Warehouse-Check'; const wb=readWorkbook(F_WC), sh=wb.sheets[0]; profile[S]={formati:wb.format, fleta:[]};
  const h=sh.rows[0], rows=sh.rows.slice(1).filter(rw=>rw.some(v=>v!=null)), emptyRows=sh.rows.length-1-rows.length;
  profile[S].fleta.push(Object.assign(profileTable(S, sh.name, h, rows, 2), {rreshta_bosh_te_formatuara:emptyRows}));
  if(emptyRows>0) an(S, sh.name, '', '', emptyRows, 'rreshta bosh të formatuara', 'fleta ka '+sh.rows.length+' rreshta, '+rows.length+' me të dhëna');
  const ix=n=>h.indexOf(n), cE=ix('Expected Qty'), cP=ix('Physical Qty'), cD=ix('Difference'), cS=ix('Status'), cSKU=ix('SKU code'), cBar=ix('SKU barcode'), cInv=ix('Invoice'), cDesc=ix('Product description');
  const toNum=v=> isNum(v)? v : numText(v)? +String(v).replace(',','.') : null;
  /* kopja e pastruar (skedar i veçantë): numrat si numra, tekstet pa \r dhe pa hapësira anash, kolona A = "Vendi";
     Difference_llogaritur = Physical − Expected; Status_sipas_diferences: < 0 Missing, > 0 Extra, 0 OK */
  const clean=rows.map((rw,i)=>{ const t=v=> typeof v==='string'? v.replace(/[\r\n\t]+/g,' ').trim() : v;
    const exp=toNum(rw[cE]), phy=toNum(rw[cP]), dif=toNum(rw[cD]), calc= exp!=null&&phy!=null? phy-exp : null;
    return {rreshti:i+2, vendi:t(rw[0]), furnitori:t(rw[1]), barcode:t(rw[cBar]), sku:t(rw[cSKU]), pershkrimi:t(rw[cDesc]), pritur:exp, fizike:phy, diferenca_ne_skedar:dif, diferenca_llogaritur:calc,
      statusi:t(rw[cS]), statusi_sipas_diferences: calc==null? null : calc<0? 'Missing' : calc>0? 'Extra' : 'OK', fatura:t(rw[cInv]), koment_depo:t(rw[ix('Warehouse comment')]), koment_ops:t(rw[ix('OPS Comment')]), koment:t(rw[ix('Comment')])}; });
  clean.forEach(c=>{ const rn=c.rreshti;
    if(c.diferenca_ne_skedar!==c.diferenca_llogaritur) an(S,sh.name,rn,'Difference',c.diferenca_ne_skedar,'Difference ≠ Physical − Expected',`llogaritur ${c.diferenca_llogaritur}`);
    if(c.statusi!==c.statusi_sipas_diferences) an(S,sh.name,rn,'Status',c.statusi,'statusi nuk përputhet me diferencën',`pritej ${c.statusi_sipas_diferences}`);
    if(!c.barcode) an(S,sh.name,rn,'SKU barcode','', 'mungon', c.sku||'');
    if(!c.pershkrimi) an(S,sh.name,rn,'Product description','', 'mungon', c.sku||'');
    if(c.fatura && !/^FSE-\d+\/\d{1,2}\/\d{4}\/[A-Z0-9]+$/.test(c.fatura)) an(S,sh.name,rn,'Invoice',c.fatura,'format i papritur i faturës','pritet FSE-nr/muaji/viti/kodi'); });
  const full=new Map(), skuInv=new Map(); clean.forEach(c=>{ const fk=JSON.stringify(Object.assign({},c,{rreshti:0})); if(full.has(fk)) an(S,sh.name,c.rreshti,'(i gjithë rreshti)','', 'dublikatë e plotë','identik me rreshtin '+full.get(fk)); else full.set(fk,c.rreshti);
    if(!c.sku) return; const k=c.sku+'|'+(c.fatura||''); if(skuInv.has(k)) an(S,sh.name,c.rreshti,'SKU code + Invoice',k,'i njëjti SKU dhe faturë në disa rreshta','edhe në rreshtin '+skuInv.get(k)+' — mund të jetë një rresht për njësi; kontrollo'); else skuInv.set(k,c.rreshti); });
  write('warehouse-check_e-pastruar.csv', csv(clean,['rreshti','vendi','furnitori','barcode','sku','pershkrimi','pritur','fizike','diferenca_ne_skedar','diferenca_llogaritur','statusi','statusi_sipas_diferences','fatura','koment_depo','koment_ops','koment']));
  // përmbledhje: sipas vendit × statusit; njësi që mungojnë / tepër; sipas muajit të faturës
  const grp={}; clean.forEach(c=>{ const k=(c.vendi||'(pa vend)')+'|'+(c.statusi||'(pa status)'); const g=grp[k]||(grp[k]={vendi:c.vendi||'(pa vend)', statusi:c.statusi||'(pa status)', rreshta:0, njesi_pritur:0, njesi_fizike:0, diferenca:0}); g.rreshta++; g.njesi_pritur+=c.pritur||0; g.njesi_fizike+=c.fizike||0; g.diferenca+=c.diferenca_llogaritur||0; });
  const byMonth={}; clean.forEach(c=>{ const m=/^FSE-\d+\/(\d{1,2})\/(\d{4})/.exec(c.fatura||''); const k=m? m[2]+'-'+m[1].padStart(2,'0') : '(pa faturë)'; byMonth[k]=(byMonth[k]||0)+1; });
  const summ=Object.values(grp).sort((a,b)=>(a.vendi+a.statusi).localeCompare(b.vendi+b.statusi));
  write('warehouse-check_permbledhje.csv', csv(summ,['vendi','statusi','rreshta','njesi_pritur','njesi_fizike','diferenca'])+'\n'+csv(Object.entries(byMonth).sort().map(([m,n])=>({muaji_i_fatures:m, rreshta:n})),['muaji_i_fatures','rreshta']));
  report[S]={clean, summ, byMonth, emptyRows, h};
  check(S,'Σ diferencës së llogaritur = Σ fizike − Σ pritur', sum(clean.map(c=>c.diferenca_llogaritur))===sum(clean.map(c=>c.fizike))-sum(clean.map(c=>c.pritur)), '');
  check(S,'çdo rresht i skedarit është në kopjen e pastruar', clean.length===rows.length, clean.length+' = '+rows.length);
}

// ================================================================ 3. Schedule
{ const S='Schedule'; const wb=readWorkbook(F_SCH); profile[S]={formati:wb.format, fleta:[]};
  /* struktura: fleta "Pushimet vjetore" = listë emrash; fletët mujore = blloqe javore: rreshti i titullit (kolona A = muaji,
     B–H = 7 data, e hënë → e diel), pastaj një rresht për person (A = emri, B–H = turni). Kolonat I+ janë shënime anash.
     Datat e titullit kontrollohen: brenda bllokut duhet të jenë ditë radhazi. Data "e besueshme" e çdo kolone = ajo që
     del nga shumica e qelizave (fillimi i javës që përputhet me më shumë data); qelizat që nuk përputhen dalin anomali
     dhe në skedarin e normalizuar merret data e korrigjuar. Pa shumicë (< 4 nga 7) → blloku shënohet i pasigurt. */
  const SHIFT=/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
  const kind=v=>{ if(v==null) return null; const s=String(v).trim(); if(SHIFT.test(s)) return 'turn'; if(/^weekly off$/i.test(s)) return 'Weekly OFF'; if(/^off$/i.test(s)) return 'OFF'; if(/^sick leave$/i.test(s)) return 'Sick Leave'; if(s==='-') return '-'; return 'e panjohur'; };
  const hours=s=>{ const m=SHIFT.exec(String(s).trim()); if(!m) return null; let a=+m[1]*60+ +m[2], b=+m[3]*60+ +m[4]; if(b<=a) b+=1440; return (b-a)/60; };
  const long=[], blocks=[], names={}; let prevStart=null;
  wb.sheets.forEach(sh=>{ const nonEmpty=sh.rows.filter(rw=>rw.some(v=>v!=null)).length; profile[S].fleta.push({fleta:sh.name, rreshta:sh.rows.length, me_te_dhena:nonEmpty, kolona:Math.max(0,...sh.rows.map(rw=>rw.length))});
    if(/pushimet/i.test(sh.name)){ sh.rows.forEach(rw=>{ if(rw[0]!=null) names[String(rw[0]).trim()]=names[String(rw[0]).trim()]||{}; }); return; }
    let blk=null;
    sh.rows.forEach((rw,i)=>{ const ds=rw.slice(1,8);
      if(ds.filter(isDate).length>=5){ // titulli i një blloku javor
        const dates=ds.map(v=>isDate(v)? String(v).slice(0,10) : null), votes={};
        dates.forEach((d,k)=>{ if(d){ const st=addDay(d,-k); votes[st]=(votes[st]||0)+1; } });
        const best=Object.entries(votes).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))[0], sure=best && best[1]>=4;
        blk={fleta:sh.name, rreshti:i+1, titulli:rw[0], fillimi:sure? best[0] : null, mbeshtetje:best? best[1] : 0, dates};
        if(!sure) an(S,sh.name,i+1,'B–H',dates.join(' '),'bllok javor me data të pasigurta','asnjë fillim jave nuk përputhet me ≥ 4 data');
        else { if(dow(best[0])!==1){ const exp=prevStart? addDay(prevStart,7) : null, gap=exp? Math.abs((Date.parse(best[0])-Date.parse(exp))/864e5) : 99;
            if(gap<=2){ an(S,sh.name,i+1,'B–H',best[0],'titull i zhvendosur','titulli nis më '+best[0]+' (jo e hënë); java pas asaj të mëparshme nis më '+exp+' — përdoret kjo'); blk.fillimi=exp; best[0]=exp; }
            else an(S,sh.name,i+1,'B',best[0],'java nuk nis të hënën','fillimi sipas shumicës: '+best[0]); }
          prevStart=blk.fillimi;
          dates.forEach((d,k)=>{ const exp=addDay(best[0],k); if(d!==exp) an(S,sh.name,i+1,String.fromCharCode(66+k),d,'datë e gabuar në titull','pritej '+exp+' (dita '+(k+1)+' e javës)'); }); }
        blocks.push(blk); return; }
      if(!blk) return; const nm=rw[0]; if(nm==null || ds.every(v=>v==null)) return;
      const name=String(nm), nameT=name.trim(); if(name!==nameT) an(S,sh.name,i+1,'A',name,'hapësirë në fillim/fund të emrit','');
      (names[nameT]=names[nameT]||{})[sh.name]=1;
      ds.forEach((v,k)=>{ if(v==null) return; const kd=kind(v), d= blk.fillimi? addDay(blk.fillimi,k) : blk.dates[k];
        if(kd==='e panjohur') an(S,sh.name,i+1,String.fromCharCode(66+k),v,'vlerë e panjohur në qelizën e turnit',nameT+(d? ' · '+d : ''));
        const hh= kd==='turn'? hours(v) : null; if(hh!=null && hh>12) an(S,sh.name,i+1,String.fromCharCode(66+k),v,'turn mbi 12 orë',r(hh)+' orë · '+nameT);
        long.push({fleta:sh.name, rreshti:i+1, emri:nameT, data:d, data_ne_skedar:blk.dates[k], data_e_sigurt:blk.fillimi? 1 : 0, vlera:String(v).trim(), lloji:kd, ore:hh}); }); }); });
  // emra që ngjajnë (i njëjti person i shkruar ndryshe): njëri është fillimi i tjetrit, ose ndryshojnë vetëm në -i / -u fundore
  const nm=Object.keys(names).sort(), norm=s=>s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  nm.forEach((a,i)=>nm.slice(i+1).forEach(b=>{ const x=norm(a), y=norm(b); const stem=s=>s.replace(/(i|u)$/,'');
    if(x!==y && (stem(x)===stem(y) || (x.length>=4 && (y.startsWith(x)||x.startsWith(y))))) an(S,'(të gjitha)','', 'A', a+' / '+b, 'i njëjti person i shkruar ndryshe?', 'kontrollo dhe njësho emrin'); }));
  // dublikatat: i njëjti person dy herë në të njëjtën datë
  /* i njëjti person në të njëjtën datë më shumë se një herë (p.sh. java e fundit e muajit e shkruar në dy fleta): me vlerë
     të njëjtë = përsëritje (nuk numërohet dy herë); me vlerë tjetër = konflikt (anomali). Përmbledhja merr vetëm të parën. */
  const seen=new Map(); let repeats=0; long.filter(x=>x.data_e_sigurt).forEach(x=>{ const k=x.emri+'|'+x.data; if(seen.has(k)){ x.perseritje=1; const p=seen.get(k); if(p.vlera!==x.vlera) an(S,x.fleta,x.rreshti,'',x.emri+' '+x.data,'konflikt: dy turne të ndryshme në të njëjtën datë',`${x.vlera} këtu · ${p.vlera} te ${p.fleta} r${p.rreshti}`); else repeats++; } else seen.set(k,x); });
  write('schedule_e-normalizuar.csv', csv(long,['fleta','rreshti','emri','data','data_ne_skedar','data_e_sigurt','perseritje','vlera','lloji','ore']));
  /* përmbledhje për person × muaj (sipas datës së korrigjuar, vetëm blloqet e sigurta): ditë me turn, orë të planifikuara,
     Weekly OFF, OFF, Sick Leave; norma e sëmundjes = Sick Leave ÷ (ditë me turn + Sick Leave) */
  const pm={}; long.filter(x=>x.data_e_sigurt && x.data && !x.perseritje).forEach(x=>{ const k=x.emri+'|'+x.data.slice(0,7); const o=pm[k]||(pm[k]={emri:x.emri, muaji:x.data.slice(0,7), dite_turn:0, ore:0, weekly_off:0, off:0, sick:0, minus:0, te_panjohura:0});
    if(x.lloji==='turn'){ o.dite_turn++; o.ore+=x.ore||0; } else if(x.lloji==='Weekly OFF') o.weekly_off++; else if(x.lloji==='OFF') o.off++; else if(x.lloji==='Sick Leave') o.sick++; else if(x.lloji==='-') o.minus++; else o.te_panjohura++; });
  const pmRows=Object.values(pm).map(o=>Object.assign(o,{ore:r(o.ore), norma_semundjes_pct:(o.dite_turn+o.sick)? r(o.sick/(o.dite_turn+o.sick)*100) : null})).sort((a,b)=>a.muaji.localeCompare(b.muaji)||a.emri.localeCompare(b.emri));
  write('schedule_permbledhje-person-muaj.csv', csv(pmRows,['muaji','emri','dite_turn','ore','weekly_off','off','sick','minus','te_panjohura','norma_semundjes_pct']));
  const kinds={}; long.forEach(x=>kinds[x.lloji]=(kinds[x.lloji]||0)+1);
  const shiftTypes={}; long.filter(x=>x.lloji==='turn').forEach(x=>shiftTypes[x.vlera]=(shiftTypes[x.vlera]||0)+1);
  const months={}; pmRows.forEach(o=>{ const m=months[o.muaji]||(months[o.muaji]={turn:0, sick:0, ore:0, persona:0}); m.turn+=o.dite_turn; m.sick+=o.sick; m.ore+=o.ore; m.persona++; });
  const unsureMonths=[...new Set(blocks.filter(b=>!b.fillimi).map(b=>b.fleta))];
  report[S]={long, blocks, names, kinds, shiftTypes, months, pmRows, repeats, unsureMonths};
  check(S,'çdo qelizë turni është te skedari i normalizuar', long.length===sum(Object.values(kinds)), long.length+' qeliza');
  check(S,'orët e përmbledhjes = Σ orëve të turneve (blloqe të sigurta, pa përsëritje)', r(sum(pmRows.map(o=>o.ore)),1)===r(sum(long.filter(x=>x.data_e_sigurt&&x.data&&!x.perseritje&&x.lloji==='turn').map(x=>x.ore)),1), '');
  check(S,'asnjë person + datë dy herë te përmbledhja', new Set(long.filter(x=>x.data_e_sigurt&&x.data&&!x.perseritje).map(x=>x.emri+'|'+x.data)).size===long.filter(x=>x.data_e_sigurt&&x.data&&!x.perseritje).length, '');
}

// ================================================================ dalja e përbashkët dhe raporti
A.sort((a,b)=>(a.skedari+a.rregulli+a.fleta+String(a.rreshti).padStart(6,'0')+a.fusha).localeCompare(b.skedari+b.rregulli+b.fleta+String(b.rreshti).padStart(6,'0')+b.fusha));
write('anomalite.csv', csv(A,['skedari','fleta','rreshti','fusha','vlera','rregulli','detaje']));
write('profili.json', JSON.stringify(profile,null,2)+'\n');
write('verifikimi.json', JSON.stringify({kontrollet:V},null,2)+'\n');
const byRule=s=>{ const m={}; A.filter(a=>a.skedari===s).forEach(a=>m[a.rregulli]=(m[a.rregulli]||0)+1); return Object.entries(m).sort((x,y)=>y[1]-x[1]); };
const ex=(s,max)=>{ const per={}; return A.filter(a=>a.skedari===s && (per[a.rregulli]=(per[a.rregulli]||0)+1)<=max); };
const tbl=(head,rows)=>['| '+head.join(' | ')+' |','| '+head.map(()=>'---').join(' | ')+' |',...rows.map(x=>'| '+x.map(v=>v==null?'—':String(v).replace(/\|/g,'/')).join(' | ')+' |')];
const md=[`# Inspektimi i tre skedarëve të depos`, '',
`**Skedarët** (origjinalet vetëm lexim; analiza bëhet mbi kopjet): WMS-dashboard-2026-10-03.xls (SHA-256 ${inHash.wms.slice(0,16)}…), Warehouse Check.xlsx (${inHash.wc.slice(0,16)}…), Schedule warehouse team 2026.xlsx (${inHash.sch.slice(0,16)}…).`, '',
`Rikrijimi: \`node analysis-tools/files_inspect.js <WMS-dashboard.xls> <Warehouse Check.xlsx> <Schedule.xlsx> <dosja>\` — i njëjti input jep të njëjtat skedarë (përveç run.json). Lexuesi: analysis-tools/sheet_read.js (pa varësi të jashtme).`, ''];
// --- WMS
{ const R=report['WMS-dashboard'];
  md.push(`## 1. WMS dashboard (eksport 03.10.2026)`, '', `**Struktura:** ${R.wb.sheets.length} fleta, format XML Spreadsheet 2003.`, '',
  ...tbl(['Fleta','Rreshta të dhënash','Kolonat'], R.wb.sheets.map(s=>[s.name, R.tables[s.name].rows.length, (R.tables[s.name].h||[]).filter(x=>x!=null).join(' · ')])), '',
  `**Snapshot (${String(R.snapshot[0][2]).slice(0,16).replace('T',' ')} UTC):** ${R.snapshot.map(x=>x[0]+' '+x[1]).join(' · ')}.`, '',
  `**Cilësia:** ${byRule('WMS-dashboard').length? byRule('WMS-dashboard').map(([k,n])=>k+' '+n).join(' · ') : 'asnjë anomali'}. Rreshta me 0 te fletët "by operator" (eksporti liston çdo operator çdo ditë): ${Object.entries(R.zeroRows).map(([k,v])=>k+' '+v).join(' · ')} — nuk numërohen si anomali.`, '');
  const sb=R.sumBad; md.push(`**Përputhja mes fletëve** (saktësia e të dhënave): ${R.sumOk.length} krahasime "totali ditor = Σ operatorëve", ${sb.length} ndryshojnë${sb.length? ' — '+[...new Set(sb.map(k=>k.kontrolli.split(' =')[0]))].map(n=>n+': '+sb.filter(k=>k.kontrolli.startsWith(n)).length+' ditë, diferenca mediane '+r(med(sb.filter(k=>k.kontrolli.startsWith(n)).map(k=>k.diferenca)))).join('; ') : ''}. Lista: wms-dashboard_kontrollet.csv.`, '',
  `**Produktiviteti** (vetëm kolonat e skedarit: porosi të përgatitura, produkte check-in, produkte check-out për operator × ditë; "ditë" = ditë me vlerë > 0):`, '',
  ...tbl(['Operatori','Përgatitur: ditë / mediana','Check-in: ditë / mediana','Check-out: ditë / mediana'], R.prod.slice(0,12).map(x=>[x.operatori+(/^temp/i.test(x.operatori)? ' (llogari e përbashkët)' : ''), x.prepared_dite? x.prepared_dite+' / '+x.prepared_mediana_ne_dite : '—', x.checkin_dite? x.checkin_dite+' / '+x.checkin_mediana_ne_dite : '—', x.checkout_dite? x.checkout_dite+' / '+x.checkout_mediana_ne_dite : '—'])), '',
  `Të gjithë operatorët: wms-dashboard_produktiviteti.csv. **Kohët e procesit:** skedari nuk ka kolona kohe (vetëm data dhe "As of"), ndaj nuk maten.`, ''); }
// --- Warehouse Check
{ const R=report['Warehouse-Check'], c=R.clean;
  md.push(`## 2. Warehouse Check (kontrolli i mallit hyrës)`, '', `**Struktura:** 1 fletë ("2026"), ${c.length} rreshta me të dhëna nga ${c.length+1+R.emptyRows} të formatuara; ${R.h.filter(x=>x!=null).length} kolona me titull nga ${R.h.length}; kolona A pa titull përmban vendin (${[...new Set(c.map(x=>x.vendi))].join(', ')}).`, '',
  `**Cilësia:**`, '', ...tbl(['Rregulli','Raste'], byRule('Warehouse-Check')), '',
  `**Saktësia** (vetëm sa lejojnë kolonat): skedari është regjistër i **mospërputhjeve** — çdo rresht është "Missing" ose "Extra"; nuk ka numrin e artikujve të kontrolluar gjithsej, ndaj **saktësia e inventarit (%) nuk mund të llogaritet**. Formula e kontrollit: Diferenca = Fizike − E pritur; Statusi pritet "Missing" kur < 0, "Extra" kur > 0.`, '',
  ...tbl(['Vendi','Statusi','Rreshta','Njësi të pritura','Njësi fizike','Diferenca'], R.summ.map(s=>[s.vendi,s.statusi,s.rreshta,s.njesi_pritur,s.njesi_fizike,s.diferenca])), '',
  `Sipas muajit të faturës: ${Object.entries(R.byMonth).sort().map(([m,n])=>m+' '+n).join(' · ')}. Furnitori: ${[...new Set(c.map(x=>x.furnitori))].join(', ')}. **Produktiviteti dhe kohët:** nuk ka kolona (as operator, as datë/orë kontrolli). Kopja e pastruar: warehouse-check_e-pastruar.csv.`, ''); }
// --- Schedule
{ const R=report['Schedule'], blkSure=R.blocks.filter(b=>b.fillimi).length;
  md.push(`## 3. Schedule warehouse team 2026 (orari)`, '', `**Struktura:** ${profile['Schedule'].fleta.length} fleta: "Pushimet vjetore" (listë me ${Object.keys(R.names).length? profile['Schedule'].fleta[0].me_te_dhena : 0} emra) dhe ${profile['Schedule'].fleta.length-1} fleta mujore (janar 2025 → tetor 2026) me ${R.blocks.length} blloqe javore; ${R.long.length} qeliza turni; ${Object.keys(R.names).length} emra të ndryshëm.`, '',
  `**Llojet e qelizave:** ${Object.entries(R.kinds).sort((a,b)=>b[1]-a[1]).map(([k,n])=>k+' '+n).join(' · ')}. Turnet më të shpeshta: ${Object.entries(R.shiftTypes).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,n])=>k+' ('+n+')').join(', ')}.`, '',
  `**Cilësia:**`, '', ...tbl(['Rregulli','Raste'], byRule('Schedule')), '',
  `Datat e titujve: ${blkSure} nga ${R.blocks.length} blloqe kanë fillim jave të sigurt (≥ 4 nga 7 data përputhen, ose titull i zhvendosur i korrigjuar nga java e mëparshme); datat e gabuara korrigjohen te skedari i normalizuar sipas pozicionit në javë. ${R.repeats} qeliza janë përsëritje të së njëjtës javë në dy fleta (me të njëjtin turn) dhe numërohen një herë.${R.unsureMonths.length? ' Blloqe të pasigurta (jashtë përmbledhjes) në fletët: '+R.unsureMonths.join(', ')+' — ato muaj dalin më të ulët.' : ''}`, '',
  `**Orët dhe mungesat sipas muajit** (blloqe të sigurta; orë = fund − fillim, +24 kur turni kalon mesnatën; norma e sëmundjes = Sick Leave ÷ (ditë me turn + Sick Leave)):`, '',
  ...tbl(['Muaji','Persona','Ditë me turn','Orë të planifikuara','Sick Leave','Norma e sëmundjes'], Object.entries(R.months).sort().map(([m,o])=>[m,o.persona,o.turn,r(o.ore),o.sick,(o.turn+o.sick)? r(o.sick/(o.turn+o.sick)*100)+'%' : '—'])), '',
  `**Produktiviteti dhe saktësia e punës:** orari nuk ka kolona pune (sasi, gabime), ndaj nuk maten këtu. Për person × muaj: schedule_permbledhje-person-muaj.csv; të gjitha qelizat me datën e korrigjuar: schedule_e-normalizuar.csv.`, ''); }
md.push(`## 4. Shembuj anomalish (deri 3 për çdo rregull)`, '', ...tbl(['Skedari','Fleta','Rreshti','Fusha','Vlera','Rregulli','Detaje'], ['WMS-dashboard','Warehouse-Check','Schedule'].flatMap(s=>ex(s,3)).map(a=>[a.skedari,a.fleta,a.rreshti,a.fusha,String(a.vlera).slice(0,40),a.rregulli,a.detaje])), '', `Lista e plotë (${A.length}): anomalite.csv.`, '');
md.push(`## 5. Supozimet dhe kufizimet`, '',
`- Analizohen vetëm kolonat që ekzistojnë; asgjë nuk plotësohet me supozime. Kur një metrikë nuk ka kolona (kohët te WMS dashboard, saktësia % e inventarit, produktiviteti te orari), shkruhet që nuk matet.`,
`- WMS dashboard: "ditë" e operatorit = ditë me vlerë > 0; rreshtat me 0 shënohen veç. Totali ditor mund të përfshijë llogari që nuk janë në listën e operatorëve, ndaj diferenca "ditor − Σ operatorëve" është sinjal, jo gabim i provuar.`,
`- Warehouse Check: numri i ruajtur si tekst ("-1", "2") lexohet si numër te kopja e pastruar; kolona A pa titull trajtohet si "Vendi" (vlerat XK/AL).`,
`- Orari: data e çdo qelize merret nga shumica e datave të titullit të bllokut (fillimi i javës + pozicioni); blloqet pa shumicë lihen me datën siç është në skedar dhe nuk hyjnë te përmbledhja. Vlerat në kolonat I+ janë shënime anash dhe nuk analizohen si turne. Emrat janë si në skedar (emra të shkurtër) dhe nuk lidhen automatikisht me emrat e WMS-it.`,
`- Turnet që kalojnë mesnatën numërohen në datën e fillimit.`, '');
md.push(`## 6. Verifikimi`, '', ...tbl(['Skedari','Kontrolli','Rezultati','Detaje'], V.map(v=>[v.skedari,v.kontrolli,v.rezultati,v.detaje])), '');
write('raporti.md', md.join('\n'));
const outs=fs.readdirSync(OUT).filter(f=>f!=='run.json').sort();
write('run.json', JSON.stringify({koha:new Date().toISOString(), skripti:'analysis-tools/files_inspect.js', hyrjet:{[F_WMS]:inHash.wms,[F_WC]:inHash.wc,[F_SCH]:inHash.sch}, daljet:Object.fromEntries(outs.map(f=>[f,sha(path.join(OUT,f))]))},null,2)+'\n');
console.log('OK · anomali '+A.length+' · kontrolle '+V.filter(v=>v.rezultati==='OK').length+'/'+V.length+' OK → '+OUT);
