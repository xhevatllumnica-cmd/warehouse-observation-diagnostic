/* =========================================================================
   KAPACITETI & STAFI — workforce capacity, recomputed automatically.
   Inputs:
     WMS (via /pulse/data → capacity, query blocks H/I/J, refreshed hourly with WMS Pulse; rolling 12 / 8 weeks):
       created orders per day (+ after 17:30), staff volumes per day (check-in / map / check-out units), orders
       checked out per day, weekday coverage by hour, operators (initials + last 3 digits of the WMS id), same-day
       dispatch per week, the latest piece-rate period, WMS AverageTimeSeconds.
     Observation System (live): standard times per step from Process Measurement (labour seconds per unit / order).
     Settings (Store.db.config.capacity): productive hours, target utilisation, absence rate, roster, presence,
       target orders/day, assumptions for steps without measurements, optional hourly cost.
   FTE = Σ (volume × standard time) ÷ (productive hours × utilisation), then ÷ (1 − absence rate).
   Individual numbers are for planning and development, not for discipline.
   Loaded after shared.js and before app.js; uses app.js / inbound.js / stats.js helpers at call time.
   =======================================================================*/
let capData=null, capSeq=0;
const CAP_DEFAULTS={ shiftHours:8, breakMin:30, util:82.5, absence:7.2, roster:17, present:13, target:1000, suppliesPerDay:100,
  boxingSec:20, receivingSec:120, loadingSec:null, mappingSec:null, hourlyCost:null, workDaysMonth:22, customPct:0 };
function capCfg(){ return Object.assign({}, CAP_DEFAULTS, (Store.db.config||{}).capacity||{}); }
function capSave(patch){ Store.db.config.capacity=Object.assign({}, (Store.db.config||{}).capacity||{}, patch); Store.persist(); }

/* standard times from the Observation System's measurements (labour seconds = laborSec, or processing × workers) */
function capMeasured(){
  const P={}; Store.col('processes').forEach(p=>P[p.id]=p.name);
  const by={};
  Store.col('measurements').forEach(m=>{ const name=P[m.processId]; if(!name) return; const w=+m.workers||+m.operators||1;
    const lab=m.laborSec!=null&&m.laborSec!==''? +m.laborSec : (+m.processingSec||0)*w; if(!(lab>0)) return;
    const b=by[name]||(by[name]={n:0, labU:0, units:0, nU:0, labO:0, orders:0, nO:0}); b.n++;
    if(+m.units>0){ b.labU+=lab; b.units+=+m.units; b.nU++; } if(+m.orders>0){ b.labO+=lab; b.orders+=+m.orders; b.nO++; } });
  const out={}; Object.entries(by).forEach(([k,b])=>{ out[k]={n:b.n, perUnit:b.units? b.labU/b.units : null, nU:b.nU, perOrder:b.orders? b.labO/b.orders : null, nO:b.nO}; });
  return out;
}
const capStats=a=>{ const s=a.filter(x=>x!=null&&!isNaN(x)).sort((x,y)=>x-y); if(!s.length) return {avg:0,p90:0,max:0,n:0};
  const p=q=>{ const i=(s.length-1)*q, lo=Math.floor(i), hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo); };
  return {avg:s.reduce((x,y)=>x+y,0)/s.length, p50:p(0.5), p90:p(0.9), max:s[s.length-1], n:s.length}; };
const capWE=d=>{ const w=new Date(d+'T12:00:00').getDay(); return w===0||w===6; };

