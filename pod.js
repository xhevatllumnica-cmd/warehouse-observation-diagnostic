/* =========================================================================
   POD — PROOF OF DELIVERY (Flows), live from the Delivery Platform (deliveryplatform.gjirafamall.com).
   The agent's /delivery/pod?date=YYYY-MM-DD reads, read-only, the platform's own POD lists:
     deliveries = one courier's batch for the day (status, POD close time)
     items      = the orders in each delivery: item status (waiting / dispatched / delivered …), order status,
                  POD / delivered times, payment method, amount due vs cash accepted, packages scanned, >24h flags
   Customer data (name, phone, e-mail, address, signature, comments) never reaches the app — the agent drops it.
   Session: the Chrome extension passes the Delivery Platform login to the agent (same as WMS).
   Loaded after shared.js and before app.js; uses app.js / inbound.js helpers at call time.
   =======================================================================*/
let podDate=null, podData=null, podView='all', podQuery='', podSeq=0, podMode='day', podPend=null;
const podT=s=> s? new Date(String(s).replace(' ','T')) : null;
const podHM=s=> s? String(s).slice(11,16) : '—';
const podWhen=s=> !s? '—' : String(s).slice(0,10)===todayStr()? podHM(s) : String(s).slice(8,10)+'.'+String(s).slice(5,7)+' '+podHM(s);
const podMoney=v=> v==null||v===''? '—' : Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
/* item statuses as the platform writes them (10/2026): "Është dorëzuar" = delivered; "Duke u dorëzuar", "Është nisur",
   "Në postë" = on the way; "Është pranuar në pikën e marrjes" = at a pickup point (not yet with the customer);
   "Duke pritur për dërgim", "Dergesë në depo" = not yet left; "…refuzuar…" = refused. Unknown → waiting. */
const podSt=x=> String(x.deliveryItemStatus||'').trim();
const isDelivered=x=> /^është dorëzuar$|^delivered$/i.test(podSt(x));
const isRefused=x=> x.processStatusRefused===true || /refuz|kthy|anul/i.test(podSt(x)+' '+(x.orderStatus||''));
const isPickupPoint=x=> /pikën e marrjes|pickup point/i.test(podSt(x));
const isInTransit=x=> !isDelivered(x) && !isRefused(x) && (isPickupPoint(x) || /nisur|duke u dorëzuar|postë|poste|rrug|transit/i.test(podSt(x)));
const isWaiting=x=> !isDelivered(x) && !isRefused(x) && !isInTransit(x);
const isOutbound=x=> !x.type || /^outbound$/i.test(x.type);
const isCash=x=> /cash|para në dorë|kesh/i.test(x.paymentMethod||'');
/* cash collected for a delivered cash order: what the courier recorded, or the full amount when the platform marks the
   order paid / its fund received (seen 10/2026: cashAccepted 0 but isPaid and processStatusFundReceived true) */
const podCollected=x=> (+x.cashAccepted||0)>0? +x.cashAccepted : (x.isPaid||x.processStatusFundReceived)? (+x.price||0) : 0;
function podFlags(x){
  const f=[];
  if(isRefused(x)) f.push(['crit','refuzuar / kthyer']);
  if(isDelivered(x) && isCash(x) && x.price>0 && podCollected(x)+0.009<x.price) f.push(['crit','cash i arkëtuar '+podMoney(podCollected(x))+' nga '+podMoney(x.price)+' (pa shënim pagese)']);
  if(x.moreThan24HENisur) f.push(['warn','> 24h e nisur pa u dorëzuar']);
  if(x.moreThan24HNePoste) f.push(['warn','> 24h në postë']);
  if(x.packagesTotal>0 && x.packagesScanned!=null && x.packagesScanned<x.packagesTotal) f.push(['warn','paketa të skanuara '+x.packagesScanned+' / '+x.packagesTotal]);
  if(x.numberOfDaysToDeliverOrder!=null && x.numberOfDaysToDeliverOrder>3 && !isDelivered(x)) f.push(['warn',x.numberOfDaysToDeliverOrder+' ditë pa u dorëzuar']);
  return f;
}

