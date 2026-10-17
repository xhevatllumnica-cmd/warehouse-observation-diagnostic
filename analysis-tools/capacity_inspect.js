/* Inspektimi i të dhënave të "Kapaciteti & Stafi" — skript i riprodhueshëm, vetëm lexim.
   Përdorimi:  node analysis-tools/capacity_inspect.js <pulse-data.json> <pod-daily.json> <dosja-dalëse>
   Lexon VETËM blloqet capacity (pulse/data.json) dhe POD-in ditor (data/pod-daily.json); nuk shkruan asgjë te hyrjet.
   Shkruan te dosja dalëse: raporti.md, profili.json, anomalite.csv, produktiviteti-operatoret.csv,
   produktiviteti-ditor.csv, saktesia-same-day.csv, kohet-procesit.csv, verifikimi.json, run.json.
   Të gjitha skedarët dalës (përveç run.json) janë deterministë: i njëjti input jep të njëjtat bajte.
   Formulat, supozimet dhe kufizimet janë te raporti dhe pranë kodit që i llogarit. */
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const [,, IN_PULSE, IN_POD, OUT]=process.argv;
if(!IN_PULSE || !IN_POD || !OUT){ console.error('Përdorimi: node capacity_inspect.js <pulse-data.json> <pod-daily.json> <dosja-dalëse>'); process.exit(2); }
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const inHash={pulse:sha(IN_PULSE), pod:sha(IN_POD)};
const P=JSON.parse(fs.readFileSync(IN_PULSE,'utf8')), C=P.capacity, POD=JSON.parse(fs.readFileSync(IN_POD,'utf8'));
if(!C) { console.error('Blloku capacity mungon te '+IN_PULSE); process.exit(3); }
fs.mkdirSync(OUT,{recursive:true});

