/* =========================================================================
   ORDER FLOW OBSERVATION — automatic part, from WMS (warehouse 01).
   /pulse/data → orders (query block G in pulse/queries.sql, refreshed hourly with WMS Pulse):
     done  = orders checked out today      wait = orders with units reserved (unit status 3) but not checked out
     daily = 14-day trend                  unmaps = units released from orders per day
   Stages WMS actually records for an order:
     Created  = Orders.CreatedOnUtc (local time)
     Items ready = the last unit reserved for the order (LogType 3 — cross-dock units, at their check-in);
                   units taken from stock have no reservation log, they are ready from the start
     Check-out   = first → last scan at the check-out station (LogType 27, then 9/4/18 in the same seconds)
   WMS has no separate Claim / Picking / Boxing / Dispatch events, so those stay manual observations: a manual
   observation can be attached to a WMS order (Store 'orders' record with wmsId = "orderId-platform").
   Loaded after shared.js and before app.js; uses app.js / inbound.js helpers at call time.
   =======================================================================*/
let ordWms=null, ordView='done', ordQuery='', ordOpen=null, ordSeq=0;
const ORD_PL={1:'GjirafaMall',2:'Gjirafa50'};
const ORD_ST={23:'At showroom',25:'At warehouse / Local Seller',26:'Being shipped',37:'At courier DC'};
const ordKey=o=>o.id+'-'+o.p;
function ordSource(o){ if(!o.u) return '—'; if(!o.xu) return 'Nga stoku'; return o.xu>=o.u? 'Cross-dock' : 'Split ('+o.xu+' cross-dock + '+(o.u-o.xu)+' nga stoku)'; }
function ordReady(o){ return o.xu? o.a2 : o.cr; }                  // when the last item of the order was available
function ordDoneFlags(o){
  // the warehouse's own time is items ready → check-out (for cross-dock the time before that is the seller's)
  const f=[], wait=inbMin(ordReady(o),o.c1);
  if(o.q!=null && o.u<o.q) f.push(['crit',(o.q-o.u)+' njësi më pak se porosia ('+o.u+' / '+o.q+')']);
  if(o.q!=null && o.u>o.q) f.push(['warn',(o.u-o.q)+' njësi më shumë se porosia ('+o.u+' / '+o.q+')']);
  if(wait!=null && wait>24*60) f.push([wait>72*60?'crit':'warn', (o.xu? 'artikujt ishin gati, por prisnin ' : 'artikujt nga stoku, porosia priste ')+inbDur(wait)+' para check-out-it']);
  if(o.um>0) f.push(['warn',o.um+' lirime (unmap) të njësive të kësaj porosie']);
  return f.sort((x,y)=>(x[0]==='crit'?0:1)-(y[0]==='crit'?0:1));
}
function ordWaitFlags(o, now){
  const f=[], ageH=o.a1? (now-inbT(o.a1))/3600000 : null;
  if(ageH!=null && ageH>72) f.push(['crit','njësia e parë e caktuar prej '+inbDur(ageH*60)+' — porosia s\'ka dalë']);
  else if(ageH!=null && ageH>24) f.push(['warn','pret prej '+inbDur(ageH*60)]);
  if(o.q!=null && o.u+o.dn<o.q) f.push(['info','pret artikuj të tjerë: '+(o.u+o.dn)+' / '+o.q+' njësi në depo']);
  if(o.dn>0) f.push(['warn','pjesërisht e dërguar: '+o.dn+' njësi kanë dalë, '+o.u+' presin']);
  if(o.um>0) f.push(['warn',o.um+' lirime (unmap)']);
  if(!o.l) f.push(['warn','porosia s\'ka rreshta në WMS (OrderDetails) — kontrollo nëse është anuluar']);
  return f.sort((x,y)=>({crit:0,warn:1,info:2}[x[0]])-({crit:0,warn:1,info:2}[y[0]]));
}

