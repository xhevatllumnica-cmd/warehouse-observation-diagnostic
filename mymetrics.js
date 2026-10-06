/* "Metrikat e mia" — the warehouse lead's own metrics, on one page, in 7 sub-cards (agreed 07.10.2026, combining two lists):
   1 Rrjedha e porosive · 2 Inbound · 3 Picking dhe check-out · 4 Njerëzit dhe produktiviteti · 5 Kostoja · 6 Dërgesat ·
   7 Saktësia e inventarit. Each metric shows its current value, a signal (🟢 / 🟠 / 🔴 against the thresholds written
   next to it), how often to look at it (D ditore / J javore / M mujore) and a link to the page with the detail.
   Sources, all already in the app (nothing new is read from the WMS):
     /pulse/data       WMS database snapshot (orders, capacity, inbound, shipments, returns; blocks D/K = WMS Pulse) — hourly/daily
     /tabela/data      today's board: cut-offs and yesterday's carryover, live scans (accounts outside the staff list)
     /pod/pending      orders waiting for the final POD, per courier post (Delivery Platform)
     /delivery/pod     yesterday's POD: delivery rate, refusals, cash, > 24h (Delivery Platform)
   Depo 01 Prishtinë. Thresholds are a starting point: calibrate after 2–4 weeks on the warehouse's own normal day. */
let mmSeq=0, mmCad='all', mmSrc={};
const MM_CAD={D:'Ditore', J:'Javore', M:'Mujore'};