function capCompute(C, cfg){
  const meas=capMeasured(), std={}; (C.std||[]).forEach(s=>std[s.c]=+s.s);
  const wd=C.vol.filter(v=>!capWE(v.d)), we=C.vol.filter(v=>capWE(v.d));
  const mpMed=capStats(C.vol.map(v=>v.mp)).p50||0, bulkLimit=Math.max(3000, mpMed*3);       // bulk re-mapping days are project work
  const coOrdBy={}; (C.coOrd||[]).forEach(x=>coOrdBy[x.d]=x.n);
  const S={ ci:capStats(wd.map(v=>v.ci)), mp:capStats(wd.filter(v=>v.mp<bulkLimit).map(v=>v.mp)), co:capStats(wd.map(v=>v.co)), ops:capStats(wd.map(v=>v.ops)),
    ord:capStats(wd.map(v=>coOrdBy[v.d]).filter(x=>x!=null)), created:capStats(C.created.filter(x=>!capWE(x.d)).map(x=>x.o)), late:capStats(C.created.filter(x=>!capWE(x.d)).map(x=>x.late)),
    createdWe:capStats(C.created.filter(x=>capWE(x.d)).map(x=>x.o)), weCi:capStats(we.map(v=>v.ci)), weCo:capStats(we.map(v=>v.co)), weOrd:capStats(we.map(v=>coOrdBy[v.d]).filter(x=>x!=null)), weOps:capStats(we.map(v=>v.ops)) };
  const bulkDays=C.vol.filter(v=>v.mp>=bulkLimit);
  const sd=C.sameDay||[], sdTot=sd.reduce((a,w)=>a+w.n,0), xdShare= sdTot? sd.reduce((a,w)=>a+w.xdo,0)/sdTot : 0.62;
  const upo= S.ord.avg? S.co.avg/S.ord.avg : 1.38, pickShare=1-xdShare;
  const m=(name,kind,fallback)=>{ const x=meas[name]; const v=x&&(kind==='unit'? x.perUnit : x.perOrder); return v!=null? {s:v, src:'Observation System · '+(kind==='unit'? x.nU : x.nO)+' matje', weak:(kind==='unit'? x.nU : x.nO)<5}
    : {s:fallback.s, src:fallback.src, weak:true, assumed:fallback.assumed}; };
  const steps=[
    {p:'Claim', drv:'ord', ...m('Claim','order',{s:42, src:'supozim', assumed:true})},
    {p:'Picking (nga stoku)', drv:'pick', ...m('Picking','unit',{s:std.Picking||79.7, src:'WMS AverageTimeSeconds'})},
    {p:'Packing/Check-out', drv:'co', ...m('Packing/Check-out','unit',{s:std.CheckoutShipping||86.1, src:'WMS AverageTimeSeconds'})},
    {p:'Boxing', drv:'ord', ...(meas.Boxing&&meas.Boxing.perOrder? m('Boxing','order',{}) : {s:+cfg.boxingSec, src:'supozim (cilësimet)', weak:true, assumed:true})},
    {p:'Loading (furgon)', drv:'ord', ...(cfg.loadingSec!=null&&cfg.loadingSec!==''? {s:+cfg.loadingSec, src:'cilësimet', weak:true, assumed:true} : m('Loading (Truck/Van)','order',{s:20, src:'supozim', assumed:true}))},
    {p:'Receiving', drv:'sup', s:+cfg.receivingSec, src:'supozim për furnizim (cilësimet)', weak:true, assumed:true},
    {p:'Check-in', drv:'ci', ...m('Check-in','unit',{s:std.CheckIn||33.2, src:'WMS AverageTimeSeconds'})},
    {p:'Mapping', drv:'mp', ...(cfg.mappingSec!=null&&cfg.mappingSec!==''? {s:+cfg.mappingSec, src:'cilësimet', weak:true} : m('Mapping','unit',{s:std.Map||18.6, src:'WMS AverageTimeSeconds'}))}
  ];
  const base={ ord:S.ord.avg, pick:S.co.avg*pickShare, co:S.co.avg, sup:+cfg.suppliesPerDay, ci:S.ci.avg, mp:S.mp.avg };
  const outbound=d=>['ord','pick','co'].includes(d);
  const fOut={ avg:1, p90:S.co.p90/S.co.avg, peak:S.co.max/S.co.avg, target:(+cfg.target)/Math.max(1,S.ord.avg), custom:1+(+cfg.customPct||0)/100 };
  const fIn ={ avg:1, p90:S.ci.p90/S.ci.avg, peak:S.ci.max/S.ci.avg, target:(+cfg.target)/Math.max(1,S.ord.avg), custom:1+(+cfg.customPct||0)/100 };
  const hrsFTE=(+cfg.shiftHours - (+cfg.breakMin)/60)*(+cfg.util/100), abs=(+cfg.absence)/100;
  const rows=steps.map(st=>{ const vol=base[st.drv]; const h=sc=>vol*(outbound(st.drv)? fOut[sc] : fIn[sc])*st.s/3600;
    return Object.assign({}, st, {vol, h:{avg:h('avg'), p90:h('p90'), peak:h('peak'), target:h('target'), custom:h('custom')}}); });
  const tot=sc=>rows.reduce((a,r)=>a+r.h[sc],0), fte=sc=>tot(sc)/hrsFTE, fteA=sc=>fte(sc)/(1-abs);
  const weH=steps.reduce((a,st)=>{ const r=st.drv==='ci'||st.drv==='mp'||st.drv==='sup'? S.weCi.avg/Math.max(1,S.ci.avg) : S.weCo.avg/Math.max(1,S.co.avg); return a+base[st.drv]*r*st.s/3600; },0);
  return {S, rows, tot, fte, fteA, hrsFTE, abs, xdShare, upo, bulkDays, bulkLimit, weFTE:weH/hrsFTE/(1-abs), available:(+cfg.roster)*(1-abs), meas};
}

