/* =========================================================================
   INSIGHTS & ALERTS — automatic part, from WMS and the systems around it.
   Rule-based, data-derived findings (never an automatic root-cause conclusion), each with its evidence, the data
   source and how fresh that data is, plus a link to the page with the detail. Sources:
     /pulse/data       WMS database (WMS Pulse blocks A–J, refreshed hourly): productivity, orders, stock, inbound,
                       carriers, Inbound Flow, Order Flow, Kapaciteti & Stafi (capacity, same-day, operators)
     /stats/shifts     today's shifts × the planned schedule (WMS scans, live)
     /delivery/pod     POD of yesterday (Delivery Platform, live, no customer data)
   Levels: crit (act today) · imp (important) · warn (watch) · info (context). People appear only as initials.
   Loaded after shared.js and before app.js; uses capacity.js / inbound.js / app.js helpers at call time.
   =======================================================================*/
let wiSeq=0, wiFilter='all', wiPodMem=null;
const WI_LEVEL_ORDER={crit:0, imp:1, warn:2, info:3};
function wiAge(iso){ if(!iso) return null; return (Date.now()-new Date(String(iso).replace(' ','T')).getTime())/3600000; }
function wiFresh(iso){ const a=wiAge(iso); if(a==null) return '—'; return a<1? Math.round(a*60)+' min më parë' : a<48? Math.round(a)+' orë më parë' : Math.round(a/24)+' ditë më parë'; }
const wiN=x=> x==null||isNaN(x)? '—' : Math.round(x).toLocaleString();
const wiP=(a,b)=> b? Math.round(a/b*100) : 0;