function renderMyMetrics(v){
  v.innerHTML=pagehead('Metrikat e mia',
    'Metrikat që ndjek Warehouse Lead-i për të gjetur problemet në procese: rrjedha e porosive para së gjithash, pastaj ku ngec puna — në cilin proces, te kush, në cilin lokacion. Fokusi te <b>p90 dhe trendet</b>, jo te mesataret: problemet duken së pari te bishti i gjatë. Depo 01 Prishtinë.',
    `<span id="mmScore" style="display:inline-flex;align-items:center"></span><button class="btn" id="mmRefresh">↻ Rifresko</button>`)
    + `<div class="card no-print" style="margin-bottom:12px"><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center" id="mmBar"></div></div>
       <div id="mmBody"><div class="empty">Po lexohen të dhënat…</div></div>`;
  $('#mmRefresh').onclick=()=>loadMyMetrics(true);
  loadMyMetrics(false);
}
async function loadMyMetrics(force){
  if(!$('#mmBody')) return;
  if(!wmsOnAgent()){ $('#mmBody').innerHTML='<div class="empty">Hape app-in nga http://localhost:8790.</div>'; return; }
  const seq=++mmSeq, get=u=>fetch(u,{cache:'no-store'}).then(r=>r.json()).catch(e=>({error:e.message}));
  if(force) mmSrc={};
  const draw=()=>{ if(seq===mmSeq) drawMyMetrics(); };
  const yd=mmIso(-1);
  // the pulse first (fast); the live sources fill in as they arrive (POD after an agent restart takes ~3 minutes)
  if(!mmSrc.P || !mmSrc.SCH){ const [p,s]=await Promise.all([mmSrc.P||get('/pulse/data'), mmSrc.SCH||get('/schedule')]); mmSrc.P=p; mmSrc.SCH=s; } draw();
  const jobs=[['T','/tabela/data'], ['PP','/pod/pending'], ['POD','/delivery/pod?date='+yd]].filter(([k])=>!mmSrc[k]);
  jobs.forEach(([k,u])=>get(u).then(j=>{ mmSrc[k]=j; draw(); }));
}
function mmIso(n){ const d=new Date(); d.setDate(d.getDate()+n); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
const mmMed=a=>{ const s=a.filter(x=>x!=null && !isNaN(x)).sort((x,y)=>x-y); if(!s.length) return null; const m=s.length>>1; return s.length%2? s[m] : (s[m-1]+s[m])/2; };
const mmN=(v,d=0)=> v==null||isNaN(v)? '—' : Number(v).toLocaleString(undefined,{minimumFractionDigits:d, maximumFractionDigits:d});
const mmPct=(a,b,d=0)=> b? mmN(a/b*100,d)+'%' : '—';
const mmArrow=(now,prev,goodDown)=>{ if(now==null||prev==null||!prev) return ''; const ch=(now/prev-1)*100; if(Math.abs(ch)<3) return ' <span class="faint">→</span>';
  const bad= goodDown? ch>0 : ch<0; return ` <span style="color:${bad?'var(--crit)':'var(--ok)'}">${ch>0?'▲':'▼'} ${mmN(Math.abs(ch),0)}%</span>`; };
const mmLvl=(v,okMax,warnMax)=> v==null? 'na' : v<=okMax? 'ok' : v<=warnMax? 'warn' : 'crit';      // lower is better
const mmLvlUp=(v,okMin,warnMin)=> v==null? 'na' : v>=okMin? 'ok' : v>=warnMin? 'warn' : 'crit';   // higher is better
const mmLoading=src=>({v:'…', s:'po lexohet nga '+src, lvl:'na'});

/* one metric: {n name, why what it shows / alarm signal, cad D|J|M, go route, ...value: v, s, lvl} */
function mmSections(){
  const P=mmSrc.P&&!mmSrc.P.error? mmSrc.P : null, C=P&&P.capacity, O=P&&P.orders, D=P&&P.D, K=P&&P.K;
  const T=mmSrc.T, PP=mmSrc.PP, POD=mmSrc.POD, now=Date.now(), today=mmIso(0), yd=mmIso(-1);
  const noP={v:'—', s:'WMS Pulse nuk u lexua', lvl:'na'};
  const lastDays=(arr,n,key='d')=>(arr||[]).filter(r=>r[key]<today).slice(-n);
  const wops=r=>(+r.co||0)+0.8*(+r.ci||0)+0.6*(+r.mp||0);
  // a day of work: the latest finished day that is not a Sunday, against the normal day = median of the 14 days before it without Sundays
  const sun=d=>new Date(d+'T12:00:00').getDay()===0;
  const dayVsNormal=(arr,f)=>{ const w=lastDays(arr,16).filter(r=>!sun(r.d)), last=w.slice(-1)[0]; if(!last) return {};
    const base=mmMed(w.slice(0,-1).map(f).filter(x=>x>0)); return {d:last.d, v:f(last), base, pct: base? f(last)/base*100 : null}; };
  const S=[];

  // ---------------------------------------------------------------- 1. Rrjedha e porosive
  const s1=[];
  if(D&&D.o2c){ const g=D.o2c.find(r=>r[0]==='GjirafaMall')||[], f=D.o2c.find(r=>r[0]==='Gjirafa50')||[];
    const dl=lastDays(O&&O.daily,14), h7=mmMed(dl.slice(-7).map(r=>r.h50)), h7p=mmMed(dl.slice(0,7).map(r=>r.h50));
    s1.push({n:'Porosi → check-out i parë: mediana / p90', why:'Sa shpejt del porosia. Alarm: p90 rritet edhe kur mediana mbetet e njëjtë — ka porosi që ngecin.', cad:'J', go:'orders',
      v:`p90 ${mmN(g[4],0)} h`, s:`GjirafaMall: mediana ${mmN(g[3],1)} h · p90 ${mmN(g[4],0)} h · Gjirafa50: ${mmN(f[3],1)} / ${mmN(f[4],0)} h (30 ditë) · mediana ditore 7d ${mmN(h7,1)} h${mmArrow(h7,h7p,true)}`,
      lvl:mmLvl(g[4],48,120)}); }
  else s1.push(Object.assign({n:'Porosi → check-out i parë: mediana / p90', cad:'J', go:'orders'}, noP));
  if(O&&O.wait){ const age=r=>(now-Date.parse(String(r.a2||r.cr).replace(' ','T')))/3600000, b=[0,0,0,0];
    O.wait.forEach(r=>{ const a=age(r); b[a<4?0:a<24?1:a<72?2:3]++; });
    s1.push({n:'Porositë në pritje sipas moshës', why:'Backlog-u: porosi të gatshme që s\'kanë dalë. Alarm: porosi të vjetra që qëndrojnë te i njëjti status.', cad:'D', go:'orders',
      v:`${mmN(O.wait.length)}`, s:`< 4h: <b>${b[0]}</b> · 4–24h: <b>${b[1]}</b> · 1–3 ditë: <b>${b[2]}</b> · > 3 ditë: <b style="color:${b[3]?'var(--crit)':'inherit'}">${b[3]}</b>`,
      lvl: !O.wait.length? 'ok' : b[3]/O.wait.length>0.1? 'crit' : b[3]? 'warn' : 'ok'});
    const out7=mmMed(lastDays(O.daily,7).map(r=>r.n)), byP=p=>O.wait.filter(r=>r.p===p).length;
    s1.push({n:'Porosi të hapura sipas platformës', why:'A e mbyll depo punën e ditës. Alarm: numri rritet nga dita në ditë, ose kalon gjysmën e një dite pune.', cad:'D', go:'orders',
      v:`${mmN(O.wait.length)}`, s:`GjirafaMall ${byP(1)} · Gjirafa50 ${byP(2)} · ${out7? mmN(O.wait.length/out7*100,0)+'% e një dite pune ('+mmN(out7)+' porosi/ditë)' : ''}`,
      lvl: out7? mmLvl(O.wait.length/out7,0.5,1) : 'info'}); }
  if(T && !T.error && T.cut && T.cut.available && T.cut.carry){ const c=T.cut.carry;
    s1.push({n:'Carryover nga dje', why:'Porosi të gatshme dje deri 17:30 që nuk dolën dje. Alarm: mbi 5%.', cad:'D', go:'tabela',
      v:`${mmN(c.pct,1)}%`, s:`${mmN(c.carry)} nga ${mmN(c.ready)} të gatshme · ${mmN(c.stillOpen)} ende të hapura`, lvl:mmLvl(c.pct,5,10)}); }
  else if(C&&C.sameDay&&C.sameDay.length){ const w=C.sameDay.filter(r=>r.d1<=mmIso(-7)).slice(-1)[0]||C.sameDay.slice(-1)[0], car=w.rb? (w.rbNext+w.rbLater)/w.rb*100 : null;
    s1.push({n:'Carryover (java e fundit e plotë)', why:'Porosi të gatshme deri në cut-off që nuk dolën po atë ditë. Alarm: mbi 5%.', cad:'D', go:'capacity',
      v:`${mmN(car,1)}%`, s:`java ${w.wk}: ${mmN(w.rbNext+w.rbLater)} nga ${mmN(w.rb)} dolën ditën tjetër ose më vonë${!T? ' · carryover i djeshëm: po lexohet…' : T.error? ' · carryover i djeshëm: nuk u lexua' : T.cut&&!T.cut.available? ' · carryover i djeshëm: blloku i cut-off-eve në WMS Pulse nuk është i ditës'+(T.cut.gen? ' ('+h(String(T.cut.gen).slice(0,10))+')' : '') : ''}`, lvl:mmLvl(car,5,10)}); }
  if(O&&O.unmaps&&O.unmaps.length){ const u=lastDays(O.unmaps,14), a=u.slice(-7).reduce((s,r)=>s+r.n,0), b=u.slice(0,-7).reduce((s,r)=>s+r.n,0), last=u.slice(-1)[0];
    const outs=lastDays(O.daily,7).reduce((s,r)=>s+r.n,0);
    s1.push({n:'Unmap-et e porosive', why:'Porosi të çmapuara pasi u planifikuan. Alarm: norma rritet — problem me stokun ose lokacionin.', cad:'J', go:'orders',
      v:`${mmN(a)} / 7d`, s:`dje (${last? fmtDateAl(last.d).slice(0,5) : ''}): ${last? mmN(last.n) : '—'} · ${outs? mmN(a/outs*100,0)+'% e porosive të dalura' : ''} · 7 ditët para: ${mmN(b)}${mmArrow(a,b,true)}`,
      lvl: b? mmLvl((a/b-1)*100,10,30) : 'info'}); }
  if(D&&D.status){ const by={}; D.status.forEach(r=>{ by[r[2]]=(by[r[2]]||0)+r[5]; }); const top=Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,3), tot=Object.values(by).reduce((s,n)=>s+n,0);
    const nm=st=>K&&K.statusNames&&K.statusNames[st]? K.statusNames[st] : 'status '+st;
    s1.push({n:'Porosi të ngecura te i njëjti status > 72h', why:'Porosi që nuk lëvizin. Alarm: të njëjtat statuse mbushen nga java në javë.', cad:'J', go:'pulse',
      v:mmN(tot), s:top.map(([st,n])=>`${h(nm(st))}: ${mmN(n)}`).join(' · ')+' (krijuar 3–30 ditë më parë)', lvl: tot? 'warn' : 'ok'}); }
  S.push({t:'Rrjedha e porosive', sub:'shëndeti i përgjithshëm', rows:s1});

  // ---------------------------------------------------------------- 2. Inbound
  const s2=[];
  if(P&&P.inbound&&P.inbound.daily){ const x=dayVsNormal(P.inbound.daily, r=>+r.n||0);
    s2.push({n:'Check-in për ditë', why:'Sa njësi pranohen. Alarm: rënie e fortë kundrejt ditës normale kur ka furnizime në pritje.', cad:'D', go:'inbound',
      v:mmN(x.v), s:`${x.d? fmtDateAl(x.d) : ''} · dita normale ${mmN(x.base)} (mediana 14 ditë pa të dielat) → ${mmN(x.pct,0)}%`, lvl: x.pct!=null? mmLvlUp(x.pct,75,50) : 'info'}); }
  if(D&&D.dwell&&D.dwell.length){ const last=D.dwell.slice(-1)[0], med=mmMed(D.dwell.slice(-7).map(r=>r[2]));
    s2.push({n:'Koha nga check-in te map-imi në raft', why:'Njësi të pranuara por të pavendosura janë stok "i padukshëm" për picking-un. Alarm: mbi 24 orë.', cad:'D', go:'inbound',
      v:`${mmN(med/60,1)} h`, s:`mediana 7 ditë · ${h(last[0])}: ${mmN(last[2]/60,1)} h për ${mmN(last[1])} njësi`, lvl:mmLvl(med/60,24,48)}); }
  if(D&&D.state){ const n2=(D.state.find(r=>r[0]===2)||[0,0])[1], n6=(D.state.find(r=>r[0]===6)||[0,0])[1], ci=P.inbound&&P.inbound.daily? dayVsNormal(P.inbound.daily, r=>+r.n||0).base : null;
    s2.push({n:'Njësi të ngecura në statusin 2 / 6 (pa map)', why:'Të regjistruara, por ende jo në raft. Alarm: më shumë se një ditë check-in.', cad:'D', go:'pulse',
      v:mmN(n2+n6), s:`status 2: ${mmN(n2)} · status 6: ${mmN(n6)}${ci? ' · '+mmN((n2+n6)/ci*100,0)+'% e një dite check-in' : ''}`, lvl: ci? mmLvl((n2+n6)/ci,0.5,1) : 'info'}); }
  if(K&&K.supStarted!=null) s2.push({n:'Furnizime të hapura ("Started")', why:'Furnizime të nisura e të pambyllura. Alarm: mbeten të hapura me ditë — pranim i papërfunduar ose i pambyllur në WMS.', cad:'J', go:'inbound',
    v:mmN(K.supStarted), s:'SupplyStatusId 1, depo 01 — kontrollo të vjetrat te Product / Inbound Flow', lvl:K.supStarted>50? 'warn' : 'ok'});
  S.push({t:'Inbound', sub:'pranimi dhe vendosja', rows:s2});

  // ---------------------------------------------------------------- 3. Picking dhe check-out
  const s3=[];
  if(O&&O.daily){ const x=dayVsNormal(O.daily, r=>+r.n||0), u=(O.daily.find(r=>r.d===x.d)||{}).units;
    s3.push({n:'Check-out për ditë', why:'Porosi që dalin nga depo. Alarm: më pak se dita normale kur ka porosi në pritje.', cad:'D', go:'orders',
      v:mmN(x.v), s:`${x.d? fmtDateAl(x.d) : ''} · ${mmN(u)} produkte · dita normale ${mmN(x.base)} porosi (pa të dielat) → ${mmN(x.pct,0)}%`, lvl: x.pct!=null? mmLvlUp(x.pct,75,50) : 'info'}); }
  if(C&&C.sameDay&&C.sameDay.length){ const full=C.sameDay.filter(r=>r.d1<=mmIso(-7)), w=full.slice(-1)[0], p=full.slice(-2)[0];
    if(w){ const pct=w.rbSame/w.rb*100, pp=p&&p!==w? p.rbSame/p.rb*100 : null;
      s3.push({n:'Same-day: të gatshme deri në cut-off → dalë po atë ditë', why:'Premtimi ndaj klientit. Alarm: nën 95%.', cad:'J', go:'capacity',
        v:`${mmN(pct,1)}%`, s:`java ${w.wk}: ${mmN(w.rbSame)} nga ${mmN(w.rb)}${pp!=null? ' · java para: '+mmN(pp,1)+'%' : ''}`, lvl:mmLvlUp(pct,95,90)}); } }
  if(C&&C.opsDay&&C.std){ const r14=C.opsDay.filter(r=>r.d>=mmIso(-14) && r.d<today), std=k=>(C.std.find(x=>x.c===k)||{}).s;
    const rate=(u,hh)=>{ const U=r14.reduce((s,r)=>s+(+r[u]||0),0), H=r14.reduce((s,r)=>s+(+r[hh]||0),0); return H? U/H : null; };
    const line=(lbl,u,hh,k)=>{ const r=rate(u,hh), n=std(k)? 3600/std(k) : null; return `${lbl} <b>${mmN(r,0)}</b>/orë (norma ${mmN(n,0)} → ${r&&n? mmN(r/n*100,0)+'%' : '—'})`; };
    s3.push({n:'Ritmi kundrejt normës së veprimit', why:'Norma: check-out ~86 s, check-in ~33 s, map ~19 s për njësi. Shumë më ngadalë → trajnim, layout ose pajisje.', cad:'J', go:'capacity',
      v:mmN(rate('co','coH'),0)+'/orë', s:[line('Check-out','co','coH','CheckoutShipping'), line('Check-in','ci','ciH','CheckIn'), line('Map','mp','mpH','Map')].join(' · ')+' · njësi për orë aktive, 14 ditë (ora aktive përfshin edhe pauzat brenda orës)', lvl:'info'}); }
  if(C&&C.hourly&&C.hourly.length){ const hrs=C.hourly.filter(r=>r.h>=7 && r.h<=21), peak=hrs.slice().sort((a,b)=>b.co/b.days-a.co/a.days)[0];
    const thin=hrs.filter(r=>r.h>=8 && r.h<=20 && r.coOps/Math.max(1,r.days)<1).map(r=>r.h+':00');
    s3.push({n:'Check-out sipas orës: piku dhe orët pa mbulim', why:'Ku është piku i punës dhe në cilat orë nuk ka njeri në check-out.', cad:'J', go:'capacity',
      v:peak? peak.h+':00' : '—', s:`piku ${peak? mmN(peak.co/peak.days,0)+' produkte/orë' : ''} · orë me < 1 operator mesatarisht: ${thin.length? thin.join(', ') : 'asnjë'}`, lvl: thin.length? 'warn' : 'ok'}); }
  if(D&&D.pick&&D.pick.length){ const ses=D.pick.reduce((s,r)=>s+r[1],0), sc=D.pick.reduce((s,r)=>s+r[4],0), rq=D.pick.reduce((s,r)=>s+r[5],0), mins=mmMed(D.pick.map(r=>r[2]));
    // PickSession is a new WMS function (08/2026) used only a little so far: shown for information, not as an alarm
    s3.push({n:'Picking me seanca (PickSession)', why:'Porosi për seancë, kohëzgjatja, seanca të pambyllura. Funksion i ri i WMS-it, i përdorur pak deri tani — bëhet alarm (plotësimi nën 80%) kur të përdoret rregullisht.', cad:'J', go:'pulse',
      v:`${mmN(ses)} seanca`, s:`plotësimi ${mmPct(sc,rq)} (${mmN(sc)} / ${mmN(rq)}) · ${mmN(D.pick.length)} punëtorë · kohëzgjatja mediane ${mmN(mins,0)} min · gjithë periudha`, lvl:'info'}); }
  S.push({t:'Picking dhe check-out', sub:'', rows:s3});

  // ---------------------------------------------------------------- 4. Njerëzit dhe produktiviteti
  const s4=[];
  // people metrics count only the warehouse operators on the list of "Orari i punës" (the lead, 07.10.2026); the two WMS
  // accounts of one person count as one (aliases). Work per person and day: pulse block I (opsDay, by WMS user → name).
  const SCH=mmSrc.SCH&&!mmSrc.SCH.error&&mmSrc.SCH.names? mmSrc.SCH : null;
  const nn=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  const staff=new Map(((SCH&&SCH.names)||[]).map(n=>[nn(n),n])), alias={}; Object.entries((SCH&&SCH.aliases)||{}).forEach(([k,v])=>alias[nn(k)]=v);
  const meta={}; ((C&&C.opsMeta)||[]).forEach(m=>meta[m.u]=m);
  const whName=u=>{ const n=(meta[u]||{}).n; if(!n) return null; return staff.get(nn(alias[nn(n)]||n))||null; };
  const whDays=(from,to)=>{ const m={}; ((C&&C.opsDay)||[]).forEach(r=>{ if(r.d<from||r.d>to) return; const n=whName(r.u); if(!n) return;
      const o=m[n]||(m[n]={n, w:0, co:0, dates:new Set()}); o.w+=wops(r); o.co+=(+r.co||0); o.dates.add(r.d); });
    Object.values(m).forEach(o=>{ o.days=o.dates.size; o.pd=o.days? o.w/o.days : 0; }); return m; };
  if(!staff.size || !(C&&C.opsDay)) s4.push({n:'Bandat e performancës (30 ditë)', cad:'J', go:'capacity', v:'—', s: mmSrc.SCH? 'lista e Orarit të punës nuk u lexua' : 'po lexohet lista e Orarit të punës…', lvl:'na'});
  else {
    const m30=whDays(mmIso(-30), yd), act=Object.values(m30).filter(o=>o.days>=5);
    const avg=act.length? act.reduce((s,o)=>s+o.pd,0)/act.length : 0, sd=act.length? Math.sqrt(act.reduce((s,o)=>s+(o.pd-avg)**2,0)/act.length) : 0;
    const band=o=> o.days<5? 'few' : o.pd>avg+2*sd? 'Spike' : o.pd>avg*1.25? 'Above' : o.pd<avg*0.75? 'Below' : 'Normal';
    const BL={Spike:['Spike','var(--accent)'], Above:['Mbi normë','var(--ok)'], Normal:['Normale','var(--muted)'], Below:['Nën normë','var(--crit)'], few:['< 5 ditë','var(--faint)']};
    const list=[...staff.values()].map(n=>m30[n]||{n, pd:0, days:0}).sort((a,b)=>((b.days>=5)-(a.days>=5)) || b.pd-a.pd), cnt=b=>list.filter(o=>band(o)===b).length;
    s4.push({n:'Ops të peshuara për ditë pune', why:'1.0 × check-out + 0.8 × check-in + 0.6 × map, për ditë pune.', cad:'J', go:'capacity',
      v:mmN(avg,0), s:`mesatarja e ${act.length} operatorëve të WH (lista te Orari i punës) me ≥ 5 ditë pune në 30 ditë · devijimi ${mmN(sd,0)}`, lvl:'info'});
    s4.push({n:'Bandat e performancës (30 ditë)', why:'Vetëm operatorët e WH sipas listës te Orari i punës, me të paktën 5 ditë pune. Mbi normë > 125% e mesatares · nën normë < 75% · spike > mesatarja + 2σ (kontrollo nëse është i vërtetë). Numërohen vetëm skanimet në WMS: puna në POD dhe refuzime (Delivery Platform) nuk hyn këtu — kush punon kryesisht aty del më i ulët.', cad:'J', go:'capacity',
      v:`${cnt('Below')} nën normë`, s:`mbi normë ${cnt('Above')} · normale ${cnt('Normal')} · spike ${cnt('Spike')} · me < 5 ditë ${cnt('few')} · mesatarja ${mmN(avg,0)} ops/ditë`,
      list:list.map(o=>{ const b=band(o), L=BL[b];
        return `<div style="display:flex;gap:10px;align-items:baseline;padding:3px 0;border-bottom:1px dashed var(--line)"><span style="flex:1;min-width:0">${h(o.n)}</span>
          <span style="font-variant-numeric:tabular-nums;white-space:nowrap">${o.days? mmN(o.pd,0)+' ops/ditë' : 'pa punë'}</span>
          <span class="faint" style="width:64px;text-align:right;white-space:nowrap">${b!=='few'&&avg? (o.pd>=avg?'+':'')+mmN((o.pd/avg-1)*100,0)+'%' : o.days+' ditë'}</span>
          <b style="width:80px;text-align:right;color:${L[1]};white-space:nowrap">${L[0]}</b></div>`; }).join(''),
      lvl: cnt('Below')? 'warn' : 'ok'});
    const a=whDays(mmIso(-7),yd), b=whDays(mmIso(-14),mmIso(-8));
    const drop=Object.values(a).filter(o=>b[o.n] && o.days>=3 && b[o.n].days>=3).map(o=>({n:o.n, ch:o.pd/b[o.n].pd*100-100})).filter(x=>x.ch<=-15).sort((x,y)=>x.ch-y.ch);
    s4.push({n:'Rënie ≥ 15% javë pas jave', why:'Ops të peshuara për ditë pune: 7 ditët e fundit kundrejt 7 ditëve para (min. 3 ditë pune në secilën), operatorët e WH.', cad:'J', go:'capacity',
      v:`${drop.length}`, s: drop.length? drop.slice(0,6).map(x=>`${h(x.n)} ${mmN(x.ch,0)}%`).join(' · ') : 'askush', lvl: drop.length? 'warn' : 'ok'});
    const tot=Object.values(a).reduce((s,o)=>s+o.co,0), top=Object.values(a).sort((x,y)=>y.co-x.co).slice(0,3), share=tot? top.reduce((s,o)=>s+o.co,0)/tot*100 : null;
    s4.push({n:'Shpërndarja e check-out-it (top 3)', why:'Nëse 2–3 persona bëjnë shumicën e check-out-eve, depo varet prej tyre. Alarm: mbi 60%.', cad:'J', go:'capacity',
      v:`${mmN(share,0)}%`, s:top.map(o=>`${h(o.n)} ${mmN(o.co/tot*100,0)}%`).join(' · ')+' · 7 ditë, operatorët e WH', lvl:mmLvl(share,60,75)});
  }
  if(C&&C.opsDay){
    const all=C.opsDay.filter(r=>r.d>=mmIso(-7)&&r.d<=yd), tw=all.filter(r=>(meta[r.u]||{}).tmp).reduce((s,r)=>s+wops(r),0), aw=all.reduce((s,r)=>s+wops(r),0);
    const other=T&&!T.error&&T.live&&T.live.pod? T.live.pod.otherAccounts : null;
    s4.push({n:'Llogari të përbashkëta / jashtë stafit', why:'Llogaritë temp@… dhe skanimet me llogari jashtë listës së stafit fshehin kush e bën punën.', cad:'J', go:'tabela',
      v:mmPct(tw,aw,1), s:`e punës 7 ditë me llogari temp${other!=null? ' · POD sot: '+mmN(other)+' skanime me llogari jashtë stafit' : ''}`, lvl: aw? mmLvl(tw/aw*100,2,5) : 'info'}); }
  if(P&&P.inbound&&P.inbound.daily&&O&&O.daily){ const ci=dayVsNormal(P.inbound.daily, r=>+r.n||0), mp=dayVsNormal(P.inbound.daily, r=>+r.mp||0), co=dayVsNormal(O.daily, r=>+r.n||0);
    const parts=[ci.pct, mp.pct, co.pct].filter(x=>x!=null), pct=parts.length? parts.reduce((s,x)=>s+x,0)/parts.length : null;
    if(pct!=null) s4.push({n:'Realizimi ditor', why:'Check-in, map dhe check-out kundrejt ditës normale (mediana 14 ditë pa të dielat), mesatarja e tri proceseve.', cad:'D', go:'wms',
      v:`${mmN(pct,0)}%`, s:`${fmtDateAl(co.d||ci.d)} · check-in ${mmN(ci.pct,0)}% · map ${mmN(mp.pct,0)}% · check-out ${mmN(co.pct,0)}%`, lvl:mmLvlUp(pct,95,75)}); }
  S.push({t:'Njerëzit dhe produktiviteti', sub:'', rows:s4});

  // ---------------------------------------------------------------- 5. Kostoja
  const s5=[];
  if(C&&C.opsDay&&typeof capPeriodCost==='function'){
    const d0=new Date(); const dow=(d0.getDay()+6)%7; const mon=mmIso(-dow-7), sun=mmIso(-dow-1), mon2=mmIso(-dow-14), sun2=mmIso(-dow-8);
    const cw=capPeriodCost(C,{from:mon,to:sun},{}), cp=capPeriodCost(C,{from:mon2,to:sun2},{}), cpo=c=>c&&c.orders? c.piece/c.orders : null;
    // a change of price version changes the cost by itself: compare only within one version
    const sameV=(...cs)=>{ const v=cs.map(c=>((c&&c.versions)||[]).join(',')); return v.every(x=>x && x===v[0] && !x.includes(',')); };
    const vNote='versione të ndryshme çmimesh — krahasimi nuk vlen';
    s5.push({n:'Kosto për porosi — java e fundit e plotë', why:'Pagesa për njësi (çmimet e versionit në fuqi) ÷ porosi të dalura. Alarm: rritet mbi 10% javë pas jave.', cad:'J', go:'capacity',
      v:cpo(cw)!=null? '€'+mmN(cpo(cw),3) : '—', s:`${fmtDateAl(mon).slice(0,5)}–${fmtDateAl(sun).slice(0,5)}: €${mmN(cw&&cw.piece,0)} / ${mmN(cw&&cw.orders)} porosi · java para €${mmN(cpo(cp),3)}${sameV(cw,cp)? mmArrow(cpo(cw),cpo(cp),true) : ' · '+vNote}`,
      lvl: cpo(cw)&&cpo(cp)&&sameV(cw,cp)? mmLvl((cpo(cw)/cpo(cp)-1)*100,5,10) : 'info'});
    const m1=mmIso(0).slice(0,8)+'01', pm=(()=>{ const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-01'; })(), pmEnd=mmIso(-new Date().getDate());
    const cm=yd>=m1? capPeriodCost(C,{from:m1,to:yd},{}) : null, cpm=capPeriodCost(C,{from:pm,to:pmEnd},{});
    s5.push({n:'Kosto për porosi — muaji', why:'Muaji në vazhdim (deri dje) kundrejt muajit të kaluar. Krahasimi vlen brenda të njëjtit version çmimesh.', cad:'M', go:'capacity',
      v:cpo(cm)!=null? '€'+mmN(cpo(cm),3) : '—', s:`muaji i kaluar €${mmN(cpo(cpm),3)}${sameV(cm,cpm)? mmArrow(cpo(cm),cpo(cpm),true) : ' · '+vNote} · versionet e çmimeve: ${[...new Set([...(cm&&cm.versions)||[], ...(cpm&&cpm.versions)||[]])].join(', ')||'—'}`,
      lvl: cpo(cm)&&cpo(cpm)&&sameV(cm,cpm)? mmLvl((cpo(cm)/cpo(cpm)-1)*100,5,10) : 'info'});
    // cost vs volume over 4 weeks
    const wk=i=>capPeriodCost(C,{from:mmIso(-dow-7*i), to:mmIso(-dow-7*i+6)},{}), a=[wk(4),wk(3)], b=[wk(2),wk(1)];
    const sum=(arr,k)=>arr.reduce((s,c)=>s+((c&&c[k])||0),0), cg=sum(a,'piece')? (sum(b,'piece')/sum(a,'piece')-1)*100 : null, og=sum(a,'orders')? (sum(b,'orders')/sum(a,'orders')-1)*100 : null;
    const sv=sameV(...a,...b);
    s5.push({n:'Kostoja kundrejt volumit', why:'Kostoja rritet më shpejt se porositë → joefikasitet. 2 javët e fundit kundrejt 2 javëve para.', cad:'M', go:'capacity',
      v: cg!=null&&og!=null? `${cg>=0?'+':''}${mmN(cg,0)}% / ${og>=0?'+':''}${mmN(og,0)}%` : '—', s:'kosto / porosi të dalura'+(sv? '' : ' · '+vNote), lvl: cg!=null&&og!=null&&sv? mmLvl(cg-og,5,10) : 'info'}); }
  if(C&&C.pay) s5.push({n:'Pagesa e fundit reale (WMS)', why:'Pagesa e llogaritur nga WMS për periudhën e mbyllur.', cad:'M', go:'capacity',
    v:'€'+mmN(C.pay.tc/Math.max(1,C.pay.orders),3), s:`${String(C.pay.mo).padStart(2,'0')}.${C.pay.y}: €${mmN(C.pay.tc,0)} / ${mmN(C.pay.orders)} porosi`, lvl:'info'});
  S.push({t:'Kostoja', sub:'', rows:s5});

  // ---------------------------------------------------------------- 6. Dërgesat
  const s6=[];
  if(!PP) s6.push(Object.assign({n:'POD: porosi në pritje sipas postës', cad:'D', go:'postat'}, mmLoading('Delivery Platform (herën e parë deri në 3 min)')));
  else if(PP.error||!PP.posts) s6.push({n:'POD: porosi në pritje sipas postës', cad:'D', go:'postat', v:'—', s:'nuk u lexua: '+h(PP.error||''), lvl:'na'});
  else { const main=PP.posts.filter(P=>/^(beki|express|fiks)/i.test(P.name)), mo=main.reduce((s,P)=>s+P.old,0);
    s6.push({n:'POD: porosi në pritje sipas postës', why:'Porosi që presin dërgimin për POD final. Alarm: porosi mbi 3 ditë (pa datë fikse, bank transfer, të papaguara).', cad:'D', go:'postat',
      v:`${mmN(PP.total)}`, s:`🔴 mbi 3 ditë: <b>${mmN(PP.old)}</b> · ${main.map(P=>`${h(P.name)} ${P.total}${P.old? ' ('+P.old+')' : ''}`).join(' · ')}`, lvl: mo>50? 'crit' : PP.old? 'warn' : 'ok'}); }
  if(!POD) s6.push(Object.assign({n:'Dorëzimi dje', cad:'D', go:'pod'}, mmLoading('Delivery Platform')));
  else if(POD.error||!POD.items) s6.push({n:'Dorëzimi dje', cad:'D', go:'pod', v:'—', s:'nuk u lexua: '+h(POD.error||''), lvl:'na'});
  else if(typeof isDelivered==='function'){ const out=POD.items.filter(isOutbound), n=out.length, del=out.filter(isDelivered).length, rf=out.filter(isRefused).length, tr=out.filter(isInTransit).length;
    const cash=out.filter(x=>isCash(x)&&isDelivered(x)), due=cash.reduce((s,x)=>s+(+x.price||0),0), got=cash.reduce((s,x)=>s+podCollected(x),0), late=POD.items.filter(x=>x.moreThan24HENisur||x.moreThan24HNePoste).length;
    // orders handed to the couriers yesterday are mostly still on the way: the delivery rate is information, the alarms are
    // refusals, delays over 24h and cash short of what is due
    s6.push({n:'POD-i i djeshëm: dorëzimi, refuzimet, vonesat, cash-i', why:'Dorëzimi i dërgesave të djeshme vazhdon ditët në vijim. Alarm: refuzime mbi 5%, vonesa > 24h, cash i arkëtuar më pak se për pagesë.', cad:'D', go:'pod',
      v:mmN(n), s:`porosi · dorëzuar ${mmPct(del,n)} · në rrugë ${mmPct(tr,n)} · refuzuar ${mmN(rf)} (${mmPct(rf,n,1)}) · > 24h: ${mmN(late)} · cash ${podMoney(got)} / ${podMoney(due)}`,
      lvl: !n? 'info' : got+0.01<due || rf/n>0.1? 'crit' : rf/n>0.05 || late? 'warn' : 'ok'}); }
  if(D&&D.car&&D.car.length){ const st=D.car.reduce((s,r)=>s+r[1],0), ok=D.car.reduce((s,r)=>s+r[2],0), worst=D.car.filter(r=>r[1]>=20).map(r=>[r[0],r[2]/r[1]*100]).sort((a,b)=>a[1]-b[1])[0];
    s6.push({n:'Transportuesit (mallrat hyrëse): në kohë', why:'Mbërritja aktuale kundrejt asaj të vlerësuar. Alarm: nën 80%.', cad:'M', go:'shipments',
      v:mmPct(ok,st), s:`${mmN(ok)} nga ${mmN(st)} ndalesa${worst? ' · më i dobëti: '+h(worst[0])+' '+mmN(worst[1],0)+'%' : ''}${K&&K.lateOpen!=null? ' · '+mmN(K.lateOpen)+' me ETA të kaluar pa mbërritje' : ''}`, lvl: st? mmLvlUp(ok/st*100,80,50) : 'info'}); }
  if(K&&K.retOpen!=null) s6.push({n:'Kthime të pazgjidhura', why:'Njësi kthimi ende pa vendim (ripranim, defekt, outlet). Stok i bllokuar.', cad:'J', go:'returns',
    v:mmN(K.retOpen), s:'ReturnDetails.IsResolved = 0', lvl:K.retOpen>500? 'warn' : 'ok'});
  S.push({t:'Dërgesat', sub:'POD, transportuesit, kthimet', rows:s6});

  // ---------------------------------------------------------------- 7. Saktësia e inventarit
  const s7=[];
  if(D&&D.insp&&D.insp.length){ const r=D.insp.filter(x=>x[4]+x[5]>=500)[0]||D.insp[0], p=r[5]/Math.max(1,r[4]+r[5])*100;
    s7.push({n:'Mungesat në inventarizim', why:'Produkte që mungojnë gjatë inventarizimit. Alarm: mungesat përsëriten në të njëjtat rreshta — problem me map-imin.', cad:'J', go:'pulse',
      v:`${mmN(p,1)}%`, s:`${h(r[1])} (${h(r[3]||'')}): ${mmN(r[5])} mungojnë nga ${mmN(r[4]+r[5])}`, lvl:mmLvl(p,2,10)}); }
  if(K&&K.diffOpen!=null){ const top=D&&D.diff&&D.diff[0];
    s7.push({n:'Diferencat e stokut me QuickBooks', why:'Trendi dhe produktet që përsëriten. Alarm: diferenca të hapura që rriten.', cad:'M', go:'pulse',
      v:mmN(K.diffOpen), s:`të hapura nga ${mmN(K.diffTotal)} · not-found të pazgjidhura ${mmN(K.nfOpen)}${top? ' · më e përsëritura: '+h(top[0])+' ('+top[2]+'×)' : ''}`, lvl: K.nfOpen>0||K.diffOpen>0? 'warn' : 'ok'}); }
  if(K&&K.rowsTotal){ const dense=D&&D.sect? D.sect.filter(r=>r[3]&&r[2]/r[3]>100) : [];
    s7.push({n:'Shfrytëzimi i lokacioneve', why:'Rreshta të mbingarkuar dhe bosh. Alarm: seksione me > 100 njësi për rresht.', cad:'M', go:'pulse',
      v:mmPct(K.rowsStock,K.rowsTotal), s:`${mmN(K.rowsStock)} nga ${mmN(K.rowsTotal)} rreshta me stok · ${mmN(K.onShelf)} njësi në rafte${dense.length? ' · të mbingarkuar: '+dense.slice(0,4).map(r=>h(r[1])).join(', ') : ''}`, lvl: dense.length? 'warn' : 'ok'}); }
  s7.push({n:'Porosi të parkuara gjatë (OrderRowMapping)', why:'Porosi të vendosura në rresht pritjeje që nuk lëvizin.', cad:'J', go:'pulse', v:'—', s:'ende pa burim në app — shtohet në WMS Pulse', lvl:'na'});
  S.push({t:'Saktësia e inventarit', sub:'', rows:s7});
  return S;
}

/* WH performance score, 0–100: each metric with a signal gives 🟢 100 · 🟠 60 · 🔴 20 points (information and missing data do
   not count); a sub-card's score is the average of its metrics; the total weighs the sub-cards — the order flow most.
   Colours (the lead, 07.10.2026): 0–60 red · 61–75 orange · 76–94 light green · 95–100 dark green, bold. */
const MM_PTS={ok:100, warn:60, crit:20}, MM_W=[25,15,15,15,10,10,10];
function mmScoreOf(rows){ const r=rows.filter(x=>MM_PTS[x.lvl]!=null); return r.length? r.reduce((s,x)=>s+MM_PTS[x.lvl],0)/r.length : null; }
function mmScoreStyle(p){ const v=Math.round(p);
  return v<=60? 'color:var(--crit);background:color-mix(in srgb,var(--crit) 10%,transparent);border-color:color-mix(in srgb,var(--crit) 40%,transparent)'
    : v<=75? 'color:#d35400;background:color-mix(in srgb,#e67e22 12%,transparent);border-color:color-mix(in srgb,#e67e22 45%,transparent)'
    : v<=94? 'color:#5aa95a;background:color-mix(in srgb,#5aa95a 10%,transparent);border-color:color-mix(in srgb,#5aa95a 40%,transparent)'
    : 'color:#14632f;font-weight:900;background:color-mix(in srgb,#1e8449 14%,transparent);border-color:#1e8449'; }
function drawMyMetrics(){
  const box=$('#mmBody'); if(!box) return;
  const P=mmSrc.P; if(!P){ box.innerHTML='<div class="empty">Po lexohen të dhënat…</div>'; return; }
  const S=mmSections(), all=S.flatMap(s=>s.rows), c=l=>all.filter(r=>r.lvl===l).length;
  S.forEach((s,i)=>{ s.score=mmScoreOf(s.rows); s.w=MM_W[i]||10; });
  const sc=S.filter(s=>s.score!=null), total= sc.length? sc.reduce((a,s)=>a+s.score*s.w,0)/sc.reduce((a,s)=>a+s.w,0) : null;
  const live=mmSrc.PP&&mmSrc.POD&&mmSrc.T;
  const sEl=$('#mmScore'); if(sEl) sEl.innerHTML= total==null? '' : `<span title="${h('Performanca e WH: '+S.map((s,i)=>`${i+1}. ${s.t} ${s.score==null? '—' : Math.round(s.score)+'%'} (pesha ${s.w}%)`).join('\n')+(live? '' : '\n(burimet live po lexohen — shifra mund të ndryshojë)'))}"
      style="display:inline-flex;align-items:baseline;gap:6px;padding:5px 12px;border:1px solid;border-radius:10px;margin-right:8px;cursor:help;${mmScoreStyle(total)}">
      <span style="font-size:12px;font-weight:600;opacity:.85">Performanca e WH</span><span style="font-size:22px;line-height:1;font-variant-numeric:tabular-nums">${Math.round(total)}%</span>${live? '' : '<span style="font-size:11px;opacity:.7">…</span>'}</span>`;
  const pick=r=> mmCad==='all' || (mmCad==='sig'? r.lvl==='crit'||r.lvl==='warn' : r.cad===mmCad);
  const at=P.generatedAt? String(P.generatedAt).replace('T',' ').slice(0,16) : '—';
  $('#mmBar').innerHTML=[['all','Të gjitha',all.length],['sig','Vetëm sinjalet 🔴🟠',c('crit')+c('warn')],['D','Ditore',all.filter(r=>r.cad==='D').length],['J','Javore',all.filter(r=>r.cad==='J').length],['M','Mujore',all.filter(r=>r.cad==='M').length]]
      .map(([k,l,n])=>`<span class="chip ${mmCad===k?'on':''}" data-mmc="${k}">${l} <b style="margin-left:5px">${n}</b></span>`).join('')
    + `<span class="small faint" style="margin-left:auto">🔴 ${c('crit')} · 🟠 ${c('warn')} · 🟢 ${c('ok')} · WMS Pulse ${h(at)}${mmSrc.PP&&mmSrc.POD&&mmSrc.T? '' : ' · burimet live po lexohen…'}</span>`;
  const dot={ok:'🟢', warn:'🟠', crit:'🔴', info:'⚪', na:'◌'}, col={ok:'var(--ok)', warn:'var(--warn)', crit:'var(--crit)'};
  box.innerHTML=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,520px),1fr));gap:14px">${S.map((s,i)=>{ const rows=s.rows.filter(pick); if(!rows.length) return '';
      const nc=s.rows.filter(r=>r.lvl==='crit').length, nw=s.rows.filter(r=>r.lvl==='warn').length;
      return `<div class="card" style="margin:0;border-top:4px solid ${nc? 'var(--crit)' : nw? 'var(--warn)' : 'var(--ok)'}">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px"><h3 style="margin:0">${i+1}. ${h(s.t)}</h3>${s.sub? `<span class="sub">${h(s.sub)}</span>` : ''}
          <span class="small" style="margin-left:auto">${nc? '🔴 '+nc+' ' : ''}${nw? '🟠 '+nw : ''}${!nc&&!nw? '<span style="color:var(--ok)">në rregull</span>' : ''}</span>
          ${s.score!=null? `<span class="small" title="Pikët e kësaj karte (pesha në total ${s.w}%)" style="padding:1px 8px;border:1px solid;border-radius:8px;${mmScoreStyle(s.score)}">${Math.round(s.score)}%</span>` : ''}</div>
        ${rows.map(r=>`<div style="display:flex;gap:10px;padding:9px 0;border-top:1px solid var(--line)">
          <div style="font-size:15px;line-height:1.3" title="${h({ok:'Në rregull',warn:'Për t\'u ndjekur',crit:'Kritike',info:'Informacion',na:'Pa të dhëna'}[r.lvl]||'')}">${dot[r.lvl]||'⚪'}</div>
          <div style="flex:1;min-width:0"><div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><b>${h(r.n)}</b>
              <span class="small faint" title="${h(MM_CAD[r.cad]||'')}">${h(MM_CAD[r.cad]||'')}</span>
              ${r.go? `<a href="#${h(r.go)}" class="small" style="margin-left:auto;white-space:nowrap">detajet →</a>` : ''}</div>
            <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-top:2px"><span style="font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;color:${col[r.lvl]||'inherit'}">${r.v}</span><span class="small">${r.s||''}</span></div>
            ${r.list? `<div class="small" style="margin-top:6px">${r.list}</div>` : ''}
            ${r.why? `<div class="small faint" style="margin-top:4px">${h(r.why)}</div>` : ''}</div></div>`).join('')}</div>`; }).join('')}</div>
    <div class="hint" style="margin-top:10px"><b>Performanca e WH</b> (lart, pranë Rifresko): çdo metrikë me sinjal jep 🟢 100 · 🟠 60 · 🔴 20 pikë (informacionet dhe ato pa të dhëna nuk numërohen); karta merr mesataren e metrikave të saj, totali i peshon kartat: rrjedha e porosive 25%, inbound, picking/check-out dhe njerëzit nga 15%, kostoja, dërgesat dhe inventari nga 10%. Ngjyra: 0–60 e kuqe · 61–75 portokalli · 76–94 e gjelbër e zbehtë · 95–100 e gjelbër e mbyllur.</div>
    <div class="hint" style="margin-top:6px">Ritmi: <b>çdo ditë</b> backlog-u sipas moshës, porositë e hapura, carryover-i, njësitë pa map dhe POD-i · <b>çdo javë</b> mediana dhe p90 porosi → check-out, bandat e produktivitetit, mungesat në inventar · <b>çdo muaj</b> kostoja për porosi, diferencat e stokut dhe transportuesit. Pragjet janë pikënisje: kalibroji pas 2–4 javësh sipas ditës normale të depos. Burimet: WMS Pulse (baza e WMS-it, rifreskim çdo orë / çdo ditë), Tabela ditore (live), Delivery Platform (live).</div>`;
  $$('[data-mmc]').forEach(b=>b.onclick=()=>{ mmCad=b.dataset.mmc; drawMyMetrics(); });
}