function renderPod(v){
  if(!podDate) podDate=todayStr();
  v.innerHTML=pagehead('POD — Proof of Delivery','Dërgesat e kurierëve dhe dorëzimi i porosive, live nga Delivery Platform-i (deliveryplatform.gjirafamall.com): sa porosi janë dorëzuar, në rrugë, në pritje ose të refuzuara, pagesat cash dhe vonesat. Të dhënat personale të klientëve (emri, telefoni, adresa, nënshkrimi) nuk merren fare.')
    + `<div class="btnrow no-print" style="margin-bottom:10px"><button class="btn sm ${podMode==='day'?'primary':''}" data-podmode="day">📦 Dërgesat sipas datës</button><button class="btn sm ${podMode==='posts'?'primary':''}" data-podmode="posts">🏤 Postat — në pritje</button></div>
      <div class="card no-print" style="margin-bottom:14px;${podMode==='posts'?'display:none':''}"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn sm" id="podToday">Sot</button><button class="btn sm" id="podYest">Dje</button>
        <input type="date" id="podDate" value="${h(podDate)}" max="${h(todayStr())}" style="width:auto;min-height:34px">
        <button class="btn sm" id="podRefresh">↻ Rifresko</button>
        <span id="podAt" class="small faint" style="margin-left:auto"></span></div></div>
      <div id="podBody"><div class="empty">Po ngarkohet…</div></div>`;
  const set=d=>{ podDate=d; $('#podDate').value=d; loadPod(); };
  $('#podToday').onclick=()=>set(todayStr());
  $('#podYest').onclick=()=>{ const d=new Date(); d.setDate(d.getDate()-1); set(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')); };
  $('#podDate').onchange=e=>set(e.target.value||todayStr());
  $('#podRefresh').onclick=()=>loadPod();
  $$('[data-podmode]').forEach(b=>b.onclick=()=>{ podMode=b.dataset.podmode; renderPod(v); });
  if(podMode==='posts') loadPodPosts(false); else loadPod();
}
async function loadPod(){
  const box=$('#podBody'); if(!box) return;
  if(!wmsOnAgent()){ box.innerHTML='<div class="empty">Hape app-in nga http://localhost:8790.</div>'; return; }
  box.innerHTML='<div class="empty">Po lexohen dërgesat nga Delivery Platform-i… (për një ditë të plotë mund të zgjasë 10–20 sekonda)</div>';
  const seq=++podSeq;
  try{ const r=await fetch('/delivery/pod?date='+encodeURIComponent(podDate),{cache:'no-store'}); const j=await r.json(); if(seq!==podSeq) return;
    if(j.error==='auth_expired'){ box.innerHTML=`<div class="card"><div class="empty">Sesioni i Delivery Platform-it te agjenti ka skaduar.<br>Hape <b>deliveryplatform.gjirafamall.com</b> në Chrome (ku është extension-i "WMS Agent Link") dhe kyçu — sesioni i kalon agjentit vetë; pastaj shtyp ↻ Rifresko.</div></div>`; return; }
    if(!r.ok||j.error){ box.innerHTML=`<div class="empty">${h(j.error||('HTTP '+r.status))}</div>`; return; }
    podData=j; drawPod();
  }catch(e){ if(seq===podSeq) box.innerHTML=`<div class="empty">Agjenti s'përgjigjet (${h(e.message)}).</div>`; }
}
function drawPod(){
  const box=$('#podBody'); if(!box||!podData) return;
  const j=podData, items=j.items.map(x=>Object.assign({}, x, {flags:podFlags(x)}));
  const atEl=$('#podAt'); if(atEl) atEl.innerHTML=`Lexuar: <b>${h(new Date(j.at).toLocaleTimeString())}</b>${j.failed&&j.failed.length?` · <span style="color:var(--warn)">${j.failed.length} dërgesa s'u lexuan</span>`:''}`;
  if(!j.deliveries.length){ box.innerHTML=`<div class="card"><div class="empty">S'ka dërgesa në Delivery Platform për ${h(fmtDateAl(j.date))}.</div></div>`; return; }
  // delivery KPIs count customer deliveries (Outbound); returns / pickups are shown apart
  const out=items.filter(isOutbound), other=items.length-out.length;
  const n=out.length, del=out.filter(isDelivered).length, tr=out.filter(isInTransit).length, wt=out.filter(isWaiting).length, rf=out.filter(isRefused).length, pp=out.filter(isPickupPoint).length;
  const cash=out.filter(x=>isCash(x)&&isDelivered(x)), due=cash.reduce((a,x)=>a+(+x.price||0),0), got=cash.reduce((a,x)=>a+podCollected(x),0);
  const late=items.filter(x=>x.moreThan24HENisur||x.moreThan24HNePoste).length;
  const kpis=`<div class="grid g-kpi" style="margin-bottom:12px">
      ${kpiCard(j.deliveries.length,'Dërgesa (kurierë × ditë)',`${new Set(j.deliveries.map(d=>d.driver)).size} kurierë`)}
      ${kpiCard(fmtNum(n),'Porosi për dorëzim',`${fmtNum(del)} të dorëzuara${other?` · +${other} kthime / pickup`:''}`)}
      ${kpiCard(n? Math.round(del/n*100)+'%' : '—','Shkalla e dorëzimit',`${fmtNum(tr)} në rrugë${pp?` (${pp} në pikë marrjeje)`:''} · ${fmtNum(wt)} pa u nisur`, j.date<todayStr()? (n&&del/n<0.8?'warn':'ok') : '')}
      ${kpiCard(fmtNum(rf),'Të refuzuara / kthyera', n? Math.round(rf/n*100)+'% e porosive' : '', rf?'warn':'')}
      ${kpiCard(podMoney(got),'Cash i arkëtuar',`nga ${podMoney(due)} për t'u paguar (porositë cash të dorëzuara)`, got+0.01<due?'warn':'')}
      ${kpiCard(late,'Vonesa > 24h','e nisur ose në postë mbi 24 orë', late?'crit':'')}
    </div>`;
  // per courier
  const by={}; items.forEach(x=>{ const k=x.driverName||'—'; const b=by[k]||(by[k]={n:0,del:0,tr:0,wt:0,rf:0,due:0,got:0,late:0}); b.n++; if(isDelivered(x)) b.del++; else if(isRefused(x)) b.rf++; else if(isInTransit(x)) b.tr++; else b.wt++;
    if(isCash(x)&&isDelivered(x)){ b.due+=+x.price||0; b.got+=podCollected(x); } if(x.moreThan24HENisur||x.moreThan24HNePoste) b.late++; });
  const dByDriver={}; j.deliveries.forEach(d=>{ const k=d.driver; (dByDriver[k]=dByDriver[k]||[]).push(d); });
  const courier=`<div class="card" style="margin-bottom:12px"><h3>Sipas kurierit</h3><div style="overflow-x:auto"><table style="font-size:12.5px"><thead><tr><th>Kurieri</th><th>Dërgesa</th><th>POD i mbyllur</th><th>Porosi</th><th>Dorëzuar</th><th>Në rrugë</th><th>Në pritje</th><th>Refuzuar</th><th>Shkalla</th><th>Cash arkëtuar / për pagesë</th><th>> 24h</th></tr></thead><tbody>
      ${Object.entries(by).sort((a,b)=>b[1].n-a[1].n).map(([k,b])=>{ const ds=Object.entries(dByDriver).find(([dk])=>dk && k && dk.toLowerCase().includes(String(k).toLowerCase().split(' ')[0]))?.[1]||[];
        const pods=ds.map(d=>d.pod).filter(Boolean).sort(); const rate=b.n? Math.round(b.del/b.n*100) : 0;
        return `<tr><td><b>${h(k)}</b></td><td>${ds.length||'—'}</td><td class="small">${pods.length? podHM(pods[0])+(pods.length>1?'–'+podHM(pods[pods.length-1]):'') : '—'}</td><td>${b.n}</td><td>${b.del}</td><td>${b.tr}</td><td>${b.wt}</td>
          <td>${b.rf? `<span style="color:var(--warn)">${b.rf}</span>` : 0}</td><td style="${rate<80?'color:var(--warn)':''}"><b>${rate}%</b></td>
          <td class="small">${b.due? podMoney(b.got)+' / '+podMoney(b.due) : '—'}${b.got+0.01<b.due?' ⚠':''}</td><td>${b.late? `<span style="color:var(--crit)">${b.late}</span>` : 0}</td></tr>`; }).join('')}
    </tbody></table></div></div>`;
  // orders
  const views=[['all','Të gjitha',items.length],['transit','Në rrugë',tr],['waiting','Në pritje',wt],['delivered','Dorëzuar',del],['refused','Refuzuar',rf],['issues','Me probleme',items.filter(x=>x.flags.length).length]];
  const pick= podView==='transit'? isInTransit : podView==='waiting'? isWaiting : podView==='delivered'? isDelivered : podView==='refused'? isRefused : podView==='issues'? (x=>x.flags.length>0) : (()=>true);
  const q=podQuery.trim().toLowerCase();
  const rows=items.filter(pick).filter(x=>!q || [x.orderId, x.driverName, x.deliveryId, x.city, x.platform].join(' ').toLowerCase().includes(q));
  const stColor=x=> isDelivered(x)? 'var(--ok)' : isRefused(x)? 'var(--crit)' : isInTransit(x)? 'var(--accent)' : 'var(--warn)';
  const orders=`<div class="card"><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <h3 style="margin:0 10px 0 0">Porositë</h3>${views.map(([k,l,c])=>`<span class="chip ${podView===k?'on':''}" data-podv="${k}">${l} <b style="margin-left:5px">${c}</b></span>`).join('')}
      <input id="podSearch" placeholder="Kërko porosi / kurier / qytet…" value="${h(podQuery)}" style="margin-left:auto;max-width:240px;min-height:38px"></div>
    <div style="overflow-x:auto"><table style="font-size:12.5px"><thead><tr><th>Porosia</th><th>Kurieri</th><th>Dërgesa</th><th>Statusi i dorëzimit</th><th>Statusi i porosisë</th><th>Në POD</th><th>Dorëzuar</th><th>Pagesa</th><th>Për pagesë / pranuar</th><th>Paketa</th><th>Qyteti</th><th>Probleme</th></tr></thead><tbody>
      ${rows.slice(0,400).map(x=>`<tr><td><b>${h(x.orderId)}</b><div class="small faint">${h(x.platform||'')}${x.type&&x.type!=='Outbound'?' · '+h(x.type):''}</div></td>
        <td class="small">${h(x.driverName||'—')}</td><td class="small">#${h(x.deliveryId)}</td>
        <td class="small"><span style="color:${stColor(x)};font-weight:600">${h(x.deliveryItemStatus||'—')}</span></td><td class="small">${h(x.orderStatus||'—')}</td>
        <td class="small">${podWhen(x.insertedInPodDate)}</td><td class="small">${podWhen(x.deliveredDate)}</td><td class="small">${h(x.paymentMethod||'—')}</td>
        <td class="small">${podMoney(x.price)}${isCash(x)&&isDelivered(x)?' / '+podMoney(podCollected(x)):''}</td>
        <td class="small">${x.packagesTotal? (x.packagesScanned??'—')+' / '+x.packagesTotal : (x.packages||'—')}</td><td class="small">${h(x.city||'—')}</td>
        <td>${x.flags.length? `<span class="badge ${x.flags.some(f=>f[0]==='crit')?'b-crit':'b-warn'}" title="${h(x.flags.map(f=>f[1]).join(' · '))}">${h(x.flags[0][1])}${x.flags.length>1?' +'+(x.flags.length-1):''}</span>` : '<span class="faint">—</span>'}</td></tr>`).join('')}
    </tbody></table></div>${rows.length>400?`<div class="hint">Shfaqen 400 nga ${rows.length} — përdor filtrat ose kërkimin.</div>`:''}</div>`;
  const batches=`<details class="card" style="margin-top:12px"><summary style="cursor:pointer"><b>Dërgesat e ditës</b> <span class="sub">${j.deliveries.length} — një dërgesë = batch-i i një kurieri</span></summary>
      <div style="overflow-x:auto;margin-top:8px"><table style="font-size:12.5px"><thead><tr><th>Dërgesa</th><th>Kurieri</th><th>Statusi</th><th>Data</th><th>POD i mbyllur</th><th>Porosi</th><th>Dorëzuar</th></tr></thead><tbody>
      ${j.deliveries.map(d=>{ const it=items.filter(x=>x.deliveryId===d.id); return `<tr><td>#${h(d.id)} <span class="small faint">${h(d.uid||'')}</span></td><td>${h(d.driver||'—')}</td><td>${h(d.status||'—')}</td>
        <td class="small">${h(fmtDateAl(String(d.date||'').slice(0,10)))}</td><td class="small">${podWhen(d.pod)}</td><td>${it.length}</td><td>${it.filter(isDelivered).length}</td></tr>`; }).join('')}
      </tbody></table></div></details>`;
  box.innerHTML=kpis+courier+orders+batches
    + `<div class="hint" style="margin-top:8px">Burimi: Delivery Platform-i, live (rifreskohet kur hap faqen; ditët e kaluara ruhen 6 orë). <b>Dërgesa</b> = batch-i i porosive që një kurier merr për një ditë; <b>POD i mbyllur</b> = koha kur u mbyll dërgesa. Statuset vijnë ashtu siç i shkruan platforma. <b>Cash</b> krahason shumën e pranuar me shumën për pagesë te porositë cash të dorëzuara. Të dhënat personale të klientëve nuk lexohen nga app-i.</div>`;
  $$('[data-podv]').forEach(c=>c.onclick=()=>{ podView=c.dataset.podv; drawPod(); });
  const si=$('#podSearch'); if(si){ si.oninput=e=>{ podQuery=e.target.value; clearTimeout(si._t); si._t=setTimeout(()=>{ drawPod(); const nn=$('#podSearch'); if(nn){ nn.focus(); nn.setSelectionRange(nn.value.length,nn.value.length); } },250); }; }
}

/* "Postat — në pritje": one card per courier with the orders still waiting to be sent for the final POD (Delivery
   Platform, the POD deliveries of the last days — /pod/pending). Classified by payment and by order age; orders older
   than 3 days in red, except those with a fixed date, bank transfer, or online payment not yet made. */
const POD_PAY_ORDER=['Cash','POS','Kartë / online','Bank transfer','Pa metodë'];
const POD_POST_COLORS=[[/^beki/i,'#e67e22'],[/^express/i,'#115b92'],[/^fiks/i,'#1e8449'],[/^merre/i,'#8e44ad'],[/^starlink/i,'#0e8c95'],[/^boxes/i,'#b7950b'],[/^pick ?up ?point/i,'#c0392b']];
const podPostColor=(name,i)=>{ const m=POD_POST_COLORS.find(([re])=>re.test(name||'')); return m? m[1] : ['#5d6d7e','#a04000','#2471a3','#7d3c98'][i%4]; };
const podPayGroupC=pm=>{ const s=String(pm||''); if(!s) return 'Pa metodë'; if(/bank transfer/i.test(s)) return 'Bank transfer'; if(/^cash/i.test(s)) return 'Cash'; if(/^pos/i.test(s)) return 'POS'; if(/credit|card|online/i.test(s)) return 'Kartë / online'; return s; };
async function loadPodPosts(force){
  const box=$('#podBody'); if(!box) return;
  if(!wmsOnAgent()){ box.innerHTML='<div class="empty">Hape app-in nga http://localhost:8790.</div>'; return; }
  box.innerHTML='<div class="empty">Po lexohen dërgesat e ditëve të fundit nga Delivery Platform-i… (herën e parë deri në 3–4 minuta)</div>';
  const seq=++podSeq;
  try{ const r=await fetch('/pod/pending'+(force?'?refresh=1':''),{cache:'no-store'}); const j=await r.json(); if(seq!==podSeq) return;
    if(!r.ok){ box.innerHTML='<div class="empty">'+h(j.error||('HTTP '+r.status))+'</div>'; return; }
    podPend=j; drawPodPosts();
  }catch(e){ if(seq===podSeq) box.innerHTML='<div class="empty">Agjenti nuk përgjigjet ('+h(e.message)+').</div>'; }
}
function drawPodPosts(){
  const box=$('#podBody'), j=podPend; if(!box||!j) return;
  const ages=j.ageLabels||['0–1 ditë','2–3 ditë','> 3 ditë'], red='color:var(--crit);font-weight:800';
  const head=`<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
      <span>Në pritje gjithsej: <b>${j.total}</b></span><span style="${j.old?red:''}">Mbi 3 ditë: ${j.old}</span>
      ${j.operator? '<span>POD sot: <b>'+h(j.operator)+'</b></span>' : ''}
      <span class="small faint">Dërgesat ${h(fmtDateAl(j.from))} – ${h(fmtDateAl(j.to))} · lexuar ${h(new Date(j.at).toLocaleTimeString())}</span>
      <span class="small ${j.chat&&j.chat.enabled?'':'faint'}" style="margin-left:auto">Google Chat: ${j.chat&&j.chat.enabled? 'çdo 30 min '+h(j.chat.marks[0])+'–'+h(j.chat.marks[j.chat.marks.length-1]) : 'jo aktiv ende'}</span>
      <button class="btn sm" id="podPostsRefresh">↻ Rifresko</button><button class="btn sm" id="podPostsOpen">↗ Hap si faqe më vete</button></div>
      ${j.error? '<div class="small" style="color:var(--warn);margin-top:6px">Disa ditë nuk u lexuan nga Delivery Platform ('+h(j.error)+').</div>' : ''}
      <details class="no-print" style="margin-top:8px" ${j.chat&&j.chat.target==='pod'? '' : 'open'}><summary class="small" style="cursor:pointer"><b>⚙ Google Chat për POD</b> — ${j.chat&&j.chat.target==='pod'? '<span style="color:var(--ok)">aktiv: hapësira e POD-it, '+h(j.chat.marks.join(', '))+'</span>' : 'vendos webhook-un e hapësirës ku është operatori i POD-it'}</summary>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
          <input type="password" id="podHook" autocomplete="off" placeholder="${j.chat&&j.chat.target==='pod'? 'webhook-u është ruajtur — ngjit një të ri për ta ndërruar' : 'https://chat.googleapis.com/v1/spaces/…/messages?key=…'}" style="flex:1;min-width:280px;min-height:34px">
          <button class="btn sm primary" id="podHookSave">Ruaj</button>
          ${j.chat&&j.chat.target==='pod'? '<button class="btn sm" id="podHookTest">Dërgo mesazh prove</button><button class="btn sm ghost" id="podHookDel">Hiqe</button>' : ''}</div>
        <div class="hint">Webhook-u ruhet vetëm te agjenti (jo në app dhe jo në git) dhe nuk shfaqet më pas. Mesazhet dërgohen vetë në oraret e mësipërme, një herë për secilën orë.</div></details></div>`;
  const card=(P,i)=>{ const c=podPostColor(P.name,i);
    const oldBy={}; P.oldList.forEach(o=>{ const g=podPayGroupC(o.pay); oldBy[g]=(oldBy[g]||0)+1; });
    const groups=POD_PAY_ORDER.filter(g=>P.pay[g]).concat(Object.keys(P.pay).filter(g=>!POD_PAY_ORDER.includes(g)));
    const cell=(g,a)=>{ const n=P.matrix[g+'|'+a]||0; if(a!==ages[2]) return n||'<span class="faint">—</span>';
      const r=oldBy[g]||0, ex=n-r; return (r? '<span style="'+red+'">'+r+'</span>' : '<span class="faint">0</span>')+(ex>0? ' <span class="faint" title="mbi 3 ditë, por me datë fikse / bank transfer / pa paguar">(+'+ex+')</span>' : ''); };
    const exTxt=[P.excluded.fixed? 'datë fikse '+P.excluded.fixed : '', P.excluded.bank? 'bank transfer '+P.excluded.bank : '', P.excluded.unpaid? 'pa paguar '+P.excluded.unpaid : ''].filter(Boolean).join(' · ');
    const oldRows=P.oldList.map(o=>'<tr><td><b style="'+red+'">#'+h(o.id)+'</b> <span class="faint">'+h(o.pf)+'</span></td><td style="'+red+'">'+o.days+'</td><td class="small">'+h(o.pay||'—')+'</td><td class="small">'+h(fmtDateAl(o.created))+'</td><td class="small">'+h(fmtDateAl(o.dd))+'</td></tr>').join('');
    return `<div class="card" style="margin:0;border-left:6px solid ${c};border-color:color-mix(in srgb,${c} 35%,var(--line));border-left-color:${c};background:linear-gradient(180deg,color-mix(in srgb,${c} 16%,var(--panel)),color-mix(in srgb,${c} 6%,var(--panel)))"><div style="font-weight:800;font-size:16px;color:color-mix(in srgb,${c} 75%,var(--text))">${h(P.name==='Merre'? 'Merre vet' : P.name)}</div>
      <div style="display:flex;gap:18px;align-items:flex-end;margin:6px 0 10px"><div><div style="font-size:34px;font-weight:800;line-height:1">${P.total}</div><div class="small faint">NË PRITJE</div></div>
        ${P.old? '<div><div style="font-size:26px;line-height:1;'+red+'">'+P.old+'</div><div class="small" style="'+red+'">mbi 3 ditë</div></div>' : ''}</div>
      <table style="font-size:12px"><thead><tr><th>Pagesa</th>${ages.map(a=>'<th>'+h(a)+'</th>').join('')}<th>Gjithsej</th></tr></thead><tbody>
        ${groups.map(g=>'<tr><td>'+h(g)+'</td>'+ages.map(a=>'<td>'+cell(g,a)+'</td>').join('')+'<td><b>'+P.pay[g]+'</b></td></tr>').join('')}</tbody></table>
      ${exTxt? '<div class="small faint" style="margin-top:6px">Mbi 3 ditë, por jo me të kuqe: '+exTxt+'</div>' : ''}
      ${P.oldList.length? '<details style="margin-top:6px"><summary class="small" style="cursor:pointer;'+red+'">Porositë mbi 3 ditë ('+P.oldList.length+')</summary><table style="font-size:11.5px;margin-top:4px"><thead><tr><th>Porosia</th><th>Ditë</th><th>Pagesa</th><th>Krijuar</th><th>Dërgesa</th></tr></thead><tbody>'+oldRows+'</tbody></table></details>' : ''}</div>`; };
  box.innerHTML=head+(j.posts.length? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px">'+j.posts.map(card).join('')+'</div>' : '<div class="card"><div class="empty">Asnjë porosi në pritje.</div></div>')
    +'<div class="hint" style="margin-top:8px">Në pritje = statusi "Duke pritur për dërgim" në dërgesat POD të ditëve të fundit (një porosi e pa nisur mbetet në dërgesën e vjetër); mosha = nga krijimi i porosisë. Me të kuqe: mbi 3 ditë, pa ato me datë fikse, me bank transfer ose me pagesë online ende të papaguar. Cash dhe POS paguhen në dorëzim. Në kolonën "> 3 ditë", numri në kllapa = të përjashtuarat.</div>';
  const rb=$('#podPostsRefresh'); if(rb) rb.onclick=()=>loadPodPosts(true);
  const ob=$('#podPostsOpen'); if(ob) ob.onclick=()=>window.open('/postat','postat');
  const saveHook=async url=>{ try{ const r=await fetch('/pod/chat-webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}); const x=await r.json();
      if(!r.ok) return toast(x.error||'Nuk u ruajt'); toast(url? 'Webhook-u i POD-it u ruajt' : 'Webhook-u u hoq'); loadPodPosts(false); }catch(e){ toast('Agjenti nuk përgjigjet'); } };
  const hs=$('#podHookSave'); if(hs) hs.onclick=()=>{ const u=($('#podHook').value||'').trim(); if(!u) return toast('Ngjit webhook-un e Google Chat'); saveHook(u); };
  const hd=$('#podHookDel'); if(hd) hd.onclick=()=>saveHook('');
  const ht=$('#podHookTest'); if(ht) ht.onclick=async()=>{ ht.disabled=true; try{ const r=await fetch('/pod/chat-test',{method:'POST'}); const x=await r.json(); toast(r.ok? 'Mesazhi prove u dërgua — shiko hapësirën e POD-it' : (x.error||'Dështoi')); }catch(e){ toast('Agjenti nuk përgjigjet'); } ht.disabled=false; };
}