function wiRules(P, shifts, pod){
  const out=[], add=(o)=>out.push(o), today=todayStr();
  /* ---------- data freshness ---------- */
  if(P){
    const a=wiAge(P.generatedAt);
    if(a!=null && a>3) add({kind:'Të dhënat e WMS Pulse s\'po rifreskohen', level:a>24?'crit':'imp', area:'Të dhënat',
      text:`Tabelat bazë të WMS Pulse (produktiviteti, stoku, inbound, transportuesit) janë lexuar për herë të fundit ${wiFresh(P.generatedAt)}. Rifreskimi automatik çdo orë nuk po funksionon.`,
      evidence:`generatedAt ${P.generatedAt} · detyra "WMS Pulse — rifreskim nga databaza" pret aprovimin e qasjes në databazë (Scheduled → Allow always)`, src:'WMS Pulse', at:P.generatedAt, go:'pulse'});
  }
  /* ---------- same-day & order flow ---------- */
  const C=P&&P.capacity;
  if(C&&C.sameDay&&C.sameDay.length){
    const sd=C.sameDay, last=sd[sd.length-1], first=sd[0], pct=w=>w.rb? w.rbSame/w.rb*100 : null, lp=pct(last), fp=pct(first);
    if(lp!=null && lp<100) add({kind:'Same-day nën target', level:lp<90?'crit':lp<95?'imp':'warn', area:'Rrjedha e porosive',
      text:`Java ${last.wk}: ${Math.round(lp)}% e porosive të gatshme deri 17:30 dolën të njëjtën ditë (targeti 100%). ${wiN(last.rbNext+last.rbLater)} porosi mbetën për ditët në vijim${fp!=null?`; trendi 8-javor: ${Math.round(fp)}% → ${Math.round(lp)}%`:''}.`,
      evidence:`${wiN(last.rb)} porosi gati deri 17:30 · ${wiN(last.rbSame)} të njëjtën ditë · ${wiN(last.rbNext)} të nesërmen · ${wiN(last.rbLater)} ≥ 2 ditë · mediana gati → check-out ${inbDur(+last.whP50)}`, src:'WMS (blloku J)', at:C.sameDayAt||C.at, go:'capacity'});
    if(fp!=null && lp!=null && lp-fp>=10) add({kind:'Përmirësim i qëndrueshëm', level:'info', area:'Rrjedha e porosive',
      text:`Same-day u rrit me ${Math.round(lp-fp)} pikë përqindjeje brenda 8 javëve (${Math.round(fp)}% → ${Math.round(lp)}%).`, evidence:sd.map(w=>w.wk+': '+Math.round(pct(w))+'%').join(' · '), src:'WMS (blloku J)', at:C.sameDayAt||C.at, go:'capacity'});
  }
  const O=P&&P.orders;
  if(O){
    const now=Date.now(), w=O.wait||[], age=o=>o.a1? (now-new Date(o.a1.replace(' ','T')).getTime())/3600000 : 0;
    const w72=w.filter(o=>age(o)>72), w24=w.filter(o=>age(o)>24&&age(o)<=72), noLines=w.filter(o=>!o.l), oldest=w.reduce((m,o)=>Math.max(m,age(o)),0);
    if(w72.length) add({kind:'Porosi që presin mbi 3 ditë në depo', level:w72.length>=20?'crit':'imp', area:'Rrjedha e porosive',
      text:`${w72.length} porosi kanë njësi të caktuara në depo prej më shumë se 72 orësh pa check-out (gjithsej në pritje: ${w.length}; 24–72 orë: ${w24.length}). Më e vjetra pret ${inbDur(oldest*60)}.`,
      evidence:`${wiN(w72.reduce((a,o)=>a+o.u,0))} njësi · ${noLines.length} prej tyre pa rreshta në WMS (mundësisht të anuluara) · ${w.filter(o=>o.dn>0).length} pjesërisht të dërguara`, src:'WMS (blloku G)', at:O.at, go:'orders'});
    const done=O.done||[], short=done.filter(o=>o.q!=null&&o.u<o.q);
    if(short.length) add({kind:'Porosi të dala me më pak njësi se porosia', level:'imp', area:'Saktësia',
      text:`${short.length} nga ${done.length} porosi me check-out sot kanë më pak njësi të skanuara se sasia e porosisë.`, evidence:short.slice(0,8).map(o=>o.id+' ('+o.u+'/'+o.q+')').join(', ')+(short.length>8?' …':''), src:'WMS (blloku G)', at:O.at, go:'orders'});
    const wh=done.map(o=>inbMin(o.xu? o.a2 : o.cr, o.c1)).filter(x=>x!=null&&x>=0).sort((a,b)=>a-b), whMed=wh.length? wh[Math.floor(wh.length/2)] : null;
    const jMed= C&&C.sameDay&&C.sameDay.length? +C.sameDay[C.sameDay.length-1].whP50 : null;
    if(whMed!=null && jMed && whMed>2*jMed && wh.length>=30) add({kind:'Koha e depos sot mbi normën', level:'imp', area:'Rrjedha e porosive',
      text:`Sot mediana "artikujt gati → check-out" është ${inbDur(whMed)}, mbi dyfishin e javës së kaluar (${inbDur(jMed)}).`, evidence:`${wh.length} porosi me check-out sot`, src:'WMS (blloku G)', at:O.at, go:'orders'});
    const um=O.unmaps||[]; if(um.length>=7){ const last=um[um.length-1], prev=um.slice(0,-1), avg=prev.reduce((a,x)=>a+x.n,0)/prev.length;
      if(last.d===today && last.n>avg*1.5 && last.n>=50) add({kind:'Lirime (unmap) mbi mesataren', level:'warn', area:'Saktësia',
        text:`Sot janë liruar ${last.n} njësi nga porositë, kundrejt mesatares ${Math.round(avg)}/ditë të 13 ditëve të mëparshme.`, evidence:um.slice(-7).map(x=>fmtDateAl(x.d).slice(0,5)+': '+x.n).join(' · '), src:'WMS (blloku G)', at:O.at, go:'orders'}); }
  }
  /* ---------- demand ---------- */
  if(C&&C.created&&C.created.length){
    const wd=C.created.filter(x=>!capWE(x.d)), st=capStats(wd.map(x=>x.o)), lateS=capStats(wd.map(x=>x.late));
    const peaks=wd.filter(x=>x.o>st.p90);
    if(peaks.length) add({kind:'Ditë me kërkesë mbi P90', level:'info', area:'Ngarkesa',
      text:`${peaks.length} ditë pune në 12 javët e fundit kaluan P90 (${wiN(st.p90)} porosi); maksimumi ${wiN(st.max)} (${fmtDateAl(wd.find(x=>x.o===st.max).d)}). Planifikimi i stafit duhet të mbulojë P90, jo mesataren (${wiN(st.avg)}).`,
      evidence:peaks.slice(-6).map(x=>fmtDateAl(x.d).slice(0,5)+': '+x.o).join(' · '), src:'WMS (blloku H)', at:C.at, go:'capacity'});
    if(st.avg) add({kind:'Pjesa e porosive pas cut-off-it', level:'info', area:'Ngarkesa',
      text:`${Math.round(lateS.avg/st.avg*100)}% e porosive të ditëve të punës krijohen pas orës 17:30 (${wiN(lateS.avg)}/ditë) dhe kalojnë në ditën pasuese.`, evidence:`mesatarja ${wiN(st.avg)} porosi/ditë pune · 12 javë`, src:'WMS (blloku H)', at:C.at, go:'capacity'});
  }
  /* ---------- capacity & coverage ---------- */
  if(C&&typeof capCompute==='function'){
    const cfg=capCfg(), R=capCompute(C, cfg), presentH=cfg.present*(cfg.shiftHours-cfg.breakMin/60), util=R.tot('avg')/presentH*100;
    if(util<65) add({kind:'Orë prezence të pashfrytëzuara', level:'imp', area:'Kapaciteti',
      text:`Ngarkesa standarde e ditës mesatare është ${R.tot('avg').toFixed(1)} orë, ndërsa prania është ≈ ${Math.round(presentH)} orë (${cfg.present} persona): shfrytëzim ≈ ${Math.round(util)}%. Mjaftojnë ${R.fteA('avg').toFixed(1)} FTE (P90: ${R.fteA('p90').toFixed(1)}).`,
      evidence:`kohët standarde nga Process Measurement · vëllimet 12 javë · ${cfg.util}% shfrytëzim i synuar · ${cfg.absence}% mungesa`, src:'Kapaciteti & Stafi', at:C.at, go:'capacity'});
    if(R.fteA('peak')>R.available) add({kind:'Kapacitet i pamjaftueshëm për ditët e pikut', level:'warn', area:'Kapaciteti',
      text:`Një ditë piku (si maksimumi i 12 javëve) kërkon ${R.fteA('peak').toFixed(1)} FTE, kurse janë ${R.available.toFixed(1)} të disponueshme; mungojnë ≈ ${(R.fteA('peak')-R.available).toFixed(1)}. Planifiko sezonalë për Black Friday / festat.`,
      evidence:`check-out max ${wiN(R.S.co.max)} njësi/ditë kundrejt mesatares ${wiN(R.S.co.avg)}`, src:'Kapaciteti & Stafi', at:C.at, go:'capacity'});
    const hr=(C.hourly||[]), wdN=Math.max(1,new Set(C.vol.filter(v=>!capWE(v.d)).map(v=>v.d)).size), op=hh=>{ const x=hr.find(r=>r.h===hh); return x? x.anyOps/wdN : 0; };
    const morning=[7,8].map(op), evening=[18,19,20].map(op);
    if(morning.some(x=>x<2.5)) add({kind:'Vrimë mbulimi në mëngjes', level:'imp', area:'Mbulimi',
      text:`Në orën 07 skanojnë mesatarisht ${op(7).toFixed(1)} operatorë dhe në 08 ${op(8).toFixed(1)}, edhe pse turni N1 fillon në 07:00. Puna me skaner nis kryesisht pas orës 09.`,
      evidence:`ditë pune të 12 javëve · operatorë me ≥ 1 skanim në orë · ${hr.filter(r=>r.h>=7&&r.h<=10).map(r=>String(r.h).padStart(2,'0')+':00 '+(r.anyOps/wdN).toFixed(1)).join(' · ')}`, src:'WMS (blloku H)', at:C.at, go:'capacity'});
    if(evening.some(x=>x<3)){ const co=hh=>{ const x=hr.find(r=>r.h===hh); return x? x.co/wdN : 0; };
      add({kind:'Mbrëmja e hollë në check-out', level:'warn', area:'Mbulimi',
      text:`Në 18–20 skanojnë ${evening.map(x=>x.toFixed(1)).join(' / ')} operatorë, ndërsa check-out-i vazhdon me ${[18,19,20].map(h=>Math.round(co(h))).join(' / ')} njësi/orë — rruga kryesore drejt 100% same-day.`,
      evidence:'ditë pune të 12 javëve', src:'WMS (blloku H)', at:C.at, go:'capacity'}); }
    const ops=C.ops||[], tot={ci:0,mp:0,co:0}; ops.forEach(o=>{ tot.ci+=o.ci; tot.mp+=o.mp; tot.co+=o.co; });
    [['co','check-out'],['mp','mapping'],['ci','check-in']].forEach(([k,l])=>{ const s=ops.filter(o=>!o.tmp).sort((a,b)=>b[k]-a[k])[0]; if(!s||!tot[k]) return; const sh=s[k]/tot[k];
      if(sh>0.2) add({kind:'Varësi nga një person', level:sh>0.3?'imp':'warn', area:'Mbulimi',
        text:`${s.i} (${s.id}) bën ${Math.round(sh*100)}% të ${l}-ut (${wiN(s[k])} nga ${wiN(tot[k])} njësi në 12 javë). Mungesa e tij/saj godet procesin; trajno 2 backup.`,
        evidence:`personat me ≥ 1.000 njësi në ${l}: ${ops.filter(o=>!o.tmp&&o[k]>=1000).length}`, src:'WMS (blloku I)', at:C.opsAt||C.at, go:'capacity'}); });
    const tmp=ops.filter(o=>o.tmp), tmpU=tmp.reduce((a,o)=>a+o.ci+o.mp+o.co,0), allU=tot.ci+tot.mp+tot.co;
    if(tmpU && allU) add({kind:'Punë me llogari të përbashkëta (Temp)', level:wiP(tmpU,allU)>=10?'imp':'warn', area:'Saktësia',
      text:`${wiP(tmpU,allU)}% e njësive të 12 javëve (${wiN(tmpU)}) janë skanuar me ${tmp.length} llogari Temp — produktiviteti dhe gabimet s'i atribuohen askujt.`,
      evidence:tmp.map(o=>o.i+'('+o.id+'): '+wiN(o.ci+o.mp+o.co)).join(' · '), src:'WMS (blloku I)', at:C.opsAt||C.at, go:'capacity'});
    const weak=R.rows.filter(r=>r.weak||r.assumed);
    if(weak.length) add({kind:'Kohë standarde me pak matje', level:'warn', tag:'hyp', area:'Të dhënat',
      text:`${weak.length} hapa llogariten me supozim ose me më pak se 5 matje: ${weak.map(r=>r.p).join(', ')}. FTE-të kanë pasiguri derisa të maten.`, evidence:weak.map(r=>r.p+': '+r.s.toFixed(1)+' s ('+r.src+')').join(' · '), src:'Process Measurement', at:null, go:'timer'});
  }
  /* ---------- inbound ---------- */
  const I=P&&P.inbound;
  if(I&&I.batches){
    const now=new Date(), b=I.batches, aw24=b.filter(x=>x.aw>0 && x.c2 && (now-inbT(x.c2))>24*3600000), noCi=b.filter(x=>!x.n && (now-inbT(x.rcv))>2*3600000), mis=b.filter(x=>x.ex!=null && x.ss===3 && x.n<x.ex);
    if(aw24.length) add({kind:'Mall i pa mapuar mbi 24 orë', level:aw24.reduce((a,x)=>a+x.aw,0)>=100?'imp':'warn', area:'Inbound',
      text:`${wiN(aw24.reduce((a,x)=>a+x.aw,0))} njësi në ${aw24.length} furnizime presin mapimin prej më shumë se 24 orësh pas check-in-it.`, evidence:aw24.slice(0,6).map(x=>x.id+' ('+x.aw+')').join(', ')+(aw24.length>6?' …':''), src:'WMS (blloku F)', at:I.at, go:'inbound'});
    if(noCi.length) add({kind:'Furnizime të hapura pa check-in', level:noCi.length>=10?'imp':'warn', area:'Inbound',
      text:`${noCi.length} furnizime janë hapur më shumë se 2 orë më parë pa asnjë njësi të check-in-uar.`, evidence:noCi.slice(0,8).map(x=>x.id).join(', ')+(noCi.length>8?' …':''), src:'WMS (blloku F)', at:I.at, go:'inbound'});
    if(mis.length) add({kind:'Furnizime të mbyllura me më pak njësi se fatura', level:'imp', area:'Inbound',
      text:`${mis.length} furnizime u mbyllën ("Done") me më pak njësi të check-in-uara se fatura — ${wiN(mis.reduce((a,x)=>a+(x.ex-x.n),0))} njësi mungojnë gjithsej.`, evidence:mis.slice(0,6).map(x=>x.id+' ('+x.n+'/'+x.ex+')').join(', ')+(mis.length>6?' …':''), src:'WMS (blloku F)', at:I.at, go:'inbound'});
    const d=I.daily||[]; if(d.length>=7){ const r=d.slice(-3).filter(x=>x.cm!=null), e=d.slice(0,-3).filter(x=>x.cm!=null), ar=r.reduce((a,x)=>a+x.cm,0)/Math.max(1,r.length), ae=e.reduce((a,x)=>a+x.cm,0)/Math.max(1,e.length);
      if(r.length&&e.length&&ar>ae*1.5&&ar>12*60) add({kind:'Check-in → map po zgjatet', level:'warn', area:'Inbound', text:`3 ditët e fundit: check-in → map mesatarisht ${inbDur(ar)}, kundrejt ${inbDur(ae)} më parë.`, evidence:d.slice(-7).map(x=>fmtDateAl(x.d).slice(0,5)+': '+(x.cm!=null?inbDur(x.cm):'—')).join(' · '), src:'WMS (blloku F)', at:I.at, go:'inbound'}); }
  }
  /* ---------- stock, inventory, carriers (WMS Pulse A–E) ---------- */
  if(P&&P.K&&P.D){
    const K=P.K, D=P.D;
    if(K.nfOpen) add({kind:'Produkte "not found" të pazgjidhura', level:K.nfOpen>=50?'imp':'warn', area:'Stoku', text:`${wiN(K.nfOpen)} raportime "not found" janë ende të hapura (nga ${wiN(K.nfTotal)} gjithsej).`, evidence:'NotFoundProducts (FixedBy bosh)', src:'WMS Pulse', at:P.generatedAt, go:'pulse'});
    if(K.diffOpen) add({kind:'Diferenca WMS–QuickBooks të hapura', level:K.diffOpen>=1000?'imp':'warn', area:'Stoku', text:`${wiN(K.diffOpen)} diferenca stoku WMS kundrejt QuickBooks janë të pazgjidhura (nga ${wiN(K.diffTotal)} regjistrime).`, evidence:(D.diff||[]).slice(0,5).map(r=>r[0]+' |'+r[3]+'|').join(', '), src:'WMS Pulse', at:P.generatedAt, go:'pulse'});
    const dense=(D.sect||[]).filter(r=>r[3]&&r[2]/r[3]>100);
    if(dense.length) add({kind:'Seksione me ngarkesë jonormale për rresht', level:'info', area:'Stoku', text:dense.map(r=>`"${r[1]}" mban ${wiN(r[2])} njësi në ${r[3]} rreshta`).join('; ')+' — zonë bulk/staging, jo rafte normale.', evidence:'ProductCheckIns StatusId 7 · Rows → Shelves → Sections', src:'WMS Pulse', at:P.generatedAt, go:'pulse'});
    const pi=(D.insp||[]).filter(r=>r[4]+r[5]>0 && r[5]/(r[4]+r[5])>0.5);
    if(pi.length) add({kind:'Inventarizime të pjesshme', level:'info', area:'Stoku', text:`${pi.length} nga ${D.insp.length} inventarizimet e fundit kanë mbi 50% "missing": ${pi.slice(0,3).map(r=>'"'+r[1]+'"').join(', ')} — numërime të një zone, jo të gjithë depos; saktësia s'është e krahasueshme.`, evidence:pi.slice(0,3).map(r=>r[1]+': '+wiN(r[4])+' skanuar / '+wiN(r[5])+' mungon').join(' · '), src:'WMS Pulse', at:P.generatedAt, go:'pulse'});
    (D.car||[]).filter(r=>r[1]>=20 && r[2]/r[1]<0.6).forEach(r=>add({kind:'Transportues me mbërritje të vonuara', level:r[2]/r[1]<0.4?'imp':'warn', area:'Inbound',
      text:`${r[0]}: vetëm ${wiP(r[2],r[1])}% e ${wiN(r[1])} ndalesave mbërrijnë në kohë; vonesa mesatare ${r[3]!=null? (+r[3]).toFixed(1)+' ditë' : '—'}.`, evidence:'ShipmentDestinations: datë mbërritjeje ≤ datë e pritur', src:'WMS Pulse', at:P.generatedAt, go:'pulse'}));
    if(K.lateOpen) add({kind:'Ndalesa të vonuara pa mbërritje', level:K.lateOpen>=100?'imp':'warn', area:'Inbound', text:`${wiN(K.lateOpen)} ndalesa transporti e kanë kaluar datën e pritur dhe ende s'kanë mbërritur.`, evidence:'ShipmentDestinations: ActualArrivalDate bosh, EstimatedArrivalDate < sot', src:'WMS Pulse', at:P.generatedAt, go:'pulse'});
    const below=(D.bands||[]).filter(r=>r[3]==='Below'&&r[2]>=5).length, tot=(D.bands||[]).filter(r=>r[2]>=5).length;
    if(tot && below/tot>=0.3) add({kind:'Shumë operatorë nën mesataren e ekipit', level:'info', area:'Produktiviteti', text:`${below} nga ${tot} llogari me ≥ 5 ditë aktive janë nën 75% të mesatares së ekipit (${(+P.K.avg).toFixed(0)} op. të peshuara/ditë) në 30 ditë — kontrollo ndarjen e punës dhe punët pa skaner para se të nxjerrësh përfundime individuale.`, evidence:'ProductLogs 2/7/4,18 · pesha 0.8/0.6/1.0', src:'WMS Pulse', at:P.generatedAt, go:'pulse'});
    const st25=(D.status||[]).filter(r=>r[2]===25).reduce((a,r)=>a+r[5],0);
    if(st25) add({kind:'Porosi në status "At warehouse / Local Seller" mbi 72h', level:'warn', area:'Rrjedha e porosive', text:`${wiN(st25)} porosi të krijuara në 30 ditët e fundit janë ende në statusin 25 pas më shumë se 72 orësh (të gjitha depot).`, evidence:'Orders.WmsStatusId = 25 · mosha > 72h', src:'WMS Pulse', at:P.generatedAt, go:'pulse'});
  }
  /* ---------- shifts × schedule (today, live) ---------- */
  if(shifts && !shifts.error){
    const abs=shifts.absences||[], un=shifts.unplanned||[];
    if(abs.length) add({kind:'Të planifikuar pa asnjë skanim sot', level:abs.length>=3?'imp':'warn', area:'Prania',
      text:`${abs.length} operatorë të planifikuar sot nuk kanë asnjë skanim në WMS (mungesë e mundshme, punë pa skaner ose llogari Temp).`, evidence:abs.map(a=>initialsOf(a.operator)+' '+a.hours).join(' · '), src:'WMS × orari', at:shifts.refreshedAt, go:'wms'});
    if(un.length) add({kind:'Punë jashtë orarit të planifikuar', level:'warn', area:'Prania',
      text:`${un.length} operatorë skanojnë sot jashtë orarit të tyre ose pa qenë në plan — përditëso orarin nëse ka pasur ndërrime.`, evidence:un.map(u=>initialsOf(u.operator)+' '+u.first+'–'+u.last).join(' · '), src:'WMS × orari', at:shifts.refreshedAt, go:'wms'});
  }
  /* ---------- POD (yesterday, live) ---------- */
  if(pod && !pod.error && pod.items){
    const out1=pod.items.filter(x=>!x.type||/^outbound$/i.test(x.type)), n=out1.length, del=out1.filter(isDelivered).length, rf=out1.filter(isRefused).length;
    const late=pod.items.filter(x=>x.moreThan24HENisur||x.moreThan24HNePoste).length, cashMiss=out1.filter(x=>isDelivered(x)&&isCash(x)&&x.price>0&&podCollected(x)+0.009<x.price);
    if(n && del/n<0.8) add({kind:'Shkalla e dorëzimit e ulët (dje)', level:del/n<0.6?'imp':'warn', area:'POD',
      text:`Dje u dorëzuan ${wiP(del,n)}% e ${wiN(n)} porosive për dorëzim (${wiN(del)}); ${wiN(out1.filter(isInTransit).length)} mbetën në rrugë dhe ${wiN(out1.filter(isWaiting).length)} pa u nisur.`, evidence:`${pod.deliveries.length} dërgesa · ${new Set(pod.deliveries.map(d=>d.driver)).size} kurierë`, src:'Delivery Platform', at:pod.at, go:'pod'});
    if(rf && rf/n>=0.03) add({kind:'Refuzime nga klientët', level:rf/n>=0.06?'imp':'warn', area:'POD', text:`Dje u refuzuan ${rf} porosi (${(rf/n*100).toFixed(1)}%).`, evidence:'statusi i dorëzimit "refuzuar"', src:'Delivery Platform', at:pod.at, go:'pod'});
    if(late) add({kind:'Dërgesa me vonesë mbi 24 orë', level:late>=20?'imp':'warn', area:'POD', text:`${late} porosi janë mbi 24 orë "të nisura" ose "në postë" pa u dorëzuar.`, evidence:'flamujt moreThan24HENisur / moreThan24HNePoste', src:'Delivery Platform', at:pod.at, go:'pod'});
    if(cashMiss.length) add({kind:'Cash i pa arkëtuar', level:'crit', area:'POD', text:`${cashMiss.length} porosi cash të dorëzuara dje s'kanë as cash të pranuar as shënim pagese (gjithsej ${podMoney(cashMiss.reduce((a,x)=>a+x.price-podCollected(x),0))}).`, evidence:cashMiss.slice(0,6).map(x=>x.orderId+' '+podMoney(x.price)).join(', '), src:'Delivery Platform', at:pod.at, go:'pod'});
  }
  return out.sort((a,b)=>WI_LEVEL_ORDER[a.level]-WI_LEVEL_ORDER[b.level]);
}
function initialsOf(name){ return String(name||'').split(/\s+/).filter(Boolean).map(s=>s[0].toUpperCase()+'.').join(''); }

