/* ============================================================================
   Detection engine of the Problem / Bottleneck Register: snapshot (adapter.js) → metrics, CANDIDATES and the system
   constraint. A candidate is never a problem by itself: the lead accepts, merges or dismisses it in the app.
   Every candidate carries: the metric, its current value, the 4-week baseline, the threshold (Settings), the period and
   scope, n and a confidence level, what is FACT (from the data), HYPOTHESIS (to verify at the Gemba) and UNCONFIRMED
   (inferred WMS meanings), the impact on a business objective, 2–3 cause hypotheses and concrete Gemba questions.
   "Current" = the last 7 full days (or the last ISO week); "baseline" = the 28 days before. Today is never used:
   it is incomplete. Individuals appear as initials + the last 3 digits of the WMS UserId, for development, not blame.
   ==========================================================================*/
'use strict';

const DET_DEFAULTS={
  roster:17, breakMin:30, minN:30,
  carryMax:0,            // D1  orders/day carried over (ready by cut-off, out next day or later)
  leadP50Max:48,         // D2  hours, median order → first check-out
  leadRisePct:20,        // D2  p90 above baseline by more than this %
  utilMax:85,            // D3  % utilisation that marks the constraint
  mapWaitMax:50,         // D4  units waiting for mapping longer than mh hours
  mapP90Max:240,         // D4  minutes, check-in → map, p90
  cycleTolPct:10,        // D5  % above the WMS standard time
  declinePct:15,         // D6  week-on-week drop
  gapMax:45,             // D6  minutes/person/day of gaps > gm, after the break
  bandHi:1.25, bandLo:0.75,
  sharedMax:0, noUserMax:20, only27Max:10, unknownTypePct:5,      // D7
  supplyStuckMax:10, supplyStaleMax:100,                          // D8
  staleDays:60,                                                   // D9/D10 source not written for this long
  missPctMax:1,                                                   // D9 % missing in the last full inspection
  rowFactor:10,                                                   // D10 units on a row > median × this
  lateMax:20,                                                     // D11 % of inbound stops arriving after the estimated date
  ageMax:50,                                                      // D12 orders without check-out older than 3 days, per status
  costMax:null, costRisePct:10,                                   // D13 €/order
  p1:64, p2:27                                                    // RPN thresholds for P1 / P2
};
const KNOWN_TYPES=[2,3,4,6,7,9,18,27];
const PLAT={0:'të dyja',1:'GjirafaMall',2:'Gjirafa50'};

