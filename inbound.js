/* =========================================================================
   PRODUCT / INBOUND FLOW — automatic part, from WMS.
   One WMS supply (Supplies) = one inbound batch from one seller. pulse/build.js puts every batch of yesterday and
   today (plus older ones that still have units waiting to be mapped) into /pulse/data → inbound, refreshed hourly
   from the WMS database (query block F in pulse/queries.sql). Stages:
     Arrival   = the invoice/document registered, or the truck's actual arrival when the invoice belongs to a shipment
     Receiving = supply opened in WMS            Check-in = first → last unit checked in (LogType 2)
     Mapping   = first → last unit mapped (7)    System update = supply closed ("Done")
   Cross-dock = a unit went to an order (LogType 3) before any mapping. Manual observations (physical location, a
   discrepancy seen on the floor) can be attached to a WMS batch: they are ordinary Store 'products' records carrying
   wmsId = the supply id. Loaded after shared.js and before app.js; uses app.js helpers at call time.
   =======================================================================*/
let inbWms=null, inbFilter='today', inbQuery='', inbOpen=null, inbSeq=0;
const INB_FILTERS=[['today','Sot'],['yesterday','Dje'],['issues','Me probleme'],['await','Në pritje të mapimit'],['nocheckin','Pa check-in'],['all','Të gjitha']];
const inbT=s=>s? new Date(s.replace(' ','T')) : null;                       // WMS local time 'yyyy-mm-dd hh:mi'
const inbHM=s=>s? s.slice(11,16) : '—';
const inbDM=s=>s? s.slice(8,10)+'.'+s.slice(5,7)+' '+s.slice(11,16) : '—';
const inbWhen=s=>!s? '—' : s.slice(0,10)===todayStr()? inbHM(s) : inbDM(s);   // time only for today
const inbDur=min=>{ if(min==null||isNaN(min)) return ''; if(min<0) return '⚠'; if(min<60) return Math.round(min)+' min'; const h=min/60; return h<48? (Math.round(h*10)/10)+' h' : Math.round(h/24*10)/10+' ditë'; };
const inbMin=(a,b)=> a&&b? (inbT(b)-inbT(a))/60000 : null;
const fmtNum=n=> n==null? '—' : Number(n).toLocaleString();

/* problems of one batch, worst first: [level 'crit'|'warn'|'info', text] */
function inbFlags(b, now){
  const f=[], ageH=(now-inbT(b.rcv))/3600000;
  if(!b.n){ if(ageH>2) f.push(['crit','Furnizimi u hap '+inbDur(ageH*60)+' më parë, por s\'ka asnjë njësi të check-in-uar']); }
  // while a supply is still open and recent, fewer units than the invoice / units not yet mapped is normal work in progress
  if(b.ex!=null && b.n<b.ex && (b.ss===3 || ageH>4)) f.push([b.ss===3?'crit':'warn', (b.ex-b.n)+' njësi më pak se fatura ('+b.n+' / '+b.ex+')'+(b.ss===3?' — furnizimi u mbyll':' — ende i hapur pas '+inbDur(ageH*60))]);
  if(b.ex!=null && b.n>b.ex) f.push(['warn', (b.n-b.ex)+' njësi më shumë se fatura ('+b.n+' / '+b.ex+')']);
  if(b.aw>0){ const waitH=b.c2? (now-inbT(b.c2))/3600000 : 0; if(waitH>4) f.push([waitH>24?'crit':'warn', b.aw+' njësi presin mapimin prej '+inbDur(waitH*60)+' (nga check-in-i i fundit)']); }
  if(b.cm!=null && b.cm>24*60) f.push(['warn','check-in → map mesatarisht '+inbDur(b.cm)]);
  if(b.ss===1 && ageH>24) f.push(['warn','furnizimi s\'është mbyllur ("Started") prej '+inbDur(ageH*60)]);
  if(b.arr && b.rcv){ const d=inbMin(b.arr,b.rcv); if(d>24*60) f.push(['warn','pranimi '+inbDur(d)+' pas mbërritjes së kamionit']); }
  if(b.nf>0) f.push(['crit', b.nf+' raportime "not found" për produktet e këtij furnizimi']);
  if(b.cc>0) f.push(['warn', b.cc+' njësi me kod produkti të ndryshuar pas check-in-it (SKU i gabuar)']);
  if(b.im>0) f.push(['warn', b.im+' njësi të gjetura në inventar në rresht tjetër nga ai në sistem']);
  return f.sort((x,y)=>(x[0]==='crit'?0:1)-(y[0]==='crit'?0:1));
}
function inbKind(b){ return b.sk? 'Starter kit' : b.fl? 'Fast lane' : 'Standard'; }
function inbHandling(b){
  if(!b.n) return '—';
  const st=b.n-b.xd, parts=[];
  if(b.xd) parts.push(b.xd===b.n? 'Cross-dock → porosi' : b.xd+' cross-dock');
  if(st>0) parts.push(b.mp>=st? st+' në depo (mapuar)' : (b.mp? b.mp+' mapuar, ' : '')+(st-b.mp)+' për depo');
  return parts.join(' · ');
}

