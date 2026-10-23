/* =========================================================================
   PROCESET SIPAS OPERATORIT (People, after Kapaciteti & Stafi — the warehouse lead, 17.10.2026)
   Every process each person did in the chosen period, from the agent's GET /people/process?from&to:
     Claim      units reserved for an order (WMS LogTypeId 3 with an order — meaning inferred) · orders
     Picking    units scanned in pick sessions (WMS PickSessionScan, via WMS Pulse — hourly)
     Check-out  products checked out (LogTypeId 4 + 18) · orders
     POD        orders scanned for POD (Delivery Platform)
     Check-In   units checked in (LogTypeId 2)
     Mapping    units mapped to a shelf row (LogTypeId 7)
     Kthime/Refuzime  refused orders collected (Delivery Platform) + customer-return units processed (WMS 20/21/22/29)
   Only the warehouse staff accounts; a person's two accounts merged. Loaded after shared.js and before app.js.
   =======================================================================*/
let ppFrom=null, ppTo=null, ppData=null, ppSeq=0, ppBusy=false;
const PP_COLS=[
  ['claim','Claim','produkte', o=>o.claimOrders? o.claimOrders+' porosi' : ''],
  ['picking','Picking','produkte', ()=>''],
  ['checkout','Check-out','porosi', ()=>''],   // orders only (the lead, 17.10.2026) — ppVal reads checkoutOrders
  ['pod','POD','porosi', ()=>''],
  ['checkin','Check-In','produkte', ()=>''],
  ['mapping','Mapping','produkte', ()=>''],
  ['retref','Kthime/Refuzime','', o=>(o.ref? o.ref+' refuzime' : '')+(o.ref&&o.ret? ' · ' : '')+(o.ret? o.ret+' kthime' : '')]];