function wmsInsightsHTML(){
  return `<div class="card" style="margin-bottom:14px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <h3 style="margin:0">📡 Nga WMS <span class="sub">plotësohet automatikisht · WMS, orari, Delivery Platform</span></h3>
      <span id="wiAt" class="small faint" style="margin-left:auto"></span></div>
    <div id="wiBody" style="margin-top:10px"><div class="empty">Po analizohen të dhënat…</div></div></div>`;
}
async function loadWmsInsights(){
  const box=$('#wiBody'); if(!box) return;
  if(!wmsOnAgent()){ box.innerHTML='<div class="empty">Hape app-in nga http://localhost:8790 që të shohësh gjetjet nga WMS.</div>'; return; }
  const seq=++wiSeq, yd=(()=>{ const d=new Date(); d.setDate(d.getDate()-1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })();
  const get=u=>fetch(u,{cache:'no-store'}).then(r=>r.json()).catch(e=>({error:e.message}));
  const [P, shifts]=await Promise.all([get('/pulse/data'), get('/stats/shifts?mode=day&date='+todayStr())]);
  if(seq!==wiSeq) return;
  // POD of a whole day takes ~10 s: keep the last result in memory so a re-render (e.g. after a shared-DB sync) shows it at once
  let pod= wiPodMem && wiPodMem.date===yd? wiPodMem : null; const draw=()=>{ if(seq===wiSeq) drawWmsInsights(P&&!P.error? P : null, shifts, pod); };
  draw();
  if(!pod) get('/delivery/pod?date='+yd).then(j=>{ if(j&&!j.error) wiPodMem=j; pod=j; draw(); });
}
function drawWmsInsights(P, shifts, pod){
  const box=$('#wiBody'); if(!box) return;
  const all=wiRules(P, shifts, pod), areas=[...new Set(all.map(i=>i.area))];
  const cnt=l=>all.filter(i=>i.level===l).length;
  const atEl=$('#wiAt'); if(atEl) atEl.innerHTML=`${cnt('crit')} 🔴 · ${cnt('imp')} 🟠 · ${cnt('warn')} 🟡 · ${cnt('info')} 💡${pod? '' : ' · POD po lexohet…'}`;
  if(!all.length){ box.innerHTML='<div class="empty">Asnjë sinjal nga të dhënat e WMS-it.</div>'; return; }
  const list=all.filter(i=> wiFilter==='all' || i.level===wiFilter || i.area===wiFilter);
  box.innerHTML=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      ${[['all','Të gjitha',all.length],['crit','🔴 Kritike',cnt('crit')],['imp','🟠 Të rëndësishme',cnt('imp')],['warn','🟡 Për t\'u ndjekur',cnt('warn')]].concat(areas.map(a=>[a,a,all.filter(i=>i.area===a).length]))
        .filter(x=>x[2]>0).map(([k,l,n])=>`<span class="chip ${wiFilter===k?'on':''}" data-wif="${h(k)}">${h(l)} <b style="margin-left:5px">${n}</b></span>`).join('')}</div>
    <div class="grid g-2">${list.map(wiCard).join('')}</div>
    <div class="hint" style="margin-top:8px">Gjetje të nxjerra me rregulla nga të dhënat, jo përfundime automatike për shkakun. Burimet: WMS (WMS Pulse, blloqet A–J, rifreskim çdo orë), statistikat e ndërrimeve sipas orarit (live), POD-i i djeshëm nga Delivery Platform-i (pa të dhëna personale të klientëve). Personat paraqiten me inicialet.</div>`;
  $$('[data-wif]').forEach(c=>c.onclick=()=>{ wiFilter=c.dataset.wif; drawWmsInsights(P, shifts, pod); });
  $$('[data-wigo]').forEach(b=>b.onclick=()=>{ location.hash='#'+b.dataset.wigo; });
}
function wiCard(i){
  const dot={crit:'🔴',imp:'🟠',warn:'🟡',info:'💡'}[i.level]||'💡';
  return `<div class="card" style="${i.level==='crit'?'border-color:#f3c1c1':''}">
    <h3>${dot} ${h(i.kind)} <span class="sub"><span class="etag et-${i.tag==='hyp'?'hyp':'data'}">${i.tag==='hyp'?'hypothesis':'data-derived'}</span> ${h(i.area)}</span></h3>
    <div>${h(i.text)}</div>
    <div class="hint" style="margin-top:8px">Evidenca: ${h(i.evidence)}</div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px"><span class="small faint">Burimi: ${h(i.src)}${i.at? ' · '+h(wiFresh(i.at)) : ''}</span>
      ${i.go? `<button class="btn sm ghost" style="margin-left:auto" data-wigo="${h(i.go)}">Detajet →</button>` : ''}</div></div>`;
}