function ordersWmsHTML(){
  return `<div class="card" style="margin-bottom:14px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <h3 style="margin:0">🧾 Porositë nga WMS <span class="sub">plotësohet automatikisht · depo 01</span></h3>
      <span id="ordAt" class="small faint" style="margin-left:auto"></span></div>
    <div id="ordWmsBody" style="margin-top:10px"><div class="empty">Po ngarkohet…</div></div></div>`;
}
async function loadOrdersWms(){
  const box=$('#ordWmsBody'); if(!box) return;
  if(!wmsOnAgent()){ box.innerHTML='<div class="empty">Hape app-in nga http://localhost:8790 që të shohësh porositë nga WMS.</div>'; return; }
  const seq=++ordSeq;
  try{ const r=await fetch('/pulse/data',{cache:'no-store'}); const j=await r.json(); if(seq!==ordSeq) return;
    if(!r.ok||j.error){ box.innerHTML=`<div class="empty">${h(j.error||('HTTP '+r.status))}</div>`; return; }
    if(!j.orders){ box.innerHTML='<div class="empty">Të dhënat e porosive s\'janë gjeneruar ende — vijnë me rifreskimin e radhës nga databaza e WMS-it (çdo orë).</div>'; return; }
    ordWms=j.orders; drawOrdersWms();
  }catch(e){ if(seq===ordSeq) box.innerHTML=`<div class="empty">Agjenti s'përgjigjet (${h(e.message)}).</div>`; }
}
function drawOrdersWms(){
  const box=$('#ordWmsBody'); if(!box||!ordWms) return;
  const now=new Date(), at=ordWms.at? new Date(ordWms.at) : null;
  const atEl=$('#ordAt'); if(atEl) atEl.innerHTML= at? `Lexuar nga WMS: <b style="${(now-at)/60000>150?'color:var(--warn)':''}">${h(at.toLocaleString())}</b> · rifreskohet çdo orë` : '';
  const done=ordWms.done.map(o=>Object.assign({}, o, {flags:ordDoneFlags(o)})), wait=ordWms.wait.map(o=>Object.assign({}, o, {flags:ordWaitFlags(o, now)}));
  const units=done.reduce((a,o)=>a+o.u,0), xdOnly=done.filter(o=>o.xu&&o.xu>=o.u).length, split=done.filter(o=>o.xu&&o.xu<o.u).length;
  const medOf=a=>{ const s=a.filter(x=>x!=null&&x>=0).sort((x,y)=>x-y); return s.length? s[Math.floor(s.length/2)] : null; };
  const med=medOf(done.map(o=>inbMin(o.cr,o.c1))), medWh=medOf(done.map(o=>inbMin(ordReady(o),o.c1)));
  const wUnits=wait.reduce((a,o)=>a+o.u,0), w3=wait.filter(o=>o.a1 && (now-inbT(o.a1))>72*3600000).length;
  const todayIso=todayStr(), umToday=((ordWms.unmaps||[]).find(x=>x.d===todayIso)||{}).n||0;
  const kpis=`<div class="grid g-kpi" style="margin-bottom:12px">
      ${kpiCard(done.length,'Porosi me check-out sot',`${fmtNum(units)} njësi`)}
      ${kpiCard(done.length? Math.round(xdOnly/done.length*100)+'%' : '—','Cross-dock',`nga stoku ${done.length-xdOnly-split} · split ${split}`)}
      ${kpiCard(medWh!=null? inbDur(medWh) : '—','Mediana gati → check-out','koha e depos: nga artikulli i fundit gati')}
      ${kpiCard(med!=null? inbDur(med) : '—','Mediana porosi → check-out','përfshin pritjen për mallin e shitësit')}
      ${kpiCard(wait.length,'Porosi në pritje',`${fmtNum(wUnits)} njësi të caktuara, pa check-out`, wait.length?'warn':'')}
      ${kpiCard(w3,'Në pritje > 3 ditë','njësia e parë e caktuar para 72 orësh', w3?'crit':'')}
      ${kpiCard(umToday,'Lirime (unmap) sot','njësi të liruara nga porositë', umToday?'warn':'')}
    </div>`;
  const by={}; done.forEach(o=>{ const k=o.w||'—'; const x=by[k]||(by[k]={n:0,u:0,first:o.c1,last:o.c1}); x.n++; x.u+=o.u; if(o.c1<x.first) x.first=o.c1; if(o.c1>x.last) x.last=o.c1; });
  const ops=Object.entries(by).sort((a,b)=>b[1].n-a[1].n);
  const opsHTML= ops.length? `<details style="margin-bottom:10px"><summary class="small" style="cursor:pointer"><b>Check-out sot sipas operatorit</b> — ${ops.length} operatorë</summary>
      <table style="font-size:12px;max-width:560px;margin-top:6px"><thead><tr><th>Operatori</th><th>Porosi</th><th>Njësi</th><th>Skanimi i parë</th><th>I fundit</th></tr></thead>
      <tbody>${ops.map(([n,x])=>`<tr><td>${h(n)}</td><td><b>${x.n}</b></td><td>${x.u}</td><td>${inbHM(x.first)}</td><td>${inbHM(x.last)}</td></tr>`).join('')}</tbody></table></details>` : '';
  const daily=ordWms.daily||[], um={}; (ordWms.unmaps||[]).forEach(x=>um[x.d]=x.n); const mxN=Math.max(1,...daily.map(d=>d.n));
  const trend= daily.length? `<details style="margin-bottom:12px"><summary class="small" style="cursor:pointer"><b>Trendi 14 ditë</b> — porosi me check-out, koha nga porosia te check-out-i, cross-dock dhe lirimet</summary>
      <div style="overflow-x:auto;margin-top:8px"><table style="font-size:12px;max-width:820px"><thead><tr><th>Data</th><th>Porosi</th><th></th><th>Njësi</th><th>Mediana porosi → check-out</th><th>Mesatarja</th><th>Cross-dock</th><th>Split</th><th>Lirime</th></tr></thead><tbody>
      ${daily.map(d=>`<tr><td>${h(fmtDateAl(d.d))} ${STATS_WEEKDAYS[(new Date(d.d+'T12:00:00').getDay()+6)%7]}</td><td>${d.n}</td>
        <td><span style="display:inline-block;height:7px;border-radius:3px;background:var(--accent);width:${Math.round(d.n/mxN*90)}px"></span></td>
        <td>${fmtNum(d.units)}</td><td>${d.h50!=null? inbDur(d.h50*60) : '—'}</td><td class="faint">${d.h!=null? inbDur(d.h*60) : '—'}</td>
        <td>${d.n? Math.round(d.xd/d.n*100)+'%' : '—'}</td><td>${d.split||0}</td><td>${um[d.d]||0}</td></tr>`).join('')}
      </tbody></table></div></details>` : '';
  const views=[['done','Me check-out sot',done.length],['wait','Në pritje',wait.length],['issues','Me probleme',done.filter(o=>o.flags.length).length+wait.filter(o=>o.flags.some(f=>f[0]!=='info')).length]];
  const chips=`<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      ${views.map(([k,l,n])=>`<span class="chip ${ordView===k?'on':''}" data-ordv="${k}">${l} <b style="margin-left:5px">${n}</b></span>`).join('')}
      <input id="ordSearch" placeholder="Kërko porosi / operator…" value="${h(ordQuery)}" style="margin-left:auto;max-width:240px;min-height:38px"></div>`;
  const q=ordQuery.trim().toLowerCase(), match=o=>!q || [o.id, o.w, ORD_PL[o.p]].join(' ').toLowerCase().includes(q);
  const notes=Store.col('orders').filter(o=>o.wmsId);
  const stName=s=> s==null? '—' : s+(ORD_ST[s]?' · '+ORD_ST[s]:'');
  const flagBadge=o=>{ const real=o.flags.filter(f=>f[0]!=='info'); return real.length? `<span class="badge ${real.some(f=>f[0]==='crit')?'b-crit':'b-warn'}">${real.length}</span>` : '<span class="faint">—</span>'; };
  const doneRow=o=>{ const k=ordKey(o), n=notes.filter(x=>x.wmsId===k).length;
    return `<tr data-ord="${h(k)}" style="cursor:pointer${ordOpen===k?';background:var(--panel2)':''}">
      <td><b>${h(o.id)}</b><div class="small faint">${h(ORD_PL[o.p]||o.p)}</div></td><td class="small">${h(stName(o.st))}</td>
      <td>${o.q!=null? o.u+' / '+o.q : o.u}</td><td class="small">${h(ordSource(o))}</td>
      <td class="small">${inbWhen(o.cr)}</td><td class="small">${o.xu? inbWhen(o.a2) : '<span class="faint">nga stoku</span>'}</td>
      <td class="small">${inbWhen(o.c1)}${o.c2&&o.c2!==o.c1?'–'+inbHM(o.c2):''}</td><td class="small">${h(o.w||'—')}</td>
      <td class="small">${inbDur(inbMin(o.cr,o.c1))}</td><td>${flagBadge(o)}${n?` <span title="vëzhgime">📝${n}</span>`:''}</td></tr>
      ${ordOpen===k? `<tr><td colspan="10" style="background:var(--panel2);padding:0">${ordDetail(o,true,notes.filter(x=>x.wmsId===k))}</td></tr>` : ''}`; };
  const waitRow=o=>{ const k=ordKey(o), ageH=o.a1? (now-inbT(o.a1))/3600000 : null;
    return `<tr data-ord="${h(k)}" style="cursor:pointer${ordOpen===k?';background:var(--panel2)':''}">
      <td><b>${h(o.id)}</b><div class="small faint">${h(ORD_PL[o.p]||o.p||'—')}</div></td><td class="small">${h(stName(o.st))}</td>
      <td>${o.u}${o.q!=null?' / '+o.q:''}</td><td>${o.dn||0}</td><td class="small">${inbWhen(o.cr)}</td>
      <td class="small">${inbWhen(o.a1)}${o.a2&&o.a2!==o.a1?'–'+inbWhen(o.a2):''}</td>
      <td class="small" style="${ageH>72?'color:var(--crit);font-weight:600':ageH>24?'color:var(--warn)':''}">${ageH!=null? inbDur(ageH*60) : '—'}</td>
      <td>${o.um||0}</td><td>${flagBadge(o)}</td></tr>
      ${ordOpen===k? `<tr><td colspan="9" style="background:var(--panel2);padding:0">${ordDetail(o,false,notes.filter(x=>x.wmsId===k))}</td></tr>` : ''}`; };
  let table;
  if(ordView==='wait'){ const rows=wait.filter(match);
    table=`<table style="font-size:12.5px"><thead><tr><th>Porosia</th><th>Statusi WMS</th><th>Njësi në depo / porosia</th><th>Dalë</th><th>Krijuar</th><th>Caktuar</th><th>Pret prej</th><th>Lirime</th><th>Probleme</th></tr></thead><tbody>${rows.map(waitRow).join('')}</tbody></table>`;
  } else {
    let rows= ordView==='issues'? done.filter(o=>o.flags.length) : done; rows=rows.filter(match);
    const wrows= ordView==='issues'? wait.filter(o=>o.flags.some(f=>f[0]!=='info')).filter(match) : [];
    table=`<table style="font-size:12.5px"><thead><tr><th>Porosia</th><th>Statusi WMS</th><th>Njësi / porosia</th><th>Burimi</th><th>Krijuar</th><th>Artikujt gati</th><th>Check-out</th><th>Operatori</th><th>Porosi → check-out</th><th>Probleme</th></tr></thead><tbody>${rows.slice(0,250).map(doneRow).join('')}</tbody></table>`
      + (wrows.length? `<h4 style="margin:14px 0 6px">Në pritje me probleme · ${wrows.length}</h4><table style="font-size:12.5px"><thead><tr><th>Porosia</th><th>Statusi WMS</th><th>Njësi në depo / porosia</th><th>Dalë</th><th>Krijuar</th><th>Caktuar</th><th>Pret prej</th><th>Lirime</th><th>Probleme</th></tr></thead><tbody>${wrows.map(waitRow).join('')}</tbody></table>` : '');
  }
  box.innerHTML=kpis+opsHTML+trend+chips+`<div style="overflow-x:auto">${table}</div>`
    + `<div class="hint" style="margin-top:8px">Burimi: WMS, depo 01. <b>Krijuar</b> = porosia në sistem; <b>Artikujt gati</b> = njësia e fundit e caktuar për porosinë (cross-dock: në check-in-in e saj; artikujt nga stoku janë gati që në fillim); <b>Check-out</b> = skanimi i parë → i fundit në stacionin e check-out-it (pas tij WMS shënon menjëherë dorëzimin / "Ready for delivery"). WMS nuk regjistron veçmas claim-in, picking-un nga rafti, boxing-un dhe dispatch-in — ato mbeten vëzhgime manuale (butoni te detajet e porosisë). <b>Në pritje</b> = porosi me njësi të caktuara (statusi 3) që s'kanë dalë ende.</div>`;
  $$('[data-ordv]').forEach(c=>c.onclick=()=>{ ordView=c.dataset.ordv; ordOpen=null; drawOrdersWms(); });
  const si=$('#ordSearch'); if(si){ si.oninput=e=>{ ordQuery=e.target.value; clearTimeout(si._t); si._t=setTimeout(()=>{ drawOrdersWms(); const n=$('#ordSearch'); if(n){ n.focus(); n.setSelectionRange(n.value.length,n.value.length); } },250); }; }
  $$('[data-ord]').forEach(r=>r.onclick=()=>{ ordOpen= ordOpen===r.dataset.ord? null : r.dataset.ord; drawOrdersWms(); });
  $$('[data-ordnote]').forEach(btn=>btn.onclick=e=>{ e.stopPropagation(); const o=done.concat(wait).find(x=>ordKey(x)===btn.dataset.ordnote); if(o) openOrderNote(o); });
}
function ordDetail(o, isDone, notes){
  const ready= isDone? ordReady(o) : o.a2, st=[['Porosia', o.cr], ['Artikujt gati', ready]].concat(isDone? [['Check-out', o.c1, o.c2]] : []);
  let prev=null;
  const chips=st.map(([l,t1,t2])=>{ const dur= prev&&t1? ' · +'+inbDur(inbMin(prev,t1)) : ''; if(t1) prev=t2||t1;
    return `<span class="${t1?'on':''}">${h(l)} ${t1? inbWhen(t1)+(t2&&t2!==t1?'–'+inbHM(t2):'') : '—'}${dur}</span>`; }).join('<i>›</i>');
  const kv=(k,v)=>`<span>${k}: <b>${v}</b></span>`;
  const flags=o.flags||[];
  return `<div style="padding:12px 14px">
    <div class="flowstrip" style="margin-bottom:10px">${chips}${isDone?'':'<i>›</i><span>Check-out — ende jo</span>'}</div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px" class="muted">
      ${kv('Platforma',h(ORD_PL[o.p]||o.p||'—'))} ${kv('Rreshta / njësi në porosi', (o.l||0)+' / '+(o.q!=null?o.q:'—'))}
      ${isDone? kv('Njësi me check-out',o.u)+kv('Burimi',h(ordSource(o)))+kv('Operatori',h(o.w||'—'))+kv('Porosi → check-out',inbDur(inbMin(o.cr,o.c1)))+(o.xu?kv('Gati → check-out',inbDur(inbMin(ready,o.c1))):'')
              : kv('Njësi të caktuara në depo',o.u)+kv('Kanë dalë',o.dn||0)}
      ${o.um? kv('Lirime (unmap)',o.um) : ''}
    </div>
    ${flags.length? `<div class="note ${flags.some(f=>f[0]==='crit')?'crit':''}" style="margin-top:8px"><span class="etag et-data">nga WMS</span>${flags.map(f=>h(f[1])).join(' · ')}</div>` : '<div class="note" style="margin-top:8px">Asnjë problem i gjetur në WMS.</div>'}
    ${notes.map(n=>`<div class="note" style="margin-top:6px"><span class="etag et-obs">vëzhgim</span> ${h(n.date||'')}${n.picker?' · '+h(empName(n.picker)):''}${n.fulfillment?' · '+h(n.fulfillment):''}${n.note?' · '+h(n.note):''}${n.stamps&&Object.keys(n.stamps).length?' · etapa të shënuara: '+Object.keys(n.stamps).map(h).join(', '):''}</div>`).join('')}
    <div class="btnrow" style="margin-top:10px"><button class="btn sm" data-ordnote="${h(ordKey(o))}">📝 Shto vëzhgim (claim / picking / boxing)</button></div>
  </div>`;
}
/* a manual observation on a WMS order → an ordinary Order Flow record (Store 'orders') linked by wmsId */
function openOrderNote(o){
  const src= !o.xu? 'From stock (picked)' : o.xu>=o.u? 'Cross-dock (staged to check-out)' : 'Split — stock + cross-dock';
  openOrderForm(null, { wmsId:ordKey(o), orderRef:String(o.id)+' ('+(ORD_PL[o.p]||o.p)+')', date:todayStr(), lines:o.l||null, units:o.q!=null? o.q : o.u, fulfillment:src,
    note: o.w? 'Check-out në WMS: '+o.w+' '+inbWhen(o.c1) : '' });
}