/* ---------------------------------------------------------------- helpers */
const J=v=> v==null? [] : typeof v==='string'? JSON.parse(v) : v;
const r1=x=>Math.round(x*10)/10, r2=x=>Math.round(x*100)/100;
const sum=a=>a.reduce((s,x)=>s+(+x||0),0);
const avg=a=>a.length? sum(a)/a.length : 0;
function q(a,p){ const s=a.filter(x=>x!=null&&!isNaN(x)).sort((x,y)=>x-y); if(!s.length) return null; const i=(s.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo); }
const iso=d=>d.toISOString().slice(0,10);
function addDays(isoD,n){ const d=new Date(isoD+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return iso(d); }
const isWe=d=>{ const w=new Date(d+'T12:00:00Z').getUTCDay(); return w===0||w===6; };
const fmtD=d=>d? d.slice(8,10)+'.'+d.slice(5,7) : '';
function windows(today){ const cur={from:addDays(today,-7), to:addDays(today,-1)}, base={from:addDays(today,-35), to:addDays(today,-8)}; return {cur, base}; }
const inW=(d,w)=> d>=w.from && d<=w.to;
function conf(n, opts={}){ let c= n>=(opts.minN||30) && (opts.days==null||opts.days>=5)? 'e lartë' : n>=10? 'e mesme' : 'e ulët';
  if(opts.inferred && c==='e lartë') c='e mesme'; return c; }
function scopeText(b){ const s=(b&&b.scope)||{}; const parts=['Depo '+(s.wh||1)];
  if(s.pf!=null) parts.push('platforma: '+(PLAT[s.pf]||s.pf)); if(s.nd) parts.push(s.nd+' ditë');
  if(s.co) parts.push('cut-off '+s.co); return parts.join(' · '); }
function occFromDays(k, of){ const r=of? k/of : 0; return r>=0.85? 5 : r>=0.6? 4 : r>=0.35? 3 : k>0? 2 : 1; }

/* ---------------------------------------------------------------- engine */
function detect(snap, cfgIn){
  const cfg=Object.assign({}, DET_DEFAULTS, cfgIn||{});
  const B=(snap&&snap.blocks)||{};
  const genOf=b=> b&&b.row&&b.row.gen? String(b.row.gen).slice(0,10) : null;
  const today=genOf(B.D1)||genOf(B.D3)||iso(new Date());
  const W=windows(today);
  const out={ at:new Date().toISOString(), snapshotId:snap&&snap.id, today, windows:W, metrics:{}, candidates:[], notes:[], constraint:null, detail:{},
    blocks:Object.fromEntries(Object.entries(B).map(([k,b])=>[k,{at:b.at, source:b.source, scope:scopeText(b)}])) };
  const metric=(key,m)=>{ out.metrics[key]=Object.assign({key}, m); return key; };
  const cand=c=>{ c.snapshotId=snap&&snap.id; c.suggest=c.suggest||{}; c.suggest.det=c.suggest.det||2;
    c.tags=Object.assign({fact:[],hyp:[],unconfirmed:[]}, c.tags||{}); out.candidates.push(c); };
  const note=(detector,text,kind)=>out.notes.push({detector,text,kind:kind||'info'});
  const run=(k,fn)=>{ if(!B[k]) { note(k,'Blloku '+k+' nuk është ekzekutuar ende.','missing'); return; } try{ fn(B[k]); }catch(e){ note(k,'Gabim në llogaritje: '+e.message,'error'); } };

  /* D1 carryover --------------------------------------------------------- */
  run('D1', b=>{
    const cells=J(b.row.cell), open=B.D1o? J(B.D1o.row.openDaily) : [];
    const byDay={};
    cells.forEach(c=>{ const o=byDay[c.d]=byDay[c.d]||{rb:0,same:0,carry:0,xd:0,open:0,openAfter:0,partial:0}; o.rb+=c.rb; o.same+=c.same; o.carry+=c.carry; o.xd+=c.carryXd; });
    open.forEach(c=>{ const o=byDay[c.d]=byDay[c.d]||{rb:0,same:0,carry:0,xd:0,open:0,openAfter:0,partial:0}; o.open+=c.openReady; o.openAfter+=c.afterCo||0; o.partial+=c.partial; });
    const days=Object.keys(byDay).filter(d=>d<today).sort();
    const tot=d=>byDay[d].carry+byDay[d].open, ready=d=>byDay[d].rb+byDay[d].open;
    const series=days.map(d=>({d, v:tot(d)}));
    const cur=days.filter(d=>inW(d,W.cur)), base=days.filter(d=>inW(d,W.base));
    const vCur=avg(cur.map(tot)), vBase=avg(base.map(tot));
    const readyCur=sum(cur.map(ready)), carryCur=sum(cur.map(tot)), rate=readyCur? carryCur/readyCur : 0;
    const byPf={1:0,2:0}, byHour={}; cells.filter(c=>inW(c.d,W.cur)).forEach(c=>{ byPf[c.pf]=(byPf[c.pf]||0)+c.carry; byHour[c.h]=(byHour[c.h]||0)+c.carry; });
    const xdShare=sum(cur.map(d=>byDay[d].xd))/Math.max(1,sum(cur.map(d=>byDay[d].carry)));
    const topHours=Object.entries(byHour).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([h,n])=>h.padStart(2,'0')+':00 ('+n+')');
    const openNow=sum(open.map(o=>o.openReady)), partialNow=sum(open.map(o=>o.partial));
    out.detail.D1={days:days.map(d=>Object.assign({d},byDay[d])), byPf, byHour, openNow, partialNow};
    metric('D1.carry',{detector:'D1', label:'Carryover — porosi të gatshme deri në cut-off që dalin ditën tjetër ose më vonë', unit:'porosi/ditë', better:'lower', target:cfg.carryMax, series});
    if(vCur>cfg.carryMax){
      const daysWith=cur.filter(d=>tot(d)>0).length;
      cand({ key:'D1.carry', detector:'D1', metricKey:'D1.carry', blocks:['D1','D1o'],
        title:'Porosi të gatshme para cut-off nuk dalin të njëjtën ditë (carryover)', phase:'Checkout/Packing', category:'Proces',
        symptom:`Mesatarisht ${r1(vCur)} porosi/ditë ishin gati në depo deri në ${(b.scope&&b.scope.co)||'17:30'} por dolën ditën tjetër ose ende s'kanë dalë (${r1(rate*100)}% e porosive të gatshme).`,
        value:r1(vCur), baseline:r1(vBase), threshold:cfg.carryMax, unit:'porosi/ditë', better:'lower',
        period:W.cur, baselinePeriod:W.base, scope:scopeText(b), n:readyCur, confidence:conf(readyCur,{days:cur.length}),
        impact:{objective:'Same-day', value:r1(vCur), text:`${r1(vCur)} porosi carryover/ditë (${r1(rate*100)}% e të gatshmeve) — objektivi: 0`},
        tags:{ fact:[`${carryCur} porosi carryover në 7 ditë: GjirafaMall ${byPf[1]||0}, Gjirafa50 ${byPf[2]||0} (të mbyllura) + ${sum(cur.map(d=>byDay[d].open))} ende pa dalë`,
                     `Orët e krijimit me më shumë carryover: ${topHours.join(', ')||'—'}`, `Pjesa cross-dock (njësi të rezervuara në check-in): ${r1(xdShare*100)}%`],
               hyp:[], unconfirmed:['"Gati" = krijimi i porosisë ose njësia e fundit e rezervuar (LogType 3, e nxjerrë); porositë nga stoku pa LogType 3 konsiderohen gati në krijim.'] },
        hypotheses:[ 'Kapaciteti i check-out-it pas orës 15:00 nuk mjafton për porositë që bëhen gati afër cut-off (rrjedha për orë, D3).',
          'Njësitë cross-dock mbërrijnë/rezervohen vonë dhe porosia bëhet gati pak para cut-off, pa kohë për paketim.',
          'Porositë e gatshme nuk ndiqen me prioritet (FIFO / lista e cut-off-it) — mbeten në raft ose në zonën e pritjes.' ],
        gemba:[ 'Ora 16:30–17:30: sa porosi të gatshme janë në zonën e check-out-it dhe sa operatorë punojnë aty?',
          'Merr 5 porosi nga lista e carryover-it të djeshëm: ku ishin në 17:30 dhe pse nuk dolën?',
          'A ka listë/sinjal për porositë që duhet të dalin para cut-off? Kush e ndjek?' ],
        suggest:{ sev: rate>=0.1? 5 : rate>=0.05? 4 : rate>=0.02? 3 : 2, occ:occFromDays(daysWith, cur.length) } });
    }
    if(partialNow) note('D1',`${partialNow} porosi kanë një pjesë të njësive të rezervuara dhe presin të tjerat (shitës/furnitor) — nuk numërohen si carryover i depos.`);
  });

  /* D2 lead time ---------------------------------------------------------- */
  run('D2', b=>{
    const wk=J(b.row.week), dow=J(b.row.dow), hr=J(b.row.hour);
    if(wk.length<2) return;
    const cur=wk[wk.length-1], base=wk.slice(-5,-1);
    const bP90=avg(base.map(w=>+w.p90)), bP50=avg(base.map(w=>+w.p50));
    out.detail.D2={week:wk, dow, hour:hr};
    metric('D2.p90',{detector:'D2', label:'Koha porosi → check-out i parë, p90', unit:'orë', better:'lower', target:r1(bP90*(1+cfg.leadRisePct/100)), series:wk.map(w=>({d:w.d1, v:r1(+w.p90)}))});
    metric('D2.p50',{detector:'D2', label:'Koha porosi → check-out i parë, mediana', unit:'orë', better:'lower', target:cfg.leadP50Max, series:wk.map(w=>({d:w.d1, v:r1(+w.p50)}))});
    const rise=bP90? (+cur.p90-bP90)/bP90*100 : 0;
    if(+cur.p50>cfg.leadP50Max || rise>cfg.leadRisePct){
      const worstDow=dow.slice().sort((a,b)=>b.p50-a.p50)[0], DN=['','E hënë','E martë','E mërkurë','E enjte','E premte','E shtunë','E diel'];
      cand({ key:'D2.lead', detector:'D2', metricKey: +cur.p50>cfg.leadP50Max? 'D2.p50' : 'D2.p90', blocks:['D2'],
        title:'Koha nga porosia te check-out-i është e gjatë dhe me bisht të gjatë', phase:'Claim', category:'Inbound-Furnitor',
        symptom:`Java nga ${fmtD(cur.d1)}: mediana ${r1(+cur.p50)} h, p90 ${r1(+cur.p90)} h, p95 ${r1(+cur.p95)} h (baseline p90 ${r1(bP90)} h).`,
        value:r1(+cur.p90), baseline:r1(bP90), threshold:r1(bP90*(1+cfg.leadRisePct/100)), unit:'orë (p90)', better:'lower',
        period:{from:cur.d1, to:addDays(today,-1)}, baselinePeriod:{from:base[0]&&base[0].d1, to:addDays(cur.d1,-1)}, scope:scopeText(b), n:+cur.n, confidence:conf(+cur.n),
        impact:{objective:'Same-day', value:r1(+cur.p50), text:`Gjysma e porosive dalin pas ${r1(+cur.p50)} orësh, 10% pas ${r1(+cur.p90)} orësh`},
        tags:{ fact:[`Mediana sipas ditës së krijimit më e lartë: ${worstDow? DN[worstDow.dw]+' '+r1(+worstDow.p50)+' h' : '—'}`, `n = ${cur.n} porosi të dala në javë`],
               hyp:['Pjesa më e madhe e kohës është pritja e mallit nga shitësi/furnitori, jo puna në depo — krahaso me D1 (gati → dalje).'], unconfirmed:[] },
        hypotheses:[ 'Porositë presin mallin nga shitësi lokal / furnitori (cross-dock) — koha e depos është e vogël krahasuar me pritjen.',
          'Porositë e krijuara në fundjavë dhe natën presin ditën e ardhshme të punës.',
          'Porositë me disa artikuj (split) presin artikullin e fundit para se të dalin.' ],
        gemba:[ 'Për 10 porosi me kohë > p90: kur u bë gati njësia e fundit dhe kur doli porosia?',
          'Sa porosi në raftin e pritjes presin vetëm një artikull nga shitësi?' ],
        suggest:{ sev: +cur.p50>cfg.leadP50Max*1.5? 4 : 3, occ:4 } });
    }
  });

  /* D3 flow per hour + system constraint ---------------------------------- */
  run('D3', b=>{
    const cells=J(b.row.cell).filter(c=>c.d<today);
    const PH=[ {k:'cr', name:'Porositë hyrëse', unit:'porosi', demand:true}, {k:'pk', name:'Picking', unit:'porosi', ops:null},
      {k:'co', name:'Checkout/Packing', unit:'porosi', ops:'coOps'}, {k:'ci', name:'Check-in', unit:'njësi', ops:'ciOps'}, {k:'mp', name:'Mapping', unit:'njësi', ops:'mpOps'} ];
    const wdCells=cells.filter(c=>!isWe(c.d) && inW(c.d,{from:W.base.from,to:W.cur.to}));
    const wdDays=[...new Set(wdCells.map(c=>c.d))];
    const hours=Array.from({length:24},(_,i)=>i);
    const heat=PH.map(p=>({k:p.k, name:p.name, unit:p.unit, v:hours.map(h=>r1(sum(wdCells.filter(c=>c.h===h).map(c=>c[p.k]))/Math.max(1,wdDays.length)))}));
    const dayTot=k=>{ const m={}; cells.forEach(c=>{ m[c.d]=(m[c.d]||0)+(c[k]||0); }); return m; };
    const phases=PH.filter(p=>!p.demand).map(p=>{
      const hourly=wdCells.filter(c=>(c[p.k]||0)>0).map(c=>c[p.k]);            // throughput in the hours the process ran
      const cap=q(hourly,0.9)||0, mean=avg(hourly);
      const busy=wdCells.filter(c=>c.h>=9 && c.h<17).map(c=>c[p.k]||0);
      const util=cap? avg(busy)/cap*100 : 0;
      const dt=dayTot(p.k), curAvg=avg(Object.keys(dt).filter(d=>inW(d,W.cur)&&!isWe(d)).map(d=>dt[d])), baseAvg=avg(Object.keys(dt).filter(d=>inW(d,W.base)&&!isWe(d)).map(d=>dt[d]));
      const opsPerH=p.ops? avg(wdCells.filter(c=>c[p.ops]>0 && c.h>=9 && c.h<17).map(c=>c[p.ops])) : null;
      return {k:p.k, name:p.name, unit:p.unit, capPerH:r1(cap), meanPerH:r1(mean), util:r1(util), perDay:r1(curAvg), perDayBase:r1(baseAvg), opsPerH:opsPerH!=null? r1(opsPerH) : null, n:hourly.length};
    });
    // WIP signals: orders ready and not out (D1o), units waiting for mapping (D4), created vs checked out per day
    const crD=dayTot('cr'), coD=dayTot('co');
    const netOrders=avg(Object.keys(crD).filter(d=>inW(d,W.cur)).map(d=>(crD[d]||0)-(coD[d]||0)));
    const wipCo= B.D1o? sum(J(B.D1o.row.openDaily).map(o=>o.openReady+(o.afterCo||0))) : null;
    const wipMap= B.D4? sum(J(B.D4.row.waiting).map(w=>w.n)) : null;
    const wip={co:wipCo, mp:wipMap, pk:null, ci:null};
    phases.forEach(p=>{ p.wip=wip[p.k]; });
    const valid=phases.filter(p=>p.n>=20);
    const top=valid.slice().sort((a,b)=>b.util-a.util)[0]||null;
    out.constraint={ heat, hours, phases, netOrders:r1(netOrders), top: top&&top.k, days:wdDays.length, period:{from:W.base.from,to:W.cur.to},
      text: top? `${top.name}: shfrytëzimi ${top.util}% i kapacitetit të demonstruar (${top.capPerH} ${top.unit}/orë, p90) në orët 09–17` : 'Të dhëna të pamjaftueshme' };
    const pk=phases.find(p=>p.k==='pk'); if(pk && pk.n<20) note('D3','Picking nuk ka të dhëna të mjaftueshme në PickSession — faza s\'mund të krahasohet (shih D5).','data');
    phases.forEach(p=>metric('D3.util.'+p.k,{detector:'D3', label:'Shfrytëzimi i kapacitetit — '+p.name, unit:'%', better:'lower', target:cfg.utilMax,
      series:Object.keys(dayTot(p.k)).sort().map(d=>({d, v:p.capPerH? r1(dayTot(p.k)[d]/(p.capPerH*8)*100) : 0}))}));
    if(top && top.util>=cfg.utilMax){
      cand({ key:'D3.constraint', detector:'D3', metricKey:'D3.util.'+top.k, blocks:['D3','D1o','D4'],
        title:`Kufizimi i sistemit: ${top.name}`, phase:top.name, category:'Proces',
        symptom:`${top.name} punon në ${top.util}% të kapacitetit të demonstruar në orët 09–17${top.wip!=null? '; WIP aktual: '+top.wip+' '+top.unit : ''}.`,
        value:top.util, baseline:null, threshold:cfg.utilMax, unit:'% shfrytëzim', better:'lower', period:{from:W.base.from,to:W.cur.to}, scope:scopeText(b),
        n:top.n, confidence:conf(top.n,{days:wdDays.length}),
        impact:{objective:'Same-day', value:top.util, text:`Çdo orë e humbur në ${top.name} është output i humbur për gjithë depon (${top.capPerH} ${top.unit}/orë)`},
        tags:{ fact:[`Kapaciteti i demonstruar (p90 për orë): ${top.capPerH} ${top.unit}/orë; mesatarja ${top.meanPerH}`, `Operatorë mesatarisht në orë: ${top.opsPerH??'—'}`],
               hyp:['Përmirësimi jashtë kësaj faze nuk e rrit output-in e depos (Theory of Constraints).'], unconfirmed:['Kapaciteti është ai i demonstruar nga të dhënat, jo kapaciteti teorik i stacioneve.'] },
        hypotheses:[ `Numri i operatorëve në ${top.name} në orët e pikut nuk ndjek ngarkesën.`, 'Pengesa në stacion (printer, materiale paketimi, hapësirë) ulin ritmin për orë.', 'Puna mbërrin në tufa (batch) dhe jo në rrjedhë të njëtrajtshme.' ],
        gemba:[ `Vëzhgo ${top.name} 30 minuta në pik: sa kohë stacioni pret punë, sa kohë punëtori pret materiale/printer?`, 'Numëro WIP në fillim dhe në fund të orës.' ],
        suggest:{ sev:4, occ:5 } });
    }
  });

  /* D4 waiting for mapping ---------------------------------------------- */
  run('D4', b=>{
    const wt=J(b.row.waiting), old=J(b.row.oldest), dw=J(b.row.dwell).filter(x=>x.d<today);
    const over=sum(wt.map(w=>w.overX)), b3d=sum(wt.map(w=>w.b3d)), n=sum(wt.map(w=>w.n));
    const curP90=q(dw.filter(x=>inW(x.d,W.cur)).map(x=>+x.p90),0.5), baseP90=q(dw.filter(x=>inW(x.d,W.base)).map(x=>+x.p90),0.5);
    const nCur=sum(dw.filter(x=>inW(x.d,W.cur)).map(x=>x.n));
    out.detail.D4={waiting:wt, oldest:old, dwell:dw};
    metric('D4.p90',{detector:'D4', label:'Koha check-in → mapping (p90 ditore)', unit:'min', better:'lower', target:cfg.mapP90Max, series:dw.map(x=>({d:x.d, v:Math.round(+x.p90)}))});
    metric('D4.waiting',{detector:'D4', label:'Njësi që presin mapping', unit:'njësi', better:'lower', target:cfg.mapWaitMax, series:[{d:today, v:over}]});
    const mh=(b.scope&&b.scope.mh)||4;
    if(over>cfg.mapWaitMax || (curP90!=null && curP90>cfg.mapP90Max)){
      cand({ key:'D4.waiting', detector:'D4', metricKey: over>cfg.mapWaitMax? 'D4.waiting' : 'D4.p90', blocks:['D4'],
        title:'Njësi të pranuara presin gjatë për mapping', phase:'Mapping', category:'Proces',
        symptom:`${over} njësi presin mapping më shumë se ${mh} orë (${b3d} mbi 3 ditë); koha check-in → mapping p90 ≈ ${curP90!=null? Math.round(curP90)+' min' : '—'} (baseline ${baseP90!=null? Math.round(baseP90)+' min' : '—'}).`,
        value:over, baseline:null, threshold:cfg.mapWaitMax, unit:'njësi', better:'lower', period:{from:W.cur.from,to:today}, scope:scopeText(b),
        n:n+nCur, confidence:conf(n,{inferred:true}),
        impact:{objective:'Same-day', value:over, text:`${over} njësi jo të disponueshme për picking/porosi derisa të mapohen`},
        tags:{ fact:[`Mosha: ${wt.map(w=>'status '+w.s+': 0–4h '+w.b0_4+', 4–8h '+w.b4_8+', 8–24h '+w.b8_24+', 1–3d '+w.b1_3d+', >3d '+w.b3d).join(' · ')}`],
               hyp:[], unconfirmed:['StatusId 6 = "para mapping-ut" është e nxjerrë (2→6→7), jo e konfirmuar.'] },
        hypotheses:[ 'Mapping bëhet në tufa në fund të ditës, jo në rrjedhë pas check-in-it.', 'Mungon lokacion i lirë/i përshtatshëm për këto produkte (raft i plotë, produkte voluminoze).',
          'Njësitë më të vjetra janë ngecur (defekt, produkt pa kod, pritje vendimi) dhe nuk janë punë mapping-u.' ],
        gemba:[ 'Gjej fizikisht 5 njësitë më të vjetra (lista në evidencë): ku janë dhe pse s\'janë mapuar?', 'Sa njësi të pa-mapuara ka në zonën e pritjes në fund të turnit?' ],
        suggest:{ sev: b3d>100? 4 : 3, occ:5 } });
    }
  });

  /* D5 picking & cycle time ----------------------------------------------- */
  run('D5', b=>{
    const ses=J(b.row.sessions), cyc=J(b.row.cycle), std={}; J(b.row.std).forEach(s=>std[s.c]=+s.s);
    const sesCur=sum(ses.filter(s=>inW(s.d,W.cur)).map(s=>s.s)), last=ses.length? ses[ses.length-1].d : null;
    out.detail.D5={sessions:ses, cycle:cyc, std};
    metric('D5.sessions',{detector:'D5', label:'Sesione picking të regjistruara (PickSession)', unit:'sesione/ditë', better:'higher', target:1, series:ses.map(s=>({d:s.d, v:s.s}))});
    if(sesCur===0){
      cand({ key:'D5.nodata', detector:'D5', metricKey:'D5.sessions', blocks:['D5'],
        title:'Picking nuk regjistrohet në WMS — faza nuk mund të matet', phase:'Picking', category:'Të dhëna',
        symptom:`Asnjë PickSession në 7 ditët e fundit${last? ' (e fundit: '+fmtD(last)+')' : ''}, ndërsa check-out-i punon çdo ditë.`,
        value:0, baseline:r1(avg(ses.filter(s=>inW(s.d,W.base)).map(s=>s.s))), threshold:1, unit:'sesione/7 ditë', better:'higher', period:W.cur, scope:scopeText(b),
        n:sum(ses.map(s=>s.s)), confidence:'e lartë',
        impact:{objective:'Kosto për porosi', value:null, text:'Koha e picking-ut (79,7 s standard) nuk matet — kapaciteti dhe kostoja e kësaj faze janë të pakontrolluara'},
        tags:{ fact:[`${sum(ses.map(s=>s.s))} sesione gjithsej në ${b.scope&&b.scope.nd||35} ditë, në ${ses.length} ditë`], hyp:[], unconfirmed:[] },
        hypotheses:[ 'Picking bëhet pa skaner/sesion në WMS (me listë letre ose direkt në check-out).', 'Moduli PickSession nuk është në përdorim pas testimit të gushtit.' ],
        gemba:[ 'Vëzhgo një picker: me çfarë merr porosinë (listë, skaner, ekran) dhe a hap sesion në WMS?', 'Kush vendos nëse picking regjistrohet në WMS?' ],
        suggest:{ sev:3, occ:5, det:3 } });
    }
    const map={2:'CheckIn',7:'Map',4:'CheckoutShipping'}, NM={2:'Check-in',7:'Mapping',4:'Check-out'};
    [2,7,4].forEach(t=>{ const rows=cyc.filter(c=>c.t===t); if(!rows.length) return; const cur=rows[rows.length-1], s=std[map[t]];
      metric('D5.cycle.'+t,{detector:'D5', label:'Intervali mes skanimeve (mediana) — '+NM[t], unit:'s', better:'lower', target:s, series:rows.map(r=>({d:'j'+r.wk, v:Math.round(+r.p50)}))});
      if(s && +cur.p50>s*(1+cfg.cycleTolPct/100)){
        cand({ key:'D5.cycle.'+t, detector:'D5', metricKey:'D5.cycle.'+t, blocks:['D5'], title:`${NM[t]} më i ngadalshëm se standardi i WMS-it`, phase:NM[t]==='Check-out'? 'Checkout/Packing' : NM[t], category:'Proces',
          symptom:`Intervali median mes skanimeve: ${Math.round(+cur.p50)} s kundrejt standardit ${s} s.`, value:Math.round(+cur.p50), baseline:Math.round(avg(rows.slice(-5,-1).map(r=>+r.p50))), threshold:Math.round(s*(1+cfg.cycleTolPct/100)),
          unit:'s', better:'lower', period:{from:'java '+cur.wk, to:''}, scope:scopeText(b), n:+cur.n, confidence:conf(+cur.n,{inferred:true}),
          impact:{objective:'Kosto për porosi', value:null, text:`+${Math.round(+cur.p50-s)} s për veprim mbi standardin`},
          tags:{fact:[], hyp:[], unconfirmed:['Intervali mes dy skanimeve të njëjtit lloj nga i njëjti person nuk është cikli i plotë (përfshin pritje dhe punë tjetër).']},
          hypotheses:['Pritje për material/printer mes skanimeve.','Lëvizje e gjatë mes lokacioneve.'], gemba:['Mat me kronometër 10 cikle në stacion dhe krahaso me intervalin e skanimeve.'], suggest:{sev:2, occ:4} });
      } else if(s && +cur.p50<s*0.5) note('D5',`${NM[t]}: intervali median ${Math.round(+cur.p50)} s është shumë nën standardin ${s} s — standardi i pagesës mund të jetë më i lartë se puna reale për njësi, ose skanimet bëhen në tufa (E PAKONFIRMUAR).`);
    });
  });

  /* D6 productivity — process obstacles first ------------------------------ */
  run('D6', b=>{
    const cells=J(b.row.cell).filter(c=>c.d<today);
    const people={}; cells.forEach(c=>{ const k=c.i+' #'+c.id; (people[k]=people[k]||{i:c.i,id:c.id,tmp:c.tmp,act:c.act,days:[]}).days.push(c); });
    const list=Object.values(people).filter(p=>!p.tmp);
    const rows=list.map(p=>{ const cur=p.days.filter(d=>inW(d.d,W.cur)), base=p.days.filter(d=>inW(d.d,W.base)), all30=p.days.filter(d=>inW(d.d,{from:addDays(today,-30),to:W.cur.to}));
      const wc=avg(cur.map(d=>d.w)), wb=avg(base.map(d=>d.w));
      const gapCur=avg(cur.map(d=>Math.max(0,d.gapMin-cfg.breakMin)));
      return {i:p.i, id:p.id, act:p.act, curDays:cur.length, baseDays:base.length, wCur:r1(wc), wBase:r1(wb), w30:r1(avg(all30.map(d=>d.w))), d30:all30.length,
        change: wb? r1((wc-wb)/wb*100) : null, gapCur:Math.round(gapCur), hrs:r1(avg(cur.map(d=>d.hrs)))}; });
    const teamAvg=avg(rows.filter(r=>r.d30>=3).map(r=>r.w30)), sd=Math.sqrt(avg(rows.filter(r=>r.d30>=3).map(r=>(r.w30-teamAvg)**2)));
    rows.forEach(r=>{ r.band= r.d30<3? 'n i ulët' : r.w30>teamAvg+2*sd? 'Spike' : r.w30>teamAvg*cfg.bandHi? 'Mbi' : r.w30<teamAvg*cfg.bandLo? 'Nën' : 'Mesatar'; });
    out.detail.D6={rows:rows.sort((a,b)=>b.w30-a.w30), teamAvg:r1(teamAvg), sd:r1(sd), shared:Object.values(people).filter(p=>p.tmp).map(p=>({i:p.i,id:p.id,days:p.days.length}))};
    // gaps (team level): minutes of inactivity > gm per person-day after the break
    const curCells=cells.filter(c=>inW(c.d,W.cur)&&!c.tmp), baseCells=cells.filter(c=>inW(c.d,W.base)&&!c.tmp);
    const gapCur=avg(curCells.map(c=>Math.max(0,c.gapMin-cfg.breakMin))), gapBase=avg(baseCells.map(c=>Math.max(0,c.gapMin-cfg.breakMin)));
    const dayKeys=[...new Set(cells.map(c=>c.d))].sort();
    metric('D6.gap',{detector:'D6', label:'Boshllëqe brenda turnit (pas pushimit) për person-ditë', unit:'min', better:'lower', target:cfg.gapMax,
      series:dayKeys.map(d=>({d, v:Math.round(avg(cells.filter(c=>c.d===d&&!c.tmp).map(c=>Math.max(0,c.gapMin-cfg.breakMin))))}))});
    if(gapCur>cfg.gapMax){
      const lostH=sum(curCells.map(c=>Math.max(0,c.gapMin-cfg.breakMin)))/60/Math.max(1,new Set(curCells.map(c=>c.d)).size);
      cand({ key:'D6.gaps', detector:'D6', metricKey:'D6.gap', blocks:['D6'], title:'Boshllëqe të gjata pa skanime brenda turnit', phase:'Të gjitha', category:'Proces',
        symptom:`Mesatarisht ${Math.round(gapCur)} min/person-ditë pa asnjë skanim në intervale > ${(b.scope&&b.scope.gm)||15} min (pas zbritjes së ${cfg.breakMin} min pushim).`,
        value:Math.round(gapCur), baseline:Math.round(gapBase), threshold:cfg.gapMax, unit:'min/person-ditë', better:'lower', period:W.cur, scope:scopeText(b),
        n:curCells.length, confidence:conf(curCells.length,{days:7}),
        impact:{objective:'Ekipi', value:r1(lostH), text:`≈ ${r1(lostH)} orë/ditë pa skanime në gjithë ekipin`},
        tags:{ fact:[`${curCells.length} person-ditë në 7 ditë`], hyp:['Boshllëqet tregojnë pritje për punë (starvation), punë jashtë WMS-it ose pengesa — jo domosdoshmërisht përtaci.'], unconfirmed:['Punët pa skanim (boxing, ngarkim, pastrim) duken si boshllëqe.'] },
        hypotheses:[ 'Mungesë pune në rrjedhë (starvation): porositë/njësitë nuk mbërrijnë në stacion në kohë.', 'Punë e nevojshme jashtë WMS-it (boxing, ngarkim, kërkim produkti) pa skanim.', 'Pengesa pajisjesh (skaner, printer, rrjet).' ],
        gemba:[ 'Kur një operator nuk skanon > 15 min: çfarë po bën? (vëzhgo 3 raste)', 'A ka punë të pa-skanuar që duhet ndarë si veprim në WMS?' ],
        suggest:{ sev:3, occ:5, det:3 } });
    }
    const decl=rows.filter(r=>r.change!=null && r.curDays>=3 && r.baseDays>=5 && r.change<=-cfg.declinePct);
    metric('D6.decline',{detector:'D6', label:'Operatorë me rënie ≥ '+cfg.declinePct+'% (weighted ops/ditë aktive)', unit:'operatorë', better:'lower', target:0, series:[{d:today, v:decl.length}]});
    if(decl.length){
      cand({ key:'D6.decline', detector:'D6', metricKey:'D6.decline', blocks:['D6'], title:'Rënie e produktivitetit javë pas jave te disa operatorë', phase:'Të gjitha', category:'Njerëz',
        symptom:`${decl.length} operatorë me rënie ≥ ${cfg.declinePct}%: ${decl.map(r=>r.i+' #'+r.id+' ('+r.change+'%)').join(', ')}.`,
        value:decl.length, baseline:0, threshold:0, unit:'operatorë', better:'lower', period:W.cur, scope:scopeText(b), n:decl.length, confidence: decl.length>=3? 'e mesme' : 'e ulët',
        impact:{objective:'Ekipi', value:decl.length, text:`${decl.length} operatorë nën ritmin e tyre të zakonshëm`},
        tags:{ fact:decl.map(r=>`${r.i} #${r.id}: ${r.wBase} → ${r.wCur} weighted ops/ditë (${r.curDays} ditë)`), hyp:['Rënia shpesh vjen nga ndryshimi i detyrës ose mungesa e punës, jo nga personi.'], unconfirmed:['Weighted ops mat vetëm veprimet e skanuara në WMS.'] },
        hypotheses:[ 'Operatori u zhvendos në detyrë pa skanime (boxing, ngarkim, inventar).', 'Mungesë pune në stacionin e tij (starvation) ose pajisje me defekt.', 'Mungesë trajnimi për një proces të ri.' ],
        gemba:[ 'Bisedë 1-me-1 (jo ndëshkuese): çfarë e pengoi këtë javë?', 'Kontrollo orarin: a punoi në pozitë tjetër?' ],
        suggest:{ sev:2, occ:3, det:2 } });
    }
  });

  /* D7 data quality ------------------------------------------------------- */
  run('D7', b=>{
    const daily=J(b.row.daily).filter(d=>d.d<today), types=J(b.row.types), shared=J(b.row.shared);
    const cur=daily.filter(d=>inW(d.d,W.cur));
    const tmpCur=sum(cur.map(d=>d.tmp)), nCur=sum(cur.map(d=>d.n)), noUser=avg(cur.map(d=>d.noUser)), co0=sum(cur.map(d=>d.co0));
    const totalTypes=sum(types.map(t=>t.n)), unknown=types.filter(t=>!KNOWN_TYPES.includes(+t.t)), unkN=sum(unknown.map(t=>t.n));
    out.detail.D7={daily, types, shared, dupIds:b.row.dupIds, only27:b.row.only27};
    metric('D7.shared',{detector:'D7', label:'Skanime me llogari të përbashkëta (temp)', unit:'%', better:'lower', target:cfg.sharedMax, series:daily.map(d=>({d:d.d, v:d.n? r1(d.tmp/d.n*100) : 0}))});
    metric('D7.noUser',{detector:'D7', label:'Skanime pa përdorues të njohur', unit:'skanime/ditë', better:'lower', target:cfg.noUserMax, series:daily.map(d=>({d:d.d, v:d.noUser}))});
    const dq=(key,title,symptom,value,threshold,unit,sev,extra)=>cand(Object.assign({ key, detector:'D7', metricKey:extra&&extra.metricKey||null, blocks:['D7'], title, phase:'Të gjitha', category:'Të dhëna', symptom,
      value, baseline:null, threshold, unit, better:'lower', period:W.cur, scope:scopeText(b), n:nCur, confidence:'e lartë',
      impact:{objective:'Ekipi', value:null, text:'Metrikat e personave dhe të fazave nuk janë të besueshme për këtë pjesë'},
      hypotheses:['Mungon rregulli/disiplina e hyrjes në WMS.','Konfigurim i WMS-it.'], gemba:['Kush e përdor këtë llogari/rrjedhë dhe pse?'], suggest:{sev:sev, occ:4, det:2} }, extra||{}));
    if(tmpCur/Math.max(1,nCur)*100>cfg.sharedMax) dq('D7.shared','Llogari të përbashkëta (temp) përdoren për skanime', `${tmpCur} skanime (${r1(tmpCur/Math.max(1,nCur)*100)}%) me llogari temp në 7 ditë — s'dihet kush i bëri.`, r1(tmpCur/nCur*100), cfg.sharedMax, '%', 2, {metricKey:'D7.shared', tags:{fact:shared.map(s=>`${s.i} #${s.id}: ${s.n} skanime në ${s.days} ditë`)}});
    if(noUser>cfg.noUserMax) dq('D7.noUser','Skanime pa përdorues të njohur', `${r1(noUser)} skanime/ditë me UpdateBy që s'lidhet me Users.UserId.`, r1(noUser), cfg.noUserMax, 'skanime/ditë', 2, {metricKey:'D7.noUser'});
    if(co0>0) dq('D7.co0','Check-out pa platformë (PlatformId = 0)', `${co0} skanime check-out pa platformë në 7 ditë — porosia s'mund të lidhet.`, co0, 0, 'skanime', 3);
    if(+b.row.dupIds>0) dq('D7.dupIds','I njëjti OrderId në dy platforma', `${b.row.dupIds} OrderId ekzistojnë në të dy platformat — lidhja e njësive të rezervuara (PlatformId 0) me porosinë nuk është më e sigurt.`, +b.row.dupIds, 0, 'porosi', 5);
    if(+b.row.only27>cfg.only27Max) dq('D7.only27','Porosi me skanim 27 por pa check-out 4/18', `${b.row.only27} porosi në ${b.scope&&b.scope.nd||35} ditë kanë skanimin e check-out-it (27) por jo 4/18 — mund të mungojnë në metrikat e check-out-it.`, +b.row.only27, cfg.only27Max, 'porosi', 2, {tags:{unconfirmed:['LogType 27 = skanimi i check-out-it është i nxjerrë (rrjedha 3→27→9→18).']}});
    if(totalTypes && unkN/totalTypes*100>cfg.unknownTypePct) dq('D7.types','Shumë veprime me LogTypeId të pakonfirmuar', `${r1(unkN/totalTypes*100)}% e log-eve kanë LogTypeId jashtë listës së njohur: ${unknown.map(t=>t.t+' ('+t.n+')').join(', ')}.`, r1(unkN/totalTypes*100), cfg.unknownTypePct, '%', 2);
    else if(unknown.length) note('D7',`LogTypeId të pakonfirmuara në ${b.scope&&b.scope.nd||35} ditë (shfaqen si numra): ${unknown.map(t=>t.t+' ('+t.n+')').join(', ')} — ${r1(unkN/Math.max(1,totalTypes)*100)}% e log-eve.`);
    if(+b.row.dupIds===0) note('D7','Kontroll: asnjë OrderId në dy platforma (120 ditë) — lidhja e njësive të rezervuara me porosinë është e sigurt.','ok');
  });

  /* D8 inbound ----------------------------------------------------------- */
  run('D8', b=>{
    const st=J(b.row.started); const s=Array.isArray(st)? st[0]||{} : st; const old=J(b.row.oldest), delay=J(b.row.delay);
    out.detail.D8={started:s, oldest:old, delay};
    metric('D8.stuck',{detector:'D8', label:'Furnizime "Started" mbi '+((b.scope&&b.scope.sh)||24)+' orë (deri 30 ditë)', unit:'furnizime', better:'lower', target:cfg.supplyStuckMax, series:[{d:today, v:+s.stuck30||0}]});
    if((+s.stuck30||0)>cfg.supplyStuckMax){
      cand({ key:'D8.stuck', detector:'D8', metricKey:'D8.stuck', blocks:['D8'], title:'Furnizime të hapura (Started) që nuk mbyllen', phase:'Inbounding', category:'Inbound-Furnitor',
        symptom:`${s.stuck30} furnizime janë në status 1 (Started) më shumë se ${(b.scope&&b.scope.sh)||24} orë (1–3 ditë: ${s.d1_3}, 3–7 ditë: ${s.d3_7}, 7–30 ditë: ${s.d7_30}).`,
        value:+s.stuck30, baseline:null, threshold:cfg.supplyStuckMax, unit:'furnizime', better:'lower', period:{from:addDays(today,-30), to:today}, scope:scopeText(b), n:+s.n, confidence:'e lartë',
        impact:{objective:'Same-day', value:+s.stuck30, text:'Mallra të pranuara pa mbyllje në sistem: stoku dhe porositë që i presin s\'përditësohen'},
        tags:{ fact:[`Më të vjetrat: ${old.slice(0,5).map(o=>o.id+' ('+o.at.slice(0,10)+', '+o.u+' njësi)').join(', ')}`], hyp:[], unconfirmed:[] },
        hypotheses:[ 'Furnizimi hapet dhe nuk mbyllet kur mbaron check-in-i (hap procesi pa pronar).', 'Furnizime pjesore: pritet pjesa tjetër e mallit.', 'Furnizime të hapura gabimisht (0 njësi).' ],
        gemba:[ 'Për 5 furnizimet më të vjetra: a është malli fizikisht në depo? Pse s\'është mbyllur?', 'Kush e mbyll furnizimin dhe kur?' ],
        suggest:{ sev:3, occ:5 } });
    }
    if((+s.gt30||0)>cfg.supplyStaleMax) cand({ key:'D8.stale', detector:'D8', metricKey:null, blocks:['D8'], title:'Furnizime të pambyllura prej më shumë se 30 ditësh', phase:'Inbounding', category:'Të dhëna',
      symptom:`${s.gt30} furnizime të depos janë ende "Started" pas më shumë se 30 ditësh.`, value:+s.gt30, baseline:null, threshold:cfg.supplyStaleMax, unit:'furnizime', better:'lower',
      period:{from:'', to:today}, scope:scopeText(b), n:+s.n, confidence:'e lartë', impact:{objective:'Kosto për porosi', value:null, text:'Statuset e furnizimeve në WMS nuk pasqyrojnë realitetin — raportet e inbound-it janë të zhurmshme'},
      hypotheses:['Mbyllja e furnizimit nuk është pjesë e procesit standard.','Furnizime testuese/të dyfishta.'], gemba:['A ka procedurë për mbylljen e furnizimeve? Kush e kontrollon?'], suggest:{sev:2, occ:5, det:2} });
    if(delay.length && q(delay.map(x=>+x.p50),0.5)===0) note('D8','Furnizimi hapet në momentin e check-in-it të parë (mediana e vonesës = 0 min): koha nga mbërritja fizike te check-in-i nuk regjistrohet në WMS — mateni në Gemba.','data');
  });

  /* D9 inventory accuracy ------------------------------------------------- */
  run('D9', b=>{
    const r=b.row, stale=(s)=> !s || (Date.parse(today)-Date.parse(s.slice(0,10)))/86400000>cfg.staleDays;
    const insp=J(r.insp);
    out.detail.D9={sdLast:r.sdLast, nfLast:r.nfLast, imLast:r.imLast, insp, sd:J(r.sd), nf:J(r.nf), sdRepeat:J(r.sdRepeat), nfRepeat:J(r.nfRepeat)};
    const st=[]; if(stale(r.sdLast)) st.push('StockDifferences (e fundit: '+(r.sdLast||'asnjë')+')'); if(stale(r.nfLast)) st.push('NotFoundProducts (e fundit: '+(r.nfLast||'asnjë')+')');
    if(st.length) cand({ key:'D9.stale', detector:'D9', metricKey:null, blocks:['D9'], title:'Burimet e saktësisë së inventarit nuk përditësohen në WMS', phase:'Inventar', category:'Të dhëna',
      symptom:`Nuk ka regjistrime të reja: ${st.join('; ')}. Saktësia e inventarit mund të ndiqet vetëm nga inspektimet.`, value:st.length, baseline:null, threshold:0, unit:'burime', better:'lower',
      period:{from:'', to:today}, scope:scopeText(b), n:st.length, confidence:'e lartë', impact:{objective:'Kosto për porosi', value:null, text:'Mospërputhjet e stokut dhe produktet që s\'gjenden nuk maten çdo ditë'},
      hypotheses:['Sinkronizimi WMS–QuickBooks është ndalur.','Raportimi i "produkt nuk u gjet" bëhet jashtë WMS-it.'], gemba:['Kur nuk gjendet një produkt në raft, si raportohet sot?'], suggest:{sev:2, occ:5, det:4} });
    const full=insp.find(i=>i.sc>=1000);
    if(full){ const pctMiss=full.ms/(full.sc+full.ms)*100;
      metric('D9.miss',{detector:'D9', label:'Mungesa në inspektimin e fundit të plotë', unit:'%', better:'lower', target:cfg.missPctMax, series:insp.filter(i=>i.sc>=1000).reverse().map(i=>({d:i.cd, v:r2(i.ms/(i.sc+i.ms)*100)}))});
      if(pctMiss>cfg.missPctMax) cand({ key:'D9.miss', detector:'D9', metricKey:'D9.miss', blocks:['D9'], title:'Mungesa të larta në inspektimin e inventarit', phase:'Inventar', category:'Proces',
        symptom:`Inspektimi "${full.nm}" (${fmtD(full.cd)}): ${full.ms} mungesa nga ${full.sc+full.ms} (${r2(pctMiss)}%).`, value:r2(pctMiss), baseline:null, threshold:cfg.missPctMax, unit:'%', better:'lower',
        period:{from:full.cd, to:full.cd}, scope:scopeText(b), n:full.sc+full.ms, confidence:'e mesme', impact:{objective:'Kosto për porosi', value:full.ms, text:`${full.ms} njësi që s'u gjetën në lokacionin e tyre`},
        hypotheses:['Mapping në lokacion të gabuar.','Picking pa skanim → stoku nuk zbret.'], gemba:['Kontrollo 10 mungesa: ku ishin realisht?'], suggest:{sev:3, occ:2, det:3} });
      else note('D9',`Inspektimi i fundit i plotë "${full.nm}" (${fmtD(full.cd)}): ${r2(pctMiss)}% mungesa (${full.ms} nga ${full.sc+full.ms}) — nën pragun ${cfg.missPctMax}%.`,'ok');
    }
    insp.filter(i=>i.sc<1000 && i.ms>i.sc*10).forEach(i=>note('D9',`Inspektimi "${i.nm}" (${fmtD(i.cd)}) ka ${i.ms} mungesa kundrejt ${i.sc} të skanuara — duket inspektim i pjesshëm; mos e përdor si masë saktësie (E PAKONFIRMUAR).`,'data'));
  });

  /* D10 space / locations ------------------------------------------------- */
  run('D10', b=>{
    const r=b.row, rows=J(r.fullRows), med=+r.rowMedian||0, err=J(r.errSections), parked=J(r.parked);
    out.detail.D10={ormLast:r.ormLast, parked:Array.isArray(parked)? parked[0] : parked, fullRows:rows, rowMedian:med, errSections:err};
    if(!r.ormLast || (Date.parse(today)-Date.parse(r.ormLast.slice(0,10)))/86400000>cfg.staleDays) note('D10',`Porositë e parkuara në rreshta (OrderRowMapping) nuk regjistrohen më (e fundit: ${r.ormLast||'asnjë'}) — parkimi s'mund të matet nga WMS.`,'data');
    const over=rows.filter(x=>med && x.n>med*cfg.rowFactor);
    if(over.length) cand({ key:'D10.rows', detector:'D10', metricKey:null, blocks:['D10'], title:'Rreshta të mbingarkuar me njësi', phase:'Mapping', category:'Layout-Hapësirë',
      symptom:`${over.length} rreshta kanë mbi ${cfg.rowFactor}× medianën (${med} njësi/rresht): ${over.slice(0,5).map(x=>x.row_+' ('+x.n+')').join(', ')}.`, value:over.length, baseline:null, threshold:0, unit:'rreshta', better:'lower',
      period:{from:'', to:today}, scope:scopeText(b), n:rows.length, confidence:'e mesme', impact:{objective:'Same-day', value:null, text:'Kërkimi në rreshta të mbingarkuar ngadalëson picking-un dhe rrit gabimet'},
      tags:{fact:[], hyp:[], unconfirmed:['Disa rreshta mund të jenë zona bulk/paleta me qëllim.']},
      hypotheses:['Rreshti përdoret si zonë e përkohshme/bulk pa lokacione të ndara.','Mungojnë lokacione të lira në zonë.'], gemba:['Shko te 3 rreshtat e parë: çfarë ka aty dhe a gjendet shpejt një produkt?'], suggest:{sev:2, occ:5, det:2} });
    if(err.length){ const tot=sum(err.map(e=>e.ms+e.nf)); const top=err[0];
      if(tot>0 && (top.ms+top.nf)/tot>0.15) cand({ key:'D10.errzone', detector:'D10', metricKey:null, blocks:['D10'], title:`Zona me më shumë mungesa në inventar: ${top.sec.trim()}`, phase:'Inventar', category:'Layout-Hapësirë',
        symptom:`${top.sec.trim()}: ${top.ms+top.nf} mungesa/produkte të pa-gjetura (${r1((top.ms+top.nf)/tot*100)}% e totalit në periudhë).`, value:top.ms+top.nf, baseline:null, threshold:null, unit:'raste', better:'lower',
        period:{from:addDays(today,-((b.scope&&b.scope.nd)||35)), to:today}, scope:scopeText(b), n:tot, confidence:'e ulët', impact:{objective:'Kosto për porosi', value:null, text:'Gabimet e lokacionit përqendrohen në një zonë'},
        tags:{fact:[], hyp:[], unconfirmed:['Mungesat vijnë nga inspektimet (InspectMissingProducts) që mund të jenë të pjesshme.']},
        hypotheses:['Zona është ndryshuar/riorganizuar dhe lokacionet në WMS s\'janë përditësuar.','Etiketa të dëmtuara ose rreshta pa emërtim të qartë.'], gemba:['Kontrollo etiketat dhe 10 lokacione në këtë zonë.'], suggest:{sev:2, occ:2, det:3} });
    }
  });

  /* D11 transport ------------------------------------------------------- */
  run('D11', b=>{
    const wk=J(b.row.week), car=J(b.row.carrier);
    if(!wk.length) return;
    out.detail.D11={week:wk, carrier:car};
    metric('D11.late',{detector:'D11', label:'Ndalesa inbound që mbërrijnë pas datës së pritur', unit:'%', better:'lower', target:cfg.lateMax, series:wk.map(w=>({d:w.d1, v:w.n? r1(w.late/w.n*100) : 0}))});
    const cur=wk[wk.length-1], base=wk.slice(-5,-1), pc=cur.n? cur.late/cur.n*100 : 0, pb=avg(base.map(w=>w.n? w.late/w.n*100 : 0));
    if(pc>cfg.lateMax){ const worst=car.slice().sort((a,b)=>b.late-a.late)[0];
      cand({ key:'D11.late', detector:'D11', metricKey:'D11.late', blocks:['D11'], title:'Transporti inbound mbërrin pas datës së pritur', phase:'Inbounding', category:'Transport',
        symptom:`Java nga ${fmtD(cur.d1)}: ${cur.late} nga ${cur.n} ndalesa (${r1(pc)}%) mbërritën pas datës së pritur; ${cur.missing} ende pa mbërritje të regjistruar.`,
        value:r1(pc), baseline:r1(pb), threshold:cfg.lateMax, unit:'%', better:'lower', period:{from:cur.d1, to:addDays(today,-1)}, scope:scopeText(b), n:cur.n, confidence:conf(cur.n),
        impact:{objective:'Same-day', value:cur.late, text:`${cur.late} ndalesa me vonesë/javë — porositë që presin këtë mall shtyhen`},
        tags:{fact:car.map(c=>`${c.nm}: ${c.late}/${c.n} me vonesë, mesatarisht ${c.delayDays} ditë, ${c.missing} pa mbërritje`), hyp:[], unconfirmed:['Krahasimi bëhet me datë (jo orë); data e pritur mund të jetë futur pa saktësi.']},
        hypotheses:[`Kapaciteti/planifikimi i rrugës së ${worst? worst.nm : 'transportuesit'} nuk mjafton.`, 'Data e pritur vendoset optimiste në krijim.', 'Mbërritja regjistrohet me vonesë në WMS (jo transporti vetë).'],
        gemba:['Për 5 ndalesa me vonesë: kur erdhi kamioni realisht dhe kur u regjistrua?'], suggest:{sev:3, occ:5} });
    }
  });

  /* D12 order age by status ------------------------------------------------ */
  run('D12', b=>{
    const age=J(b.row.age), hints={}; J(b.row.hints).forEach(h=>hints[h.s]=h.a);
    out.detail.D12={age, hints};
    const open=age.filter(a=>!a.co), byS={}; open.forEach(a=>{ const o=byS[a.s]=byS[a.s]||{s:a.s,b3d:0,b1_3d:0,n:0}; o.b3d+=a.b3d; o.b1_3d+=a.b1_3d; o.n+=a.n; });
    const flagged=Object.values(byS).filter(x=>x.b3d>cfg.ageMax).sort((a,b)=>b.b3d-a.b3d);
    metric('D12.old',{detector:'D12', label:'Porosi pa check-out më të vjetra se 3 ditë', unit:'porosi', better:'lower', target:cfg.ageMax, series:[{d:today, v:sum(open.map(a=>a.b3d))}]});
    if(flagged.length) cand({ key:'D12.age', detector:'D12', metricKey:'D12.old', blocks:['D12'], title:'Porosi pa check-out më të vjetra se 3 ditë', phase:'Claim', category:'Sistem-WMS',
      symptom:`Porosi të 60 ditëve të fundit pa asnjë check-out dhe më të vjetra se 3 ditë, sipas WmsStatusId: ${flagged.map(x=>x.s+(hints[x.s]? ' ('+hints[x.s]+')' : '')+': '+x.b3d).join(', ')}.`,
      value:sum(flagged.map(x=>x.b3d)), baseline:null, threshold:cfg.ageMax, unit:'porosi', better:'lower', period:{from:addDays(today,-60), to:today}, scope:scopeText(b), n:sum(open.map(a=>a.n)), confidence:'e mesme',
      impact:{objective:'Same-day', value:sum(flagged.map(x=>x.b3d)), text:'Porosi që mund të jenë ngecur, ose të anuluara pa status përfundimtar'},
      tags:{fact:[], hyp:[], unconfirmed:['Kuptimi i WmsStatusId nuk është i konfirmuar (vetëm 23, 25, 26, 37 kanë sugjerim); statusi 25 shfaqet edhe te porosi të dala, pra nuk përditësohet gjithmonë.']},
      hypotheses:['Porositë janë anuluar/kthyer por statusi nuk ndryshon (statuset përfundimtare të panjohura).', 'Porositë presin mallin nga shitësi.', 'Porosi të harruara/ngecura në depo (sidomos statusi me njësi të rezervuara — lidhe me D1).'],
      gemba:['Merr 10 porosi nga statusi më i madh: ku janë fizikisht dhe çfarë thotë sistemi i shitjes?', 'Kush mund të konfirmojë kuptimin e çdo WmsStatusId?'], suggest:{sev:3, occ:5, det:3} });
  });

  /* D13 cost per order ---------------------------------------------------- */
  run('D13', b=>{
    const cost=J(b.row.cost), per=J(b.row.periods);
    out.detail.D13={cost, periods:per, formula:'Kosto/porosi = Σ Cost (WarehouseActionPayments, periudhë e mbyllur, i njëjti PricingVersionId; Cost është tashmë CalculatedPrice × Quantity) ÷ porositë e dala (OrderId + PlatformId të dallueshme me 4/18) në të njëjtën dritare kohore.'};
    const rows=cost.filter(c=>c.orders>0).map(c=>({per:c.per, v:c.v, cpo:+c.cost/c.orders, cost:+c.cost, orders:c.orders, f:c.f, l:c.l}));
    metric('D13.cpo',{detector:'D13', label:'Kosto e pagesës për veprim për porosi', unit:'€/porosi', better:'lower', target:cfg.costMax, series:rows.map(r=>({d:(r.f||'').slice(0,10), v:r2(r.cpo)}))});
    if(!rows.length) return;
    const last=rows[rows.length-1], prev=rows.slice(0,-1).reverse().find(r=>r.v===last.v);
    const rise= prev? (last.cpo-prev.cpo)/prev.cpo*100 : 0;
    if((cfg.costMax!=null && cfg.costMax!=='' && last.cpo>+cfg.costMax) || rise>cfg.costRisePct)
      cand({ key:'D13.cpo', detector:'D13', metricKey:'D13.cpo', blocks:['D13'], title:'Kostoja e punës për porosi mbi objektiv', phase:'Të gjitha', category:'Proces',
        symptom:`Periudha ${last.per}, versioni i çmimeve ${last.v}: ${r2(last.cpo)} €/porosi (${r2(last.cost)} € / ${last.orders} porosi).`, value:r2(last.cpo), baseline:prev? r2(prev.cpo) : null,
        threshold:cfg.costMax!=null&&cfg.costMax!==''? +cfg.costMax : (prev? r2(prev.cpo*(1+cfg.costRisePct/100)) : null), unit:'€/porosi', better:'lower',
        period:{from:(last.f||'').slice(0,10), to:(last.l||'').slice(0,10)}, scope:scopeText(b), n:last.orders, confidence:'e lartë',
        impact:{objective:'Kosto për porosi', value:r2(last.cpo), text:`${r2(last.cpo)} € për porosi`}, tags:{fact:[out.detail.D13.formula], hyp:[], unconfirmed:[]},
        hypotheses:['Më shumë veprime për porosi (ri-mapime, ri-skanime).','Ndryshim i çmimeve për veprim.'], gemba:['Cilat veprime u rritën për porosi?'], suggest:{sev:3, occ:3} });
    else note('D13',`Kosto/porosi: ${rows.map(r=>'periudha '+r.per+' (v'+r.v+'): '+r2(r.cpo)+' €').join('; ')}. ${prev? '' : 'Vetëm një periudhë e mbyllur për këtë version — krahasimi bëhet kur mbyllet tjetra.'}`);
  });

  /* duplicates: several symptoms of the same phase in the same period → one group, one problem with several evidences */
  const groups={}; out.candidates.forEach(c=>{ const g=c.phase+'|'+c.category; (groups[g]=groups[g]||[]).push(c.key); });
  out.candidates.forEach(c=>{ const g=groups[c.phase+'|'+c.category]; c.group= g.length>1? g.join('+') : null; });
  return out;
}

module.exports={ detect, DET_DEFAULTS, KNOWN_TYPES };