function inboundWmsHTML(){
  return `<div class="card" style="margin-bottom:14px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <h3 style="margin:0">📥 Furnizimet nga WMS <span class="sub">plotësohet automatikisht</span></h3>
      <span id="inbAt" class="small faint" style="margin-left:auto"></span></div>
    <div id="inbWmsBody" style="margin-top:10px"><div class="empty">Po ngarkohet…</div></div></div>`;
}
async function loadInboundWms(){
  const box=$('#inbWmsBody'); if(!box) return;
  if(!wmsOnAgent()){ box.innerHTML='<div class="empty">Hape app-in nga http://localhost:8790 që të shohësh furnizimet nga WMS.</div>'; return; }
  const seq=++inbSeq;
  try{ const r=await fetch('/pulse/data',{cache:'no-store'}); const j=await r.json(); if(seq!==inbSeq) return;
    if(!r.ok||j.error){ box.innerHTML=`<div class="empty">${h(j.error||('HTTP '+r.status))}</div>`; return; }
    if(!j.inbound){ box.innerHTML='<div class="empty">Të dhënat e furnizimeve s\'janë gjeneruar ende — vijnë me rifreskimin e radhës nga databaza e WMS-it (çdo orë).</div>'; return; }
    inbWms=j.inbound; drawInboundWms();
  }catch(e){ if(seq===inbSeq) box.innerHTML=`<div class="empty">Agjenti s'përgjigjet (${h(e.message)}).</div>`; }
}
function drawInboundWms(){
  const box=$('#inbWmsBody'); if(!box||!inbWms) return;
  const now=new Date(), all=inbWms.batches.map(b=>Object.assign({}, b, {flags:inbFlags(b, now)}));
  const at=inbWms.at? new Date(inbWms.at) : null, ageMin=at? (now-at)/60000 : null;
  const atEl=$('#inbAt'); if(atEl) atEl.innerHTML= at? `Lexuar nga WMS: <b style="${ageMin>150?'color:var(--warn)':''}">${h(at.toLocaleString())}</b> · rifreskohet çdo orë` : '';
  const todayIso=todayStr(), yIso=(()=>{ const d=new Date(); d.setDate(d.getDate()-1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })();
  const day=b=>b.rcv.slice(0,10), td=all.filter(b=>day(b)===todayIso);
  const tdUnits=td.reduce((a,b)=>a+b.n,0), tdX=td.reduce((a,b)=>a+(b.xd||0),0), awAll=all.reduce((a,b)=>a+(b.aw||0),0);
  const cms=all.filter(b=>day(b)>=yIso && b.cm!=null), cmAvg=cms.length? cms.reduce((a,b)=>a+b.cm*b.mp,0)/Math.max(1,cms.reduce((a,b)=>a+b.mp,0)) : null;
  const mis=all.filter(b=>b.flags.some(f=>/fatura \(/.test(f[1]))).length, noCi=all.filter(b=>!b.n && (now-inbT(b.rcv))>2*3600000).length;
  const kpis=`<div class="grid g-kpi" style="margin-bottom:12px">
      ${kpiCard(td.length,'Furnizime sot',`${fmtNum(tdUnits)} njësi të check-in-uara`)}
      ${kpiCard(tdUnits? Math.round(tdX/tdUnits*100)+'%' : '—','Cross-dock sot',`${fmtNum(tdX)} njësi direkt te porositë`)}
      ${kpiCard(fmtNum(awAll),'Njësi në pritje të mapimit','në të gjitha furnizimet e hapura', awAll>0?'warn':'')}
      ${kpiCard(cmAvg!=null? inbDur(cmAvg) : '—','Check-in → map (dje + sot)','mesatare e peshuar me njësitë')}
      ${kpiCard(mis,'Sasi ≠ fatura','të mbyllura, ose të hapura > 4 orë', mis?'warn':'')}
      ${kpiCard(noCi,'Pa check-in','furnizime të hapura > 2 orë pa asnjë njësi', noCi?'crit':'')}
    </div>`;
  const daily=(inbWms.daily||[]), mxN=Math.max(1,...daily.map(d=>d.n));
  const trend=daily.length? `<details style="margin-bottom:12px"><summary class="small" style="cursor:pointer"><b>Trendi 14 ditë</b> — furnizime, njësi, cross-dock dhe koha check-in → map</summary>
      <div style="overflow-x:auto;margin-top:8px"><table style="font-size:12px;max-width:760px"><thead><tr><th>Data</th><th>Furnizime</th><th>Njësi</th><th></th><th>Cross-dock</th><th>Mapuar</th><th>Presin map</th><th>Check-in → map</th></tr></thead><tbody>
      ${daily.map(d=>`<tr><td>${h(fmtDateAl(d.d))} ${STATS_WEEKDAYS[(new Date(d.d+'T12:00:00').getDay()+6)%7]}</td><td>${d.s}</td><td>${fmtNum(d.n)}</td>
        <td><span style="display:inline-block;height:7px;border-radius:3px;background:var(--accent);width:${Math.round(d.n/mxN*90)}px"></span></td>
        <td>${d.n? Math.round(d.xd/d.n*100)+'%' : '—'}</td><td>${fmtNum(d.mp)}</td><td>${d.aw? `<span style="color:var(--warn)">${d.aw}</span>` : '0'}</td><td>${d.cm!=null? inbDur(d.cm) : '—'}</td></tr>`).join('')}
      </tbody></table></div></details>` : '';
  const counts={today:td.length, yesterday:all.filter(b=>day(b)===yIso).length, issues:all.filter(b=>b.flags.length).length, await:all.filter(b=>b.aw>0).length, nocheckin:all.filter(b=>!b.n).length, all:all.length};
  const chips=`<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      ${INB_FILTERS.map(([k,l])=>`<span class="chip ${inbFilter===k?'on':''}" data-inbf="${k}">${l} <b style="margin-left:5px">${counts[k]}</b></span>`).join('')}
      <input id="inbSearch" placeholder="Kërko furnizim / faturë / kod / shitës…" value="${h(inbQuery)}" style="margin-left:auto;max-width:260px;min-height:38px"></div>`;
  const q=inbQuery.trim().toLowerCase();
  let rows=all.filter(b=> inbFilter==='today'? day(b)===todayIso : inbFilter==='yesterday'? day(b)===yIso : inbFilter==='issues'? b.flags.length>0
      : inbFilter==='await'? b.aw>0 : inbFilter==='nocheckin'? !b.n : true);
  if(q) rows=rows.filter(b=>[b.id,b.inv,b.cd,b.pn,b.sec,'#'+b.st,String(b.st)].join(' ').toLowerCase().includes(q));
  if(inbFilter==='issues') rows.sort((a,b)=>b.flags.filter(f=>f[0]==='crit').length-a.flags.filter(f=>f[0]==='crit').length || b.flags.length-a.flags.length);
  const notes=Store.col('products').filter(p=>p.wmsId);
  const tr=b=>{ const crit=b.flags.some(f=>f[0]==='crit'), n=notes.filter(p=>p.wmsId===b.id).length;
    return `<tr data-inb="${h(b.id)}" style="cursor:pointer${inbOpen===b.id?';background:var(--panel2)':''}">
      <td><b>${h(b.id)}</b>${b.inv?`<div class="small faint">fatura ${h(b.inv)}</div>`:''}</td>
      <td>#${h(b.st)}</td><td class="small">${inbKind(b)}</td>
      <td>${b.ex!=null? `${b.n} / ${b.ex}` : b.n}</td>
      <td class="small">${inbWhen(b.arr||b.ia)}</td><td class="small">${inbWhen(b.rcv)}</td>
      <td class="small">${b.c1? inbWhen(b.c1)+(b.c2&&b.c2!==b.c1?'–'+inbHM(b.c2):'') : '—'}</td>
      <td class="small">${b.m1? inbWhen(b.m1)+(b.m2&&b.m2!==b.m1?'–'+inbWhen(b.m2):'') : (b.n&&b.xd===b.n&&!b.aw?'<span class="faint">s\'duhet</span>':'—')}</td>
      <td class="small">${b.dn? inbWhen(b.dn) : (b.ss===1?'<span class="faint">hapur</span>':'—')}</td>
      <td class="small">${inbHandling(b)}</td><td class="small">${h(b.sec||'—')}</td>
      <td>${b.flags.length? `<span class="badge ${crit?'b-crit':'b-warn'}">${b.flags.length}</span>` : '<span class="faint">—</span>'}${n?` <span title="vëzhgime fizike">📝${n}</span>`:''}</td></tr>
      ${inbOpen===b.id? `<tr><td colspan="12" style="background:var(--panel2);padding:0">${inbDetail(b, notes.filter(p=>p.wmsId===b.id))}</td></tr>` : ''}`; };
  box.innerHTML=kpis+trend+chips+(rows.length? `<div style="overflow-x:auto"><table style="font-size:12.5px"><thead><tr><th>Furnizimi</th><th>Shitësi</th><th>Lloji</th><th>Njësi / fatura</th><th>Arritja</th><th>Pranimi</th><th>Check-in</th><th>Mapimi</th><th>Mbyllur</th><th>Trajtimi</th><th>Lokacioni</th><th>Probleme</th></tr></thead>
      <tbody>${rows.slice(0,200).map(tr).join('')}</tbody></table></div>${rows.length>200?`<div class="hint">Shfaqen 200 nga ${rows.length} — përdor kërkimin.</div>`:''}`
    : '<div class="empty">Asnjë furnizim për këtë filtër.</div>')
    + `<div class="hint" style="margin-top:8px">Një furnizim në WMS = një batch nga një shitës. <b>Arritja</b> = regjistrimi i faturës, ose mbërritja reale e kamionit kur fatura i përket një transporti; <b>Pranimi</b> = hapja e furnizimit; <b>Check-in</b> / <b>Mapimi</b> = njësia e parë → e fundit (LogType 2 / 7); <b>Mbyllur</b> = furnizimi "Done". <b>Cross-dock</b> = njësia shkoi direkt te një porosi pa u mapuar në raft. Shitësi tregohet me numrin e tij në WMS (WMS s'ruan emrat e shitësve). Kliko një rresht për detajet dhe për të shtuar një vëzhgim fizik (lokacioni fizik, mospërputhje).</div>`;
  $$('[data-inbf]').forEach(c=>c.onclick=()=>{ inbFilter=c.dataset.inbf; inbOpen=null; drawInboundWms(); });
  const si=$('#inbSearch'); if(si){ si.oninput=e=>{ inbQuery=e.target.value; clearTimeout(si._t); si._t=setTimeout(()=>{ drawInboundWms(); const n=$('#inbSearch'); if(n){ n.focus(); n.setSelectionRange(n.value.length,n.value.length); } },250); }; }
  $$('[data-inb]').forEach(r=>r.onclick=()=>{ inbOpen= inbOpen===r.dataset.inb? null : r.dataset.inb; drawInboundWms(); });
  $$('[data-inbnote]').forEach(btn=>btn.onclick=e=>{ e.stopPropagation(); const b=all.find(x=>x.id===btn.dataset.inbnote); if(b) openInboundNote(b); });
}
function inbDetail(b, notes){
  const stages=[['Arritja', b.arr||b.ia, null],['Pranimi', b.rcv, null],['Check-in', b.c1, b.c2],['Mapimi', b.m1, b.m2],['Mbyllur në sistem', b.dn, null]];
  let prev=null;
  const chips=stages.map(([l,t1,t2])=>{ const skip= l==='Mapimi' && !t1 && b.n && b.xd===b.n && !b.aw;
    const dur= prev&&t1? ' · +'+inbDur(inbMin(prev,t1)) : ''; if(t1) prev=t2||t1;
    return `<span class="${t1?'on':''}" title="${h(t1? inbDM(t1)+(t2&&t2!==t1?' → '+inbDM(t2):'') : '')}">${h(l)} ${t1? inbWhen(t1)+(t2&&t2!==t1?'–'+(t2.slice(0,10)===t1.slice(0,10)?inbHM(t2):inbDM(t2)):'') : (skip?'— cross-dock':'—')}${dur}</span>`; }).join('<i>›</i>');
  const flags=inbFlags(b,new Date());
  const kv=(k,v)=>`<span>${k}: <b>${v}</b></span>`;
  return `<div style="padding:12px 14px">
    <div class="flowstrip" style="margin-bottom:10px">${chips}</div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px" class="muted">
      ${kv('Shitësi','#'+h(b.st))} ${kv('Lloji',inbKind(b))} ${b.inv?kv('Fatura',h(b.inv)):''} ${kv('Njësi / fatura', b.ex!=null? b.n+' / '+b.ex : b.n+' (pa faturë të lidhur)')}
      ${kv('Kode produkti',b.k||0)} ${b.pn||b.cd? kv('Produkti kryesor',h(b.pn||b.cd)) : ''}
      ${kv('Trajtimi',h(inbHandling(b)))} ${b.o? kv('Porosi të shërbyera direkt',b.o) : ''}
      ${kv('Lokacioni në sistem',h(b.sec||'—'))} ${b.cm!=null? kv('Check-in → map (mes.)',inbDur(b.cm)) : ''}
    </div>
    ${flags.length? `<div class="note crit" style="margin-top:8px"><span class="etag et-data">nga WMS</span>${flags.map(f=>h(f[1])).join(' · ')}</div>` : '<div class="note" style="margin-top:8px">Asnjë mospërputhje e gjetur në WMS.</div>'}
    ${notes.map(p=>{ const locMis=p.physicalLoc && b.sec && !String(b.sec).toLowerCase().includes(String(p.physicalLoc).toLowerCase()) && !String(p.physicalLoc).toLowerCase().includes(String(b.sec).toLowerCase());
      return `<div class="note" style="margin-top:6px"><span class="etag et-obs">vëzhgim fizik</span> ${h(p.date||'')} · lokacioni fizik: <b>${na(p.physicalLoc)}</b>${locMis?' <span class="badge b-crit">≠ sistemi ('+h(b.sec)+')</span>':''}${p.qtyReceived!=null?` · numëruar: <b>${p.qtyReceived}</b>${p.qtyReceived!==b.n?' <span class="badge b-warn">≠ WMS ('+b.n+')</span>':''}`:''}${p.discrepancy?' · '+h(p.discrepancy):''}${p.note?' · '+h(p.note):''}</div>`; }).join('')}
    <div class="btnrow" style="margin-top:10px"><button class="btn sm" data-inbnote="${h(b.id)}">📝 Shto vëzhgim fizik</button></div>
  </div>`;
}
/* a physical observation on a WMS batch → an ordinary inbound record (Store 'products') linked by wmsId */
function openInboundNote(b){
  openProdForm(null, { wmsId:b.id, sku:b.cd||b.id, desc:'Furnizimi '+b.id+(b.inv?' · fatura '+b.inv:''), date:todayStr(), seller:'Shitësi #'+b.st,
    qtyExpected:b.ex!=null? b.ex : b.n, systemLoc:b.sec||'', handling: b.n && b.xd===b.n? 'Cross-dock → check-out' : 'To storage (map → put-away)' });
}