// ---------------------------------------------------------------- ndihmës
const isNum=v=>typeof v==='number' && isFinite(v);
const missing=v=>v===null || v===undefined || v==='' || (typeof v==='number' && !isFinite(v));
const sorted=a=>a.filter(isNum).slice().sort((x,y)=>x-y);
const q=(a,p)=>{ const s=sorted(a); if(!s.length) return null; const i=(s.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo); };
const med=a=>q(a,0.5), sum=a=>a.reduce((x,y)=>x+(isNum(y)? y : 0),0), mean=a=>{ const s=a.filter(isNum); return s.length? sum(s)/s.length : null; };
const mad=a=>{ const m=med(a); return m==null? null : med(a.filter(isNum).map(x=>Math.abs(x-m))); };
const r=(x,d=1)=> x==null||!isFinite(x)? null : Math.round(x*10**d)/10**d;
const dow=d=>new Date(d+'T12:00:00Z').getUTCDay();             // 0 = e diel
const dayType=d=>{ const w=dow(d); return w===0? 'e diel' : w===6? 'e shtunë' : 'ditë pune'; };
const addDay=(d,n)=>{ const x=new Date(d+'T12:00:00Z'); x.setUTCDate(x.getUTCDate()+n); return x.toISOString().slice(0,10); };
const csv=(rows, cols)=>[cols.join(',')].concat(rows.map(o=>cols.map(c=>{ const v=o[c]; if(v==null) return ''; const s=String(v); return /[",\n]/.test(s)? '"'+s.replace(/"/g,'""')+'"' : s; }).join(','))).join('\n')+'\n';
const write=(f,s)=>fs.writeFileSync(path.join(OUT,f), s);

// ---------------------------------------------------------------- 1. struktura dhe cilësia
/* për çdo tabelë: rreshta, kolona (bashkimi i çelësave), tipi, vlera që mungojnë, zero, negative, min/mediana/maks;
   dublikatat sipas çelësit natyror; mbulimi i datave dhe datat që mungojnë brenda periudhës */
const TABLES={
  created:{rows:C.created, key:['d'], date:'d', desc:'porosi të krijuara për ditë (o), prej tyre Gjirafa50 (g50) dhe pas 17:30 (late)'},
  vol:{rows:C.vol, key:['d'], date:'d', desc:'njësi për ditë: check-in (ci), mapim (mp), check-out (co); ops = operatorë që skanuan'},
  coOrd:{rows:C.coOrd, key:['d'], date:'d', desc:'porosi të dala (check-out) për ditë'},
  hourly:{rows:C.hourly, key:['h'], desc:'profili sipas orës (shuma në periudhë): njësi dhe operatorë-orë sipas procesit; days = ditë me aktivitet në atë orë'},
  std:{rows:C.std, key:['c'], desc:'koha standarde në WMS (AverageTimeSeconds) sipas veprimit, sekonda'},
  opsMeta:{rows:C.opsMeta, key:['u'], desc:'llogaritë e operatorëve: u = UserId, n = emri, i = inicialet, id = 3 shifrat e fundit, tmp = llogari e përbashkët'},
  opsDay:{rows:C.opsDay, key:['u','d'], date:'d', desc:'puna për llogari × ditë: njësi (ci, mp, co) dhe orë aktive sipas procesit (ciH, mpH, coH) dhe gjithsej (h)'},
  opsOrd:{rows:C.opsOrd, key:['d'], date:'d', desc:'porosi të dala për ditë (në periudhën e opsDay)'},
  rates:{rows:C.rates, key:['id'], desc:'versionet e çmimeve piece-rate (€ për njësi) me vlefshmërinë f → t'},
  sameDay:{rows:C.sameDay, key:['wk'], desc:'same-day për javë: rb = gati deri 17:30, rbSame / rbNext / rbLater = dalë po atë ditë / të nesërmen / më vonë; whP50 / whP90 = minuta gati → check-out'},
  podDaily:{rows:Object.entries(POD).map(([d,n])=>({d,n})), key:['d'], date:'d', desc:'porosi të skanuara në POD për ditë (Delivery Platform)'},
};
const profile={};
Object.entries(TABLES).forEach(([name,t])=>{
  const rows=t.rows||[], cols=[...new Set(rows.flatMap(o=>Object.keys(o)))];
  const colInfo={};
  cols.forEach(c=>{ const vals=rows.map(o=>o[c]), nums=vals.filter(isNum), types=[...new Set(vals.filter(v=>!missing(v)).map(v=>typeof v))];
    colInfo[c]={tipi:types.join('|')||'—', mungojne:vals.filter(missing).length, zero:nums.filter(x=>x===0).length, negative:nums.filter(x=>x<0).length,
      min:nums.length? Math.min(...nums) : null, mediana:r(med(nums),2), maks:nums.length? Math.max(...nums) : null}; });
  const seen=new Map(), dups=[]; rows.forEach((o,i)=>{ const k=t.key.map(f=>o[f]).join('|'); if(seen.has(k)) dups.push({key:k, rreshtat:[seen.get(k),i]}); else seen.set(k,i); });
  let dates=null;
  if(t.date && rows.length){ const ds=[...new Set(rows.map(o=>o[t.date]))].sort(), gaps=[]; for(let d=ds[0]; d<=ds[ds.length-1]; d=addDay(d,1)) if(!ds.includes(d)) gaps.push(d);
    dates={nga:ds[0], deri:ds[ds.length-1], dite:ds.length, mungojne:gaps}; }
  profile[name]={pershkrimi:t.desc, rreshta:rows.length, celesi:t.key.join('+'), kolona:colInfo, dublikata:dups, datat:dates};
});
profile.pay={pershkrimi:'periudha e fundit e pagesës piece-rate në WMS', vlera:C.pay};
profile.meta={periudha_12_javore:[C.from, C.to], opsDay_nga_deri:[C.opsFrom, C.opsTo], lexuar:{capacity:C.at, opsDay:C.opsAt, sameDay:C.sameDayAt}, ops:C.ops};

// ---------------------------------------------------------------- 2. anomalitë
const A=[]; const an=(tabela, rreshti, fusha, vlera, rregulli, detaje)=>A.push({tabela, rreshti, fusha, vlera, rregulli, detaje});
// 2a vlera negative dhe dublikata
Object.entries(TABLES).forEach(([name,t])=>{ (t.rows||[]).forEach(o=>Object.entries(o).forEach(([k,v])=>{ if(isNum(v)&&v<0) an(name, t.key.map(f=>o[f]).join('|'), k, v, 'vlerë negative', ''); }));
  profile[name].dublikata.forEach(d=>an(name, d.key, t.key.join('+'), '', 'dublikatë e çelësit', 'rreshtat '+d.rreshtat.join(' dhe '))); });
// 2b ditë pune pa të dhëna (data që mungojnë brenda periudhës, pa të dielat)
Object.entries(profile).forEach(([name,p])=>{ if(p.datat) p.datat.mungojne.filter(d=>dow(d)!==0).forEach(d=>an(name, d, TABLES[name].date, '', 'ditë që mungon', dayType(d))); });
/* 2c vlera të jashtëzakonshme në seritë ditore: brenda të njëjtit lloj dite (ditë pune / e shtunë / e diel),
   vlera > mediana + 4 × MAD × 1,4826 (z robust > 4), ose ditë pune < 25% e medianës së ditëve të punës */
const series=[['vol','ci'],['vol','mp'],['vol','co'],['vol','ops'],['created','o'],['coOrd','n'],['opsOrd','n'],['podDaily','n']];
series.forEach(([name,f])=>{ const rows=TABLES[name].rows; ['ditë pune','e shtunë','e diel'].forEach(tp=>{ const g=rows.filter(o=>dayType(o.d)===tp), vals=g.map(o=>o[f]), m=med(vals), s=mad(vals);
  g.forEach(o=>{ const v=o[f]; if(!isNum(v)||m==null) return;
    if(s>0 && (v-m)/(1.4826*s)>4) an(name, o.d, f, v, 'shumë e lartë (z robust > 4)', `${tp}: mediana ${r(m)}, z = ${r((v-m)/(1.4826*s),1)}`);
    if(tp==='ditë pune' && v<0.25*m) an(name, o.d, f, v, 'shumë e ulët (< 25% e medianës)', `ditë pune: mediana ${r(m)}`); }); }); });
// 2d llogaritë: emër bosh, i njëjti emër në dy llogari, llogari të përbashkëta
const byName={}; C.opsMeta.forEach(m=>{ if(missing(m.n)||!String(m.n).trim()) an('opsMeta', m.u, 'n', '', 'emër bosh', 'llogari pa emër (id '+m.id+')'); else (byName[m.n]=byName[m.n]||[]).push(m.u); if(m.tmp) an('opsMeta', m.u, 'tmp', 1, 'llogari e përbashkët', m.n); });
Object.entries(byName).filter(([,us])=>us.length>1).forEach(([n,us])=>an('opsMeta', us.join('|'), 'n', n, 'i njëjti emër në disa llogari', us.length+' llogari'));
// 2e opsDay: njësi pa orë, orë procesi > orët gjithsej, h > 24, llogari pa meta, ritëm i pamundshëm (> 3 × ritmi standard)
const metaU=new Map(C.opsMeta.map(m=>[m.u,m])), stdS={}; C.std.forEach(s=>stdS[s.c]=s.s);
const STD_OF={ci:'CheckIn', mp:'Map', co:'CheckoutShipping'};
C.opsDay.forEach(o=>{ const k=o.u+'|'+o.d; if(!metaU.has(o.u)) an('opsDay', k, 'u', o.u, 'llogari pa të dhëna te opsMeta', '');
  ['ci','mp','co'].forEach(p=>{ const u=o[p], hh=o[p+'H'];
    if(u>0 && !(hh>0)) an('opsDay', k, p+'H', hh, 'njësi pa orë aktive', p+' = '+u);
    if(hh>o.h) an('opsDay', k, p+'H', hh, 'orët e procesit > orët gjithsej', 'h = '+o.h);
    const max=3*3600/(stdS[STD_OF[p]]||1); if(hh>0 && u/hh>max) an('opsDay', k, p, r(u/hh), 'ritëm > 3 × ritmi standard', `${r(u/hh)} njësi/orë kundrejt maks. ${r(max)} (3 × 3600 ÷ ${stdS[STD_OF[p]]} s)`); });
  if(o.h>24) an('opsDay', k, 'h', o.h, 'më shumë se 24 orë', ''); });
// 2f çmimet: vlefshmëri me gjatësi zero ose që mbivendoset; versione pa datë mbarimi
const RT=C.rates.slice().sort((a,b)=>a.id-b.id);
RT.forEach(v=>{ if(v.t && v.t<=v.f) an('rates', 'v'+v.id, 'f→t', v.f+' → '+v.t, 'vlefshmëri me gjatësi zero', 'nuk vlen asnjë ditë');
  RT.forEach(w=>{ if(w.id>v.id && (!v.t || w.f<v.t) && (!w.t || v.f<w.t) && !(v.t&&v.t<=v.f) && !(w.t&&w.t<=w.f)) an('rates', 'v'+v.id+'|v'+w.id, 'f→t', '', 'vlefshmëri që mbivendoset', `v${v.id} ${v.f}→${v.t||'…'} · v${w.id} ${w.f}→${w.t||'…'}`); }); });
const openEnded=RT.filter(v=>!v.t); if(openEnded.length>1) an('rates', openEnded.map(v=>'v'+v.id).join('|'), 't', '', 'disa versione pa datë mbarimi', '');
// 2g same-day: rbSame + rbNext + rbLater duhet = rb; java në vazhdim
C.sameDay.forEach(w=>{ const s=w.rbSame+w.rbNext+w.rbLater; if(s!==w.rb) an('sameDay', 'java '+w.wk, 'rb', w.rb, 'shuma e ndarjes ≠ rb', `rbSame + rbNext + rbLater = ${s}`);
  if(w.d1 && addDay(w.d1,6) >= String(C.sameDayAt).slice(0,10)) an('sameDay', 'java '+w.wk, 'd1', w.d1, 'javë e papërfunduar', 'deri në ditën para leximit'); });
// 2h kryqëzimi i tabelave: porositë e dala në dy burime (coOrd dhe opsOrd) për të njëjtën ditë
const coOrdBy=new Map(C.coOrd.map(x=>[x.d,x.n])), ordDiff=[];
C.opsOrd.forEach(x=>{ if(!coOrdBy.has(x.d)) return; const a=coOrdBy.get(x.d), b=x.n; ordDiff.push({d:x.d, coOrd:a, opsOrd:b, diferenca:b-a});
  if(a && Math.abs(b-a)/a>0.02) an('coOrd×opsOrd', x.d, 'n', `${a} / ${b}`, 'dy burimet ndryshojnë > 2%', `diferenca ${b-a}`); });
// 2i mbulimi: Σ opsDay (llogaritë e stafit) kundrejt vol (të gjitha llogaritë) për ditë
const volBy=new Map(C.vol.map(x=>[x.d,x])), cover=[];
const opsSumBy={}; C.opsDay.forEach(o=>{ const s=opsSumBy[o.d]||(opsSumBy[o.d]={ci:0,mp:0,co:0}); s.ci+=o.ci; s.mp+=o.mp; s.co+=o.co; });
Object.entries(opsSumBy).sort().forEach(([d,s])=>{ const v=volBy.get(d); if(!v) return; cover.push({d, ci_ops:s.ci, ci_vol:v.ci, mp_ops:s.mp, mp_vol:v.mp, co_ops:s.co, co_vol:v.co}); });
A.sort((a,b)=> (a.tabela+a.rregulli+a.rreshti).localeCompare(b.tabela+b.rregulli+b.rreshti));
write('anomalite.csv', csv(A, ['tabela','rreshti','fusha','vlera','rregulli','detaje']));

// ---------------------------------------------------------------- 3. produktiviteti
/* për llogari (opsDay, gjithë periudha dhe 28 ditët e fundit):
   ditë = ditë me të paktën një skanim; njësi sipas procesit; orë aktive = orë me ≥ 1 skanim të procesit;
   ritmi = njësi ÷ orë aktive; ops të peshuara = 1,0 × co + 0,8 × ci + 0,6 × map (PerformanceOperationTypes); për ditë = ÷ ditë */
const last28=addDay(C.opsTo,-27);
function perOperator(from,to){ const by={}; C.opsDay.forEach(o=>{ if(o.d<from||o.d>to) return; const m=metaU.get(o.u)||{};
    const x=by[o.u]||(by[o.u]={llogaria:o.u, emri:m.n||'', id:m.id||'', temp:m.tmp?1:0, dite:0, ci:0, ciH:0, mp:0, mpH:0, co:0, coH:0, h:0}); x.dite++; ['ci','ciH','mp','mpH','co','coH','h'].forEach(k=>x[k]+=+o[k]||0); });
  return Object.values(by).map(x=>Object.assign(x,{ ci_ne_ore:x.ciH? r(x.ci/x.ciH) : null, mp_ne_ore:x.mpH? r(x.mp/x.mpH) : null, co_ne_ore:x.coH? r(x.co/x.coH) : null,
    ops_te_peshuara:r(x.co+0.8*x.ci+0.6*x.mp), ops_ne_dite:r((x.co+0.8*x.ci+0.6*x.mp)/x.dite) })).sort((a,b)=>b.ops_te_peshuara-a.ops_te_peshuara || a.llogaria-b.llogaria); }
const opsAll=perOperator(C.opsFrom, C.opsTo), ops28=perOperator(last28, C.opsTo);
write('produktiviteti-operatoret.csv', csv(opsAll.map(x=>Object.assign({periudha:C.opsFrom+'..'+C.opsTo}, x)).concat(ops28.map(x=>Object.assign({periudha:last28+'..'+C.opsTo}, x))),
  ['periudha','llogaria','emri','id','temp','dite','ci','ciH','ci_ne_ore','mp','mpH','mp_ne_ore','co','coH','co_ne_ore','ops_te_peshuara','ops_ne_dite']));
// ekipi për ditë (vol): njësi për operator që skanoi; porosi për operator
const daily=C.vol.map(v=>({d:v.d, lloji:dayType(v.d), ci:v.ci, mp:v.mp, co:v.co, operatore:v.ops, porosi_dala:coOrdBy.get(v.d)??null, porosi_krijuara:(C.created.find(x=>x.d===v.d)||{}).o??null,
  pod:POD[v.d]??null, njesi_per_operator:v.ops? r((v.ci+v.mp+v.co)/v.ops) : null, porosi_per_operator:v.ops&&coOrdBy.has(v.d)? r(coOrdBy.get(v.d)/v.ops) : null}));
write('produktiviteti-ditor.csv', csv(daily, ['d','lloji','ci','mp','co','operatore','porosi_dala','porosi_krijuara','pod','njesi_per_operator','porosi_per_operator']));

// ---------------------------------------------------------------- 4. saktësia (vetëm aty ku ka kolona)
/* a) same-day = rbSame ÷ rb (premtimi: gati deri 17:30 → dalë po atë ditë); carryover = (rbNext + rbLater) ÷ rb
   b) saktësia e modelit të kostos: Σ (njësi × çmimi i versionit që vlente atë ditë) për muajin e pagesës ÷ pagesa reale − 1
      (vetëm check-in, mapim, check-out: picking-u nuk skanohet; vetëm llogaritë te opsDay)
   c) përputhja e burimeve: porositë e dala coOrd kundrejt opsOrd; mbulimi i vol nga opsDay */
const sd=C.sameDay.map(w=>({java:w.wk, nga:w.d1, gati_deri_1730:w.rb, po_ate_dite:w.rbSame, te_nesermen:w.rbNext, me_vone:w.rbLater, same_day_pct:w.rb? r(w.rbSame/w.rb*100) : null,
  carryover_pct:w.rb? r((w.rbNext+w.rbLater)/w.rb*100) : null, cross_dock_porosi:w.xdo, njesi:w.units, gati_ne_checkout_p50_min:r(w.whP50), gati_ne_checkout_p90_min:r(w.whP90)}));
write('saktesia-same-day.csv', csv(sd, ['java','nga','gati_deri_1730','po_ate_dite','te_nesermen','me_vone','same_day_pct','carryover_pct','cross_dock_porosi','njesi','gati_ne_checkout_p50_min','gati_ne_checkout_p90_min']));
const priceOn=d=>RT.filter(v=>v.f<=d && (!v.t || v.t>d)).sort((a,b)=>b.id-a.id)[0] || RT.slice().sort((a,b)=>b.id-a.id)[0];
let costModel=null;
if(C.pay && C.pay.y && C.pay.mo){ const mm=String(C.pay.y)+'-'+String(C.pay.mo).padStart(2,'0'); let est=0, units=0, vers=new Set();
  C.opsDay.forEach(o=>{ if(o.d.slice(0,7)!==mm) return; const v=priceOn(o.d); vers.add(v.id); ['ci','mp','co'].forEach(p=>{ est+=(+o[p]||0)*(+v[p]||0); units+=+o[p]||0; }); });
  costModel={muaji:mm, e_vleresuar_eur:r(est,2), e_paguar_eur:r(C.pay.tc,2), devijimi_pct:C.pay.tc? r((est/C.pay.tc-1)*100,2) : null, njesi:units, veprime_te_paguara:C.pay.ta, versionet:[...vers].sort()}; }

// ---------------------------------------------------------------- 5. kohët e procesit
/* koha standarde (WMS) kundrejt kohës së vëzhguar për njësi = 3600 ÷ (njësi ÷ orë aktive), për ekipin dhe për llogari;
   orët aktive përfshijnë edhe pauzat brenda orës, ndaj koha e vëzhguar është kufi i sipërm i kohës së veprimit */
const team=k=>{ const U=sum(C.opsDay.map(o=>o[k])), H=sum(C.opsDay.map(o=>o[k+'H'])); return {U,H}; };
const times=['ci','mp','co'].map(p=>{ const t=team(p), s=stdS[STD_OF[p]], obs=t.U? 3600*t.H/t.U : null; const per=opsAll.filter(x=>x[p+'H']>=8).map(x=>3600*x[p+'H']/x[p]);
  return {procesi:{ci:'Check-in',mp:'Mapim',co:'Check-out'}[p], koha_standarde_s:s, njesi:t.U, ore_aktive:t.H, koha_e_vezhguar_s_ekipi:r(obs), raporti_vezhguar_ndaj_standardit:obs&&s? r(obs/s,2) : null,
    llogari_me_8_plus_ore:per.length, koha_s_mediana_llogarive:r(med(per)), koha_s_p10:r(q(per,0.1)), koha_s_p90:r(q(per,0.9))}; });
const wh=C.sameDay.map(w=>({java:w.wk, p50:w.whP50, p90:w.whP90}));
const hourly=C.hourly.map(x=>({ora:x.h, dite:x.days, co_njesi_ne_operator_ore:x.coOps? r(x.co/x.coOps) : null, ci_njesi_ne_operator_ore:x.ciOps? r(x.ci/x.ciOps) : null, mp_njesi_ne_operator_ore:x.mpOps? r(x.mp/x.mpOps) : null}));
write('kohet-procesit.csv', csv(times, ['procesi','koha_standarde_s','njesi','ore_aktive','koha_e_vezhguar_s_ekipi','raporti_vezhguar_ndaj_standardit','llogari_me_8_plus_ore','koha_s_mediana_llogarive','koha_s_p10','koha_s_p90'])
  +'\n'+csv(hourly, ['ora','dite','co_njesi_ne_operator_ore','ci_njesi_ne_operator_ore','mp_njesi_ne_operator_ore']));

// ---------------------------------------------------------------- 6. verifikimi i brendshëm
const V=[]; const check=(emri, ok, detaje)=>V.push({kontrolli:emri, rezultati:ok? 'OK' : 'DËSHTOI', detaje});
check('Σ njësive të operatorëve (gjithë periudha) = Σ opsDay', ['ci','mp','co'].every(p=>sum(opsAll.map(x=>x[p]))===sum(C.opsDay.map(o=>o[p]))), 'ci, mp, co');
check('çdo rresht opsDay numërohet një herë', sum(opsAll.map(x=>x.dite))===C.opsDay.length, sum(opsAll.map(x=>x.dite))+' = '+C.opsDay.length);
check('same-day: rbSame + rbNext + rbLater = rb për çdo javë', C.sameDay.every(w=>w.rbSame+w.rbNext+w.rbLater===w.rb), C.sameDay.length+' javë');
check('mbulimi: Σ opsDay ≤ vol për çdo ditë dhe proces', cover.every(c=>c.ci_ops<=c.ci_vol && c.mp_ops<=c.mp_vol && c.co_ops<=c.co_vol), cover.filter(c=>!(c.ci_ops<=c.ci_vol && c.mp_ops<=c.mp_vol && c.co_ops<=c.co_vol)).length+' ditë jashtë rregullit');
check('asnjë vlerë negative', !A.some(a=>a.rregulli==='vlerë negative'), A.filter(a=>a.rregulli==='vlerë negative').length+' raste');
check('asnjë dublikatë e çelësit', !A.some(a=>a.rregulli==='dublikatë e çelësit'), A.filter(a=>a.rregulli==='dublikatë e çelësit').length+' raste');
const covTot={ci:[sum(cover.map(c=>c.ci_ops)), sum(cover.map(c=>c.ci_vol))], mp:[sum(cover.map(c=>c.mp_ops)), sum(cover.map(c=>c.mp_vol))], co:[sum(cover.map(c=>c.co_ops)), sum(cover.map(c=>c.co_vol))]};
write('verifikimi.json', JSON.stringify({kontrollet:V, mbulimi_opsDay_ndaj_vol:Object.fromEntries(Object.entries(covTot).map(([k,[a,b]])=>[k,{opsDay:a, vol:b, pct:b? r(a/b*100,1) : null}])),
  porosi_coOrd_ndaj_opsOrd:{dite:ordDiff.length, diferenca_mesatare:r(mean(ordDiff.map(x=>x.diferenca)),1), max_abs:ordDiff.length? Math.max(...ordDiff.map(x=>Math.abs(x.diferenca))) : null}}, null, 2)+'\n');
write('profili.json', JSON.stringify(profile, null, 2)+'\n');

// ---------------------------------------------------------------- 7. raporti
const cnt=f=>A.filter(f).length, byRule={}; A.forEach(a=>{ const k=a.tabela+' · '+a.rregulli; byRule[k]=(byRule[k]||0)+1; });
const wdVol=C.vol.filter(v=>dayType(v.d)==='ditë pune');
const top=opsAll.filter(x=>!x.temp && x.dite>=10).slice(0,10);
const md=[];
md.push(`# Kapaciteti & Stafi — inspektimi i të dhënave`, '',
`**Hyrja:** \`capacity\` te pulse/data.json (lexuar nga WMS ${C.at}) dhe data/pod-daily.json · **Periudha:** ${C.from} → ${C.to} (12 javë, deri dita para \`to\`), puna sipas llogarisë ${C.opsFrom} → ${C.opsTo} · **Origjinalet:** vetëm lexim; SHA-256 pulse ${inHash.pulse.slice(0,16)}…, pod ${inHash.pod.slice(0,16)}…`, '',
`Rikrijimi: \`node analysis-tools/capacity_inspect.js <pulse-data.json> <pod-daily.json> <dosja>\` — i njëjti input jep të njëjtat skedarë (përveç run.json).`, '');
md.push(`## 1. Struktura`, '', `| Tabela | Rreshta | Çelësi | Datat | Përmbajtja |`, `| --- | --- | --- | --- | --- |`);
Object.entries(TABLES).forEach(([n,t])=>{ const p=profile[n]; md.push(`| ${n} | ${p.rreshta} | ${p.celesi} | ${p.datat? p.datat.nga+' → '+p.datat.deri+' ('+p.datat.dite+' ditë)' : '—'} | ${t.desc} |`); });
md.push('', `Gjithashtu: \`pay\` (periudha ${C.pay&&C.pay.mo}/${C.pay&&C.pay.y}: €${C.pay&&r(C.pay.tc,2)} për ${C.pay&&C.pay.ta} veprime, ${C.pay&&C.pay.orders} porosi) · \`ops\` = ${JSON.stringify(C.ops)} (fushë e vjetër, nuk përdoret).`, '');
md.push(`## 2. Cilësia: vlera që mungojnë, dublikata, data`, '');
const missRows=[]; Object.entries(profile).forEach(([n,p])=>{ if(!p.kolona) return; Object.entries(p.kolona).forEach(([c,i])=>{ if(i.mungojne) missRows.push(`| ${n} | ${c} | ${i.mungojne} nga ${p.rreshta} |`); }); });
md.push(`**Vlera që mungojnë:** ${missRows.length? '' : 'asnjë.'}`); if(missRows.length) md.push('', `| Tabela | Kolona | Mungojnë |`, `| --- | --- | --- |`, ...missRows);
md.push('', `**Dublikata të çelësit:** ${cnt(a=>a.rregulli==='dublikatë e çelësit')} · **Vlera negative:** ${cnt(a=>a.rregulli==='vlerë negative')}`, '');
const gapRows=Object.entries(profile).filter(([,p])=>p.datat&&p.datat.mungojne.length).map(([n,p])=>`| ${n} | ${p.datat.mungojne.length} | ${p.datat.mungojne.slice(0,8).join(', ')}${p.datat.mungojne.length>8?' …':''} |`);
md.push(`**Data që mungojnë brenda periudhës:** ${gapRows.length? '' : 'asnjë.'}`); if(gapRows.length) md.push('', `| Tabela | Ditë | Cilat |`, `| --- | --- | --- |`, ...gapRows);
md.push('', `## 3. Anomalitë (${A.length})`, '', `Rregullat dhe numri i rasteve; lista e plotë te anomalite.csv.`, '', `| Tabela · rregulli | Raste |`, `| --- | --- |`);
Object.entries(byRule).sort((a,b)=>b[1]-a[1]).forEach(([k,n])=>md.push(`| ${k} | ${n} |`));
const showRules=['vlefshmëri me gjatësi zero','vlefshmëri që mbivendoset','emër bosh','i njëjti emër në disa llogari','shuma e ndarjes ≠ rb','dy burimet ndryshojnë > 2%','ritëm > 3 × ritmi standard','orët e procesit > orët gjithsej','shumë e lartë (z robust > 4)','shumë e ulët (< 25% e medianës)'];
const perRule={}, shown=A.filter(a=>showRules.includes(a.rregulli) && (perRule[a.tabela+a.rregulli]=(perRule[a.tabela+a.rregulli]||0)+1)<=3);
if(shown.length) md.push('', `Shembuj (deri 3 për çdo rregull):`, '', `| Tabela | Rreshti | Fusha | Vlera | Rregulli | Detaje |`, `| --- | --- | --- | --- | --- | --- |`, ...shown.map(a=>`| ${a.tabela} | ${a.rreshti} | ${a.fusha} | ${a.vlera} | ${a.rregulli} | ${a.detaje} |`));
md.push('', `## 4. Produktiviteti`, '', `**Formula:** ritmi = njësi ÷ orë aktive të procesit · ops të peshuara = 1,0 × check-out + 0,8 × check-in + 0,6 × map · ops/ditë = ÷ ditë me skanim.`, '',
`**Ekipi, ditë pune (${wdVol.length} ditë):** check-out mediana ${r(med(wdVol.map(v=>v.co)))} njësi, check-in ${r(med(wdVol.map(v=>v.ci)))}, mapim ${r(med(wdVol.map(v=>v.mp)))}, operatorë që skanojnë ${r(med(wdVol.map(v=>v.ops)))}; njësi për operator ${r(med(daily.filter(x=>x.lloji==='ditë pune').map(x=>x.njesi_per_operator)))}.`, '',
`**10 llogaritë me më shumë punë** (${C.opsFrom} → ${C.opsTo}, ≥ 10 ditë, pa llogari temp):`, '', `| Llogaria | Ditë | Check-in / orë | Mapim / orë | Check-out / orë | Ops / ditë |`, `| --- | --- | --- | --- | --- | --- |`,
...top.map(x=>`| ${x.emri||'(pa emër)'} (${x.id}) | ${x.dite} | ${x.ci_ne_ore??'—'} | ${x.mp_ne_ore??'—'} | ${x.co_ne_ore??'—'} | ${x.ops_ne_dite} |`), '', `Të gjitha llogaritë, për gjithë periudhën dhe 28 ditët e fundit: produktiviteti-operatoret.csv; ekipi për ditë: produktiviteti-ditor.csv.`, '');
md.push(`## 5. Saktësia`, '', `Në këto të dhëna **nuk ka kolona për gabime picking-u, porosi të gabuara apo saktësi inventari** — ato nuk mund të maten këtu. Matet vetëm sa lejojnë kolonat:`, '',
`**a) Same-day** = po atë ditë ÷ gati deri 17:30 (saktësia e premtimit ndaj klientit):`, '', `| Java | Gati | Same-day | Carryover | Gati → check-out p50 / p90 (min) |`, `| --- | --- | --- | --- | --- |`,
...sd.map(w=>`| ${w.java} (${w.nga}) | ${w.gati_deri_1730} | ${w.same_day_pct}% | ${w.carryover_pct}% | ${w.gati_ne_checkout_p50_min} / ${w.gati_ne_checkout_p90_min} |`), '',
costModel? `**b) Modeli i kostos** (${costModel.muaji}): i vlerësuar €${costModel.e_vleresuar_eur} (njësi × çmimi i versionit ${costModel.versionet.map(v=>'v'+v).join(', ')}) kundrejt €${costModel.e_paguar_eur} të paguar → devijimi **${costModel.devijimi_pct}%**. Picking-u nuk skanohet, ndaj modeli pritet të jetë pak poshtë.` : '**b) Modeli i kostos:** pa periudhë pagese.', '',
`**c) Përputhja e burimeve:** porositë e dala në coOrd dhe opsOrd për ${ordDiff.length} ditë të përbashkëta: diferenca mesatare ${r(mean(ordDiff.map(x=>x.diferenca)),1)}, maksimale ${ordDiff.length? Math.max(...ordDiff.map(x=>Math.abs(x.diferenca))) : '—'}. Shumat e opsDay (puna për llogari) kundrejt vol (totali ditor) në ditët e përbashkëta: ${Object.entries(covTot).map(([k,[a,b]])=>k+' '+(b? r(a/b*100,1) : '—')+'%').join(', ')} — të dy vijnë nga i njëjti log i WMS-it dhe përputhen.`, '');
md.push(`## 6. Kohët e procesit`, '', `**Formula:** koha e vëzhguar për njësi = 3600 × orë aktive ÷ njësi. Orët aktive përfshijnë pauzat brenda orës, ndaj kjo është kufi i sipërm i kohës së veprimit; koha standarde vjen nga WMS (AverageTimeSeconds).`, '',
`| Procesi | Standardi (s) | E vëzhguar, ekipi (s) | Raporti | Llogari (≥ 8 orë) | Mediana e llogarive (s) | P10–P90 (s) |`, `| --- | --- | --- | --- | --- | --- | --- |`,
...times.map(t=>`| ${t.procesi} | ${t.koha_standarde_s} | ${t.koha_e_vezhguar_s_ekipi} | ${t.raporti_vezhguar_ndaj_standardit}× | ${t.llogari_me_8_plus_ore} | ${t.koha_s_mediana_llogarive} | ${t.koha_s_p10}–${t.koha_s_p90} |`), '',
`Profili sipas orës (njësi për operator-orë) dhe gati → check-out sipas javës: kohet-procesit.csv dhe saktesia-same-day.csv.`, '');
md.push(`## 7. Supozimet dhe kufizimet`, '',
`- Ditët klasifikohen sipas kalendarit (ditë pune / e shtunë / e diel); festat nuk dallohen.`,
`- "Vlerë e jashtëzakonshme" = z robust > 4 brenda të njëjtit lloj dite (mediana dhe MAD), ose ditë pune < 25% e medianës. Është sinjal për kontroll, jo gabim i provuar.`,
`- "Ritëm i pamundshëm" = më shumë se 3 × ritmi standard i WMS-it; mund të vijë nga skanime masive (p.sh. mapim i shumë njësive njëherësh).`,
`- Llogaritë analizohen si llogari, jo si persona: një person me dy llogari del dy herë; llogaritë temp nuk kanë pronar.`,
`- Orët aktive = orë me të paktën një skanim; nuk janë orë pune të paguara dhe nuk përfshijnë punë pa skanim (picking pa sesion, boxing, ngarkim).`,
`- vol dhe opsDay vijnë nga i njëjti log i WMS-it (të gjitha llogaritë): në ditët e përbashkëta shumat përputhen 100%. coOrd dhe opsOrd (porosi të dala) llogariten në dy blloqe të ndryshme dhe ndryshojnë pak (seksioni 5c) — përdor njërin burim për një krahasim.`,
`- Kohët për llogari me pak mapim të shpërndarë në shumë orë dalin shumë të gjata (P90 i mapimit); mediana është më e besueshme se P90.`,
`- Blloku 12-javor (created, vol, coOrd) mbyllet me javë të plota; opsDay shkon deri dje. Krahasimet bëhen vetëm në ditët e përbashkëta.`,
`- Modeli i kostos llogarit vetëm check-in, mapim, check-out dhe vetëm llogaritë te opsDay.`, '');
md.push(`## 8. Verifikimi`, '', `| Kontrolli | Rezultati | Detaje |`, `| --- | --- | --- |`, ...V.map(v=>`| ${v.kontrolli} | ${v.rezultati} | ${v.detaje} |`), '');
write('raporti.md', md.join('\n'));
const outs=['raporti.md','profili.json','anomalite.csv','produktiviteti-operatoret.csv','produktiviteti-ditor.csv','saktesia-same-day.csv','kohet-procesit.csv','verifikimi.json'];
write('run.json', JSON.stringify({koha:new Date().toISOString(), skripti:'analysis-tools/capacity_inspect.js', hyrjet:{[IN_PULSE]:inHash.pulse, [IN_POD]:inHash.pod},
  daljet:Object.fromEntries(outs.map(f=>[f, sha(path.join(OUT,f))]))}, null, 2)+'\n');
console.log('OK · anomali '+A.length+' · kontrolle '+V.filter(v=>v.rezultati==='OK').length+'/'+V.length+' OK → '+OUT);