const PP_CO_STYLE='color:var(--crit);background:color-mix(in srgb, var(--crit) 7%, transparent)';
const ppVal=(o,k)=> k==='retref'? (o.ref||0)+(o.ret||0) : k==='checkout'? (o.checkoutOrders||0) : (o[k]||0);
function ppIso(d){ return fmtLocalDate(d); }
function renderPeopleProcess(v){
  const t=todayStr(); if(!ppFrom){ ppFrom=t; ppTo=t; }
  const quick=[['Sot',0,0],['Dje',1,1],['7 ditë',6,0],['30 ditë',29,0]];
  v.innerHTML=pagehead('Proceset sipas operatorit','Çdo proces që ka kryer secili operator në periudhën e zgjedhur, nga WMS dhe Delivery Platform. Vetëm llogaritë e stafit të depos; dy llogaritë e të njëjtit person bashkohen.', window.PP_STANDALONE? '' : `<button class="btn" id="ppOpen">↗ Hap si faqe më vete</button><button class="btn" id="ppRot" title="Tabela ditore dhe Proceset sipas operatorit me radhë, çdo 30 sekonda">🖥 Monitori: Tabela ↔ Proceset</button>`)
    +`<div class="filters" style="align-items:center">${quick.map(([l,a,b])=>`<button class="btn sm" data-ppq="${a},${b}">${l}</button>`).join('')}
        <label class="small">nga <input type="date" id="ppFrom" value="${h(ppFrom)}" max="${t}" style="width:auto;min-height:32px"></label>
        <label class="small">deri <input type="date" id="ppTo" value="${h(ppTo)}" max="${t}" style="width:auto;min-height:32px"></label>
        <button class="btn sm primary" id="ppGo">Shfaq</button><span class="small faint" id="ppAt" style="margin-left:auto"></span></div>
      <div id="ppBody"><div class="empty">Po lexohet…</div></div>`;
  const back=n=>{ const d=new Date(); d.setDate(d.getDate()-n); return ppIso(d); };
  $$('[data-ppq]').forEach(b=>b.onclick=()=>{ const [a,c]=b.dataset.ppq.split(',').map(Number); ppFrom=back(a); ppTo=back(c); renderPeopleProcess(v); });
  const ob=$('#ppOpen'); if(ob) ob.onclick=()=>window.open('/proceset','proceset');
  const rb=$('#ppRot'); if(rb) rb.onclick=()=>window.open('/ekrani?s=30&p=tabela,proceset','ekrani');   // the same table as a page of its own (17.10.2026)
  $('#ppGo').onclick=()=>{ const f=$('#ppFrom').value, to=$('#ppTo').value; if(!f||!to||f>to){ toast('Zgjidh një periudhë të vlefshme'); return; } ppFrom=f; ppTo=to; ppLoad(); };
  if(ppData && ppData.from===ppFrom && ppData.to===ppTo) ppDraw(); else ppLoad();
}
async function ppLoad(){
  const seq=++ppSeq, body=$('#ppBody'); if(body) body.innerHTML=`<div class="empty">Po lexohet ${h(fmtDateAl(ppFrom))}${ppTo!==ppFrom? ' – '+h(fmtDateAl(ppTo)) : ''}… (një periudhë e gjatë lexohet ditë pas dite, mund të zgjasë disa minuta herën e parë)</div>`;
  try{ const r=await fetch('/people/process?from='+ppFrom+'&to='+ppTo,{cache:'no-store'}); const j=await r.json(); if(seq!==ppSeq) return;
    ppData= r.ok&&!j.error? j : {error:j.error||('HTTP '+r.status)}; }
  catch(e){ if(seq!==ppSeq) return; ppData={error:'Agjenti nuk përgjigjet ('+e.message+'). Hape app-in nga http://localhost:8790.'}; }
  ppDraw();
}
function ppDraw(){
  const body=$('#ppBody'); if(!body||!ppData) return;
  if(ppData.error){ body.innerHTML=`<div class="card"><div class="empty">${h(ppData.error)}</div></div>`; return; }
  $('#ppAt').textContent='lexuar '+fmtTime(ppData.at);
  const ops=ppData.ops||[], tot={}; PP_COLS.forEach(([k])=>tot[k]=ops.reduce((a,o)=>a+ppVal(o,k),0));
  ['claimOrders','checkoutOrders','ref','ret'].forEach(k=>tot[k]=ops.reduce((a,o)=>a+(o[k]||0),0));
  const cell=(o,[k,,unit,sub])=>{ const n=ppVal(o,k), s=sub(o);
    return `<td class="num" data-sort="${n}"${k==='checkout'? ' style="'+PP_CO_STYLE+'"' : ''}>${n? `<b>${n.toLocaleString('de-DE')}</b>${unit? ' <span class="faint small"'+(k==='checkout'? ' style="color:inherit;opacity:.8"' : '')+'>'+unit+'</span>' : ''}${s? `<div class="faint small"${k==='checkout'? ' style="color:inherit;opacity:.8"' : ''}>${h(s)}</div>` : ''}` : '<span class="faint">—</span>'}</td>`; };
  const err=(ppData.errors||[]).map(e=>`<div class="note warn"><b>${h(e.error)}</b> — ${e.days.length} ditë (${e.days.map(fmtDateAl).join(', ')}): kjo kolonë nuk është e plotë për ato ditë.${/auth_expired/.test(e.error)? ' Hap deliveryplatform.gjirafamall.com në Chrome që sesioni të rinovohet, pastaj shtyp «Shfaq».' : ''}</div>`).join('');
  body.innerHTML= err + `<div class="card"><h3 style="margin-top:0">${h(fmtDateAl(ppData.from))}${ppData.to!==ppData.from? ' – '+h(fmtDateAl(ppData.to)) : ''} <span class="sub">${ops.length} operatorë · ${ppData.days} ditë</span></h3>
    <div class="tablewrap"><table><thead><tr><th>Emri dhe Mbiemri</th>${PP_COLS.map(c=>`<th class="num"${c[0]==='checkout'? ' style="'+PP_CO_STYLE+'"' : ''}>${h(c[1])}</th>`).join('')}<th class="num">Ditë aktive</th></tr></thead>
    <tbody>${ops.length? ops.map(o=>`<tr><td><b>${h(o.name)}</b></td>${PP_COLS.map(c=>cell(o,c)).join('')}<td class="num">${o.days}</td></tr>`).join('')
      : `<tr><td colspan="${PP_COLS.length+2}"><div class="empty">Asnjë aktivitet i stafit në këtë periudhë.</div></td></tr>`}
      ${ops.length? `<tr style="border-top:2px solid var(--line)"><td><b>Gjithsej</b></td>${PP_COLS.map(c=>cell(tot,c)).join('')}<td></td></tr>` : ''}</tbody></table></div>
    <div class="hint" style="margin-top:8px"><b>Claim</b> = produkte të rezervuara për një porosi (WMS, log 3 me porosi — kuptim i nxjerrë nga të dhënat). <b>Picking</b> = produkte të skanuara në sesionet e picking-ut (databaza e WMS, rifreskim çdo orë 07–22). <b>Check-out</b> = porosi me check-out (porosi të ndryshme në log 4 + 18, si te Statistikat e WH). <b>POD</b> = porosi të skanuara për kurierët (Delivery Platform). <b>Check-In</b> = produkte të pranuara (log 2). <b>Mapping</b> = produkte të vendosura në raft (log 7). <b>Kthime/Refuzime</b> = porosi të refuzuara të pranuara (Delivery Platform) + produkte të kthyera të procesuara (WMS 20/21/22/29). Vetëm llogaritë e stafit të depos; llogaritë temp dhe ato pa emër nuk numërohen. Shifrat janë për planifikim dhe zhvillim, jo për masa disiplinore.</div></div>`;
}