function renderCapacity(v){
  v.innerHTML=pagehead('Kapaciteti & Stafi','Sa operatorë duhen për ngarkesën reale, sipas procesit dhe skenarit (ditë mesatare, P90, piku, targeti), krahasuar me stafin. Llogaritet automatikisht nga WMS-i (12 javët e fundit, rifreskim çdo orë) dhe kohët standarde të matura në Observation System. Numrat individualë janë për planifikim dhe zhvillim, jo për ndëshkim.')
    + '<div id="capBody"><div class="empty">Po ngarkohet…</div></div>';
  loadCapacity();
}
async function loadCapacity(){
  const box=$('#capBody'); if(!box) return;
  if(!wmsOnAgent()){ box.innerHTML='<div class="card"><div class="empty">Hape app-in nga http://localhost:8790.</div></div>'; return; }
  const seq=++capSeq;
  try{ const r=await fetch('/pulse/data',{cache:'no-store'}); const j=await r.json(); if(seq!==capSeq) return;
    if(!r.ok||j.error){ box.innerHTML=`<div class="empty">${h(j.error||('HTTP '+r.status))}</div>`; return; }
    if(!j.capacity){ box.innerHTML='<div class="card"><div class="empty">Të dhënat e kapacitetit s\'janë gjeneruar ende — vijnë me rifreskimin e radhës nga databaza e WMS-it (blloqet H, I, J; çdo orë).</div></div>'; return; }
    capData=j.capacity; drawCapacity();
  }catch(e){ if(seq===capSeq) box.innerHTML=`<div class="empty">Agjenti s'përgjigjet (${h(e.message)}).</div>`; }
}
function drawCapacity(){
  const box=$('#capBody'); if(!box||!capData) return;
  const C=capData, cfg=capCfg(), R=capCompute(C, cfg), S=R.S, f1=x=>x==null||isNaN(x)? '—' : (Math.round(x*10)/10).toLocaleString(), f0=x=>x==null||isNaN(x)? '—' : Math.round(x).toLocaleString();
  const gap=(need,have)=>{ const d=have-need; return d>=0.5? `<span style="color:var(--ok)">tepricë ${f1(d)}</span>` : d<=-0.5? `<span style="color:var(--crit)">mungojnë ${f1(-d)}</span>` : 'mjafton'; };
  const sd=C.sameDay||[], last=sd[sd.length-1], first=sd[0], pct=w=> w&&w.rb? Math.round(w.rbSame/w.rb*100) : null;
  const pay=C.pay||{}, cpo= pay.orders? pay.tc/pay.orders : null;
  const at=new Date(C.at);
  const head=`<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <span class="small">Periudha: <b>${h(fmtDateAl(C.from))} → ${h(fmtDateAl(isoMinus1(C.to)))}</b> (12 javë) · same-day: 8 javë</span>
      <span class="small faint" style="margin-left:auto">Lexuar nga WMS: <b style="${(Date.now()-at)/60000>150?'color:var(--warn)':''}">${h(at.toLocaleString())}</b> · rifreskohet çdo orë</span></div></div>`;
  const kpis=`<div class="grid g-kpi" style="margin-bottom:12px">
      ${kpiCard(f1(R.fteA('avg')),'FTE · ditë mesatare',`me ${cfg.absence}% mungesa · ${f1(R.fte('avg'))} pa rezervë`)}
      ${kpiCard(f1(R.fteA('p90')),'FTE · ditë P90','')}
      ${kpiCard(f1(R.fteA('target')),'FTE · targeti '+f0(cfg.target)+'/ditë','')}
      ${kpiCard(f1(R.fteA('peak')),'FTE · ditë piku','p.sh. Black Friday', R.fteA('peak')>R.available?'crit':'')}
      ${kpiCard(f1(R.available),'FTE të disponueshme',`${cfg.roster} në roster × (1 − ${cfg.absence}%) · ${cfg.present} të pranishëm/ditë`)}
      ${kpiCard(f0(R.tot('avg')/ (cfg.present*(cfg.shiftHours-cfg.breakMin/60))*100)+'%','Shfrytëzimi i orëve të pranisë','ngarkesa standarde ÷ orët e pranisë', 'warn')}
      ${kpiCard(pct(last)!=null? pct(last)+'%' : '—','Same-day (java e fundit)', first&&last? `java ${first.wk}: ${pct(first)}% → java ${last.wk}: ${pct(last)}%` : '', pct(last)!=null&&pct(last)<95?'warn':'ok')}
      ${kpiCard(cpo!=null? '€'+cpo.toFixed(2) : '—','Kosto / porosi (piece-rate)', pay.mo? `${pay.mo}/${pay.y}: €${f0(pay.tc)} ÷ ${f0(pay.orders)} porosi` : '')}
    </div>`;
  const demand=`<div class="card" style="margin-bottom:12px"><h3>Ngarkesa <span class="sub">ditë pune (fundjava veç)</span></h3><div style="overflow-x:auto"><table style="font-size:12.5px;max-width:860px">
      <thead><tr><th></th><th>Mesatarja</th><th>P90</th><th>Maksimumi</th><th>Fundjavë (mes.)</th></tr></thead><tbody>
      <tr><td>Porosi të krijuara / ditë</td><td><b>${f0(S.created.avg)}</b></td><td>${f0(S.created.p90)}</td><td>${f0(S.created.max)}</td><td>${f0(S.createdWe.avg)}</td></tr>
      <tr><td>… prej tyre pas 17:30 (për nesër)</td><td>${f0(S.late.avg)} (${f0(S.late.avg/S.created.avg*100)}%)</td><td></td><td></td><td></td></tr>
      <tr><td>Porosi të dala (check-out) / ditë</td><td><b>${f0(S.ord.avg)}</b></td><td>${f0(S.ord.p90)}</td><td>${f0(S.ord.max)}</td><td>${f0(S.weOrd.avg)}</td></tr>
      <tr><td>Njësi check-out / ditë</td><td>${f0(S.co.avg)}</td><td>${f0(S.co.p90)}</td><td>${f0(S.co.max)}</td><td>${f0(S.weCo.avg)}</td></tr>
      <tr><td>Njësi check-in / ditë</td><td>${f0(S.ci.avg)}</td><td>${f0(S.ci.p90)}</td><td>${f0(S.ci.max)}</td><td>${f0(S.weCi.avg)}</td></tr>
      <tr><td>Njësi mapping / ditë${R.bulkDays.length?` <span class="faint">(pa ${R.bulkDays.length} ditë zhvendosjesh masive ≥ ${f0(R.bulkLimit)})</span>`:''}</td><td>${f0(S.mp.avg)}</td><td>${f0(S.mp.p90)}</td><td>${f0(S.mp.max)}</td><td></td></tr>
      <tr><td>Operatorë që skanojnë / ditë</td><td>${f1(S.ops.avg)}</td><td></td><td>${f0(S.ops.max)}</td><td>${f1(S.weOps.avg)}</td></tr>
    </tbody></table></div><div class="hint">Cross-dock: ${f0(R.xdShare*100)}% e porosive (nga same-day) → picking nga stoku ≈ ${f0((1-R.xdShare)*100)}% e njësive · ${f1(R.upo)} njësi / porosi.</div></div>`;
  const fteT=`<div class="card" style="margin-bottom:12px"><h3>FTE sipas procesit <span class="sub">1 FTE = ${f1(R.hrsFTE)} orë produktive/ditë (${cfg.shiftHours} h − ${cfg.breakMin} min pauzë) × ${cfg.util}% shfrytëzim</span></h3>
    <div style="overflow-x:auto"><table style="font-size:12.5px"><thead><tr><th>Procesi</th><th>Vëllimi / ditë</th><th>Koha std</th><th>Burimi</th><th>Orë / ditë</th><th>FTE mes.</th><th>FTE P90</th><th>FTE piku</th><th>FTE target</th>${cfg.customPct? `<th>FTE ${cfg.customPct>0?'+':''}${cfg.customPct}%</th>` : ''}</tr></thead><tbody>
    ${R.rows.map(r=>`<tr><td>${h(r.p)}</td><td>${f0(r.vol)}</td><td>${f1(r.s)} s</td><td class="small ${r.weak?'':'faint'}" style="${r.assumed?'color:var(--warn)':''}">${h(r.src)}${r.weak&&!r.assumed?' · <span style="color:var(--warn)">pak matje</span>':''}</td>
      <td>${f1(r.h.avg)}</td><td><b>${(r.h.avg/R.hrsFTE).toFixed(2)}</b></td><td>${(r.h.p90/R.hrsFTE).toFixed(2)}</td><td>${(r.h.peak/R.hrsFTE).toFixed(2)}</td><td>${(r.h.target/R.hrsFTE).toFixed(2)}</td>${cfg.customPct? `<td>${(r.h.custom/R.hrsFTE).toFixed(2)}</td>` : ''}</tr>`).join('')}
    <tr style="font-weight:700;border-top:2px solid var(--line2)"><td>Gjithsej</td><td></td><td></td><td></td><td>${f1(R.tot('avg'))}</td><td>${f1(R.fte('avg'))}</td><td>${f1(R.fte('p90'))}</td><td>${f1(R.fte('peak'))}</td><td>${f1(R.fte('target'))}</td>${cfg.customPct? `<td>${f1(R.fte('custom'))}</td>` : ''}</tr>
    <tr style="font-weight:700"><td>Me rezervë mungesash ${cfg.absence}%</td><td></td><td></td><td></td><td></td><td>${f1(R.fteA('avg'))}</td><td>${f1(R.fteA('p90'))}</td><td>${f1(R.fteA('peak'))}</td><td>${f1(R.fteA('target'))}</td>${cfg.customPct? `<td>${f1(R.fteA('custom'))}</td>` : ''}</tr>
    </tbody></table></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px"><span class="small">Ndjeshmëria:</span>${[10,25,50].map(p=>`<span class="small">+${p}% → <b>${f1(R.fteA('avg')*(1+p/100))}</b> FTE</span>`).join(' · ')}
      <label class="small" style="margin-left:auto">Skenar i lirë (%) <input type="number" id="capCustom" value="${h(cfg.customPct||0)}" step="5" style="width:80px;min-height:32px"></label></div></div>`;
  const cmp=`<div class="card" style="margin-bottom:12px"><h3>Krahasimi me stafin</h3><div style="overflow-x:auto"><table style="font-size:12.5px;max-width:860px">
    <thead><tr><th>Skenari</th><th>FTE të nevojshme</th><th>Kundrejt ${f1(R.available)} të disponueshme (roster − mungesa)</th><th>Kundrejt ${cfg.present} të pranishëm sot</th></tr></thead><tbody>
    ${[['Ditë mesatare','avg'],['Ditë P90','p90'],['Targeti '+f0(cfg.target)+' porosi/ditë','target'],['Ditë piku','peak']].map(([l,k])=>`<tr><td>${l}</td><td><b>${f1(R.fteA(k))}</b></td><td>${gap(R.fteA(k),R.available)}</td><td>${gap(R.fteA(k),+cfg.present)}</td></tr>`).join('')}
    <tr><td>Fundjavë mesatare</td><td><b>${f1(R.weFTE)}</b></td><td colspan="2" class="small">krahaso me personat e planifikuar në fundjavë (Shifts → orari)</td></tr>
    </tbody></table></div></div>`;
  // hourly coverage (weekdays)
  const hr=(C.hourly||[]).filter(x=>x.h>=6&&x.h<=22), wdN=Math.max(1,new Set(C.vol.filter(v=>!capWE(v.d)).map(v=>v.d)).size), mxO=Math.max(1,...hr.map(x=>x.anyOps/wdN));
  const cov=`<div class="card" style="margin-bottom:12px"><h3>Mbulimi sipas orës <span class="sub">ditë pune: operatorë që skanojnë mesatarisht · njësi check-out / orë</span></h3>
    <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th>Ora</th><th>Operatorë</th><th></th><th>Check-out</th><th>Check-in</th><th>Mapping</th><th>Njësi check-out</th><th>Njësi check-in</th></tr></thead><tbody>
    ${hr.map(x=>{ const o=x.anyOps/wdN; return `<tr><td>${String(x.h).padStart(2,'0')}:00</td><td><b style="${o<2.5&&x.h>=7&&x.h<=20?'color:var(--warn)':''}">${f1(o)}</b></td>
      <td><span style="display:inline-block;height:8px;border-radius:3px;background:var(--accent);width:${Math.round(o/mxO*120)}px"></span></td>
      <td>${f1(x.coOps/wdN)}</td><td>${f1(x.ciOps/wdN)}</td><td>${f1(x.mpOps/wdN)}</td><td>${f0(x.co/wdN)}</td><td>${f0(x.ci/wdN)}</td></tr>`; }).join('')}
    </tbody></table></div><div class="hint">Me portokalli: orë pune me më pak se 2,5 operatorë që skanojnë. Claim, picking pa sesion, boxing, shkarkimi dhe ngarkimi s'regjistrohen në WMS, ndaj s'duken këtu.</div></div>`;
  // operators + key persons
  const ops=(C.ops||[]), tot={ci:ops.reduce((a,o)=>a+o.ci,0), mp:ops.reduce((a,o)=>a+o.mp,0), co:ops.reduce((a,o)=>a+o.co,0)};
  const top=k=>{ const s=ops.filter(o=>!o.tmp).sort((a,b)=>b[k]-a[k])[0]; return s&&tot[k]? {who:s.i+' ('+s.id+')', share:s[k]/tot[k]} : null; };
  const multi=ops.filter(o=>!o.tmp && ['ci','mp','co'].filter(k=>o[k]>=1000).length>=2).length;
  const tmpCo=ops.filter(o=>o.tmp).reduce((a,o)=>a+o.co+o.ci+o.mp,0);
  const rate=(n,hh)=>hh? f0(n/hh) : '—';
  const opsT=`<div class="card" style="margin-bottom:12px"><h3>Operatorët <span class="sub">12 javë · njësi dhe ritmi në orët aktive të procesit · inicialet (ID)</span></h3>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;margin-bottom:8px" class="muted">
      ${['co','mp','ci'].map(k=>{ const t=top(k); return t? `<span>Personi kryesor në ${({co:'check-out',mp:'mapping',ci:'check-in'})[k]}: <b>${h(t.who)}</b> — <b style="${t.share>0.2?'color:var(--warn)':''}">${f0(t.share*100)}%</b></span>` : ''; }).join('')}
      <span>Me ≥ 2 procese (≥ 1.000 njësi secili): <b>${multi}</b></span>
      ${tmpCo? `<span style="color:var(--warn)">Llogari të përbashkëta (Temp): <b>${f0(tmpCo)}</b> njësi pa pronar</span>` : ''}</div>
    <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr><th>Operatori</th><th>Ditë</th><th>Orë aktive</th><th>Check-in</th><th>/ orë</th><th>Mapping</th><th>/ orë</th><th>Check-out</th><th>/ orë</th></tr></thead><tbody>
    ${ops.map(o=>`<tr><td>${h(o.i)} <span class="faint">(${h(o.id)})</span>${o.tmp?' <span class="badge b-warn">temp</span>':''}</td><td>${o.days}</td><td>${o.hrs}</td>
      <td>${f0(o.ci)}</td><td class="faint">${rate(o.ci,o.ciH)}</td><td>${f0(o.mp)}</td><td class="faint">${rate(o.mp,o.mpH)}</td><td>${f0(o.co)}</td><td class="faint">${rate(o.co,o.coH)}</td></tr>`).join('')}
    </tbody></table></div><div class="hint">"/ orë" = njësi ÷ orët me të paktën një skanim të atij procesi. Ritmi standard: check-out ≈ ${f0(3600/(R.rows.find(r=>r.drv==='co')||{s:52.5}).s)}, check-in ≈ ${f0(3600/(R.rows.find(r=>r.drv==='ci')||{s:25.6}).s)}, mapping ≈ ${f0(3600/(R.rows.find(r=>r.drv==='mp')||{s:18.6}).s)} njësi/orë.</div></div>`;
  const sdT= sd.length? `<div class="card" style="margin-bottom:12px"><h3>Same-day <span class="sub">porosi të gatshme deri 17:30 dhe të dala të njëjtën ditë</span></h3>
    <div style="overflow-x:auto"><table style="font-size:12.5px;max-width:760px"><thead><tr><th>Java</th><th>Gati deri 17:30</th><th>Të njëjtën ditë</th><th>Të nesërmen</th><th>≥ 2 ditë</th><th>Mediana gati → check-out</th></tr></thead><tbody>
    ${sd.map(w=>`<tr><td>${w.wk} <span class="faint">(${h(fmtDateAl(w.d1))})</span></td><td>${f0(w.rb)}</td><td><b style="${pct(w)<95?'color:var(--warn)':'color:var(--ok)'}">${pct(w)}%</b></td>
      <td>${w.rb? f0(w.rbNext/w.rb*100)+'%' : '—'}</td><td>${w.rb? f0(w.rbLater/w.rb*100)+'%' : '—'}</td><td>${inbDur(+w.whP50)}</td></tr>`).join('')}
    </tbody></table></div></div>` : '';
  const monthlyFixed= cfg.hourlyCost? (+cfg.roster)*(+cfg.shiftHours)*(+cfg.workDaysMonth)*(+cfg.hourlyCost) : null;
  const ordMonth=S.ord.avg*(+cfg.workDaysMonth)+S.weOrd.avg*((30-(+cfg.workDaysMonth)));
  const costT=`<div class="card" style="margin-bottom:12px"><h3>Kosto për porosi</h3>
    <div class="small" style="line-height:1.7">Formula: <b>CPO = (orët e paguara × kosto/orë + piece-rate + orët shtesë) ÷ porositë e dërguara</b><br>
      Piece-rate (WMS, ${h(String(pay.mo||'—'))}/${h(String(pay.y||'—'))}): €${f0(pay.tc)} ÷ ${f0(pay.orders)} porosi = <b>€${cpo!=null? cpo.toFixed(2) : '—'}/porosi</b> (€${pay.ta? (pay.tc/pay.ta).toFixed(3) : '—'}/veprim).<br>
      ${monthlyFixed? `Paga bazë (${cfg.roster} × ${cfg.shiftHours} h × ${cfg.workDaysMonth} ditë × €${cfg.hourlyCost}) ≈ €${f0(monthlyFixed)}/muaj ÷ ≈ ${f0(ordMonth)} porosi/muaj = <b>€${(monthlyFixed/ordMonth).toFixed(2)}</b> + piece-rate €${cpo!=null? cpo.toFixed(2) : '—'} = <b>€${(monthlyFixed/ordMonth+(cpo||0)).toFixed(2)}/porosi</b>; me targetin ${f0(cfg.target)}/ditë: <b>€${(monthlyFixed/((+cfg.target)*(+cfg.workDaysMonth)+S.weOrd.avg*(30-cfg.workDaysMonth))+(cpo||0)).toFixed(2)}</b>.`
        : '<span class="faint">Shto koston për orë te cilësimet për koston e plotë për porosi.</span>'}</div></div>`;
  const set=`<details class="card no-print"><summary style="cursor:pointer"><b>⚙ Cilësimet e llogaritjes</b> <span class="sub">ruhen në app; ndikojnë menjëherë</span></summary>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px">
      ${[['shiftHours','Orë turni',0.5],['breakMin','Pauzë (min)',5],['util','Shfrytëzimi i synuar (%)',0.5],['absence','Mungesat (%)',0.1],['roster','Operatorë në roster',1],['present','Të pranishëm / ditë pune',1],
         ['target','Targeti porosi/ditë',50],['suppliesPerDay','Furnizime / ditë',5],['boxingSec','Boxing s/porosi (supozim)',1],['receivingSec','Receiving s/furnizim (supozim)',5],['loadingSec','Loading s/porosi (bosh = matja)',1],
         ['mappingSec','Mapping s/njësi (bosh = WMS)',0.1],['hourlyCost','Kosto €/orë (opsionale)',0.1],['workDaysMonth','Ditë pune / muaj',1]]
        .map(([k,l,st])=>`<label class="small" style="display:flex;flex-direction:column;gap:3px;min-width:150px">${l}<input type="number" data-capk="${k}" step="${st}" value="${cfg[k]==null?'':h(cfg[k])}" style="min-height:34px"></label>`).join('')}
    </div>
    <div class="hint">Mungesat 7,2% = shtatori (orari Excel × Time Keeper). Kohët standarde vijnë automatikisht nga <b>Process Measurement</b>; ku ka &lt; 5 matje shënohen "pak matje". Shto matje për loading, boxing, receiving dhe mapping për saktësi.</div>
    <div class="btnrow" style="margin-top:8px"><button class="btn sm" id="capReset">Rikthe vlerat fillestare</button></div></details>`;
  box.innerHTML=head+kpis+fteT+cmp+demand+cov+sdT+opsT+costT+set;
  $$('[data-capk]').forEach(inp=>inp.onchange=e=>{ const k=e.target.dataset.capk, v=e.target.value===''? null : +e.target.value; capSave({[k]:v}); drawCapacity(); });
  const cc=$('#capCustom'); if(cc) cc.onchange=e=>{ capSave({customPct:+e.target.value||0}); drawCapacity(); };
  const rs=$('#capReset'); if(rs) rs.onclick=()=>{ Store.db.config.capacity={}; Store.persist(); drawCapacity(); toast('Cilësimet u rikthyen'); };
}
function isoMinus1(iso){ const d=new Date(iso+'T12:00:00'); d.setDate(d.getDate()-1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
