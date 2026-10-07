/* ============================================================================
   WMS data-access layer for the "Statistikat e WH" module — every WMS-derived
   statistic of the module is defined here, in one place (see docs/wms-queries.md).

   Phase 1 source: the WMS ProductLogs event log, read through the agent's web session
   (the same rows fetchDayProductLogs already retrieves completely). Verified 2026-09-28:
   checked-out orders (LogTypeId 4 ∪ 18, distinct OrderId) from these rows equal the SQL
   figures for Prishtinë (WarehouseId 1) — 493 = 493 (22.09), 533 = 533 (23.09), 587 vs 586
   (24.09) — so this data is reported as "Depo Prishtinë". Its limits: the web rows carry
   PlatformId = 0 on every row (no GjirafaMall/Gjirafa50 split) and orders are keyed on
   OrderId alone (rare cross-platform collisions possible). Order-level SQL statistics
   (same-day, carryover, backlog, lead time, cost, inbound, stock accuracy, stations,
   shipments) come in phase 2 through the Gjirafa50 MCP connector.

   Per-day aggregates are cached in memory and, once a day has settled (WMS keeps
   appending backdated events for ~3 days), on disk in stats-day-cache.json.
   ==========================================================================*/
'use strict';
const fs=require('fs'), path=require('path');

const CO_TYPES=[4,18];                    // check-out, WMS's own definition (PerformanceOperationTypes)
const OUT_TYPES=[3,4,9,18,27];            // any outbound step: a unit that reached these is no longer waiting for putaway
const CACHE_VERSION=2;                    // v2 adds per-worker event times (ev) for the shift statistics
const RESPONSE_TTL_MS=10*60*1000;

module.exports=function makeWmsStats(d){
  const CACHE_FILE=path.join(d.appDir,'stats-day-cache.json');
  let disk={version:CACHE_VERSION, days:{}};
  try{ const j=JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); if(j && j.version===CACHE_VERSION && j.days) disk=j; }catch(e){}
  const mem={};              // iso -> aggregate (all days, including unsettled ones, for this agent run)
  const responses={};        // cache key -> {at, data}
  const inflight={};

  const ageDays=iso=>Math.round((new Date(d.isoToday()+'T00:00:00') - new Date(iso+'T00:00:00'))/86400000);

  /* One calendar day of ProductLogs → a small, serialisable aggregate. */
  function dayAgg(rows, iso, reliable){
    const staff=d.warehouseStaffSet();
    const a={date:iso, reliable, coUnits:new Array(24).fill(0), coOrders:[], kinds:{checkin:new Array(24).fill(0), map:new Array(24).fill(0), checkout:new Array(24).fill(0)},
      workers:{}, ci:{}, mp:{}, out:{}, ev:{}};
    const firstCo={};
    rows.forEach(x=>{
      const t=Number(x.LogTypeId), ts=d.parseWmsDate(x.InsertDateTime); if(ts==null) return;
      const dt=new Date(ts), hr=dt.getHours(), minute=hr*60+dt.getMinutes(), unit=x.ProductItemUniqueIdentifierId;
      if(CO_TYPES.includes(t)){ a.coUnits[hr]++; if(x.OrderId){ const k=String(x.OrderId); if(firstCo[k]==null || minute<firstCo[k]) firstCo[k]=minute; } }
      if(unit){
        if(t===2 && !(a.ci[unit]<=ts)) a.ci[unit]=ts;
        if(t===7 && !(a.mp[unit]<=ts)) a.mp[unit]=ts;
        if(OUT_TYPES.includes(t) && !(a.out[unit]<=ts)) a.out[unit]=ts;
      }
      const raw=String(x.UpdatedByName||'').replace(/\s+/g,' ').trim(); if(!staff.has(d.normName(raw))) return;
      const name=d.STAFF_ALIASES[d.normName(raw)]||raw;
      (a.ev[name]||(a.ev[name]=[])).push([minute, t]);        // every event of a staff member, for shift presence/timing
      const kind=d.PERF_KIND[t]; if(!kind) return;
      a.kinds[kind][hr]++;
      const w=a.workers[name]||(a.workers[name]={checkin:0, map:0, checkout:0}); w[kind]++;
    });
    a.coOrders=Object.entries(firstCo).map(([k,m])=>[k,m]);
    return a;
  }
  async function getDay(iso){
    const settled=ageDays(iso)>=d.CACHE_SETTLE_DAYS;
    if(mem[iso] && (settled || Date.now()-mem[iso]._at<RESPONSE_TTL_MS)) return mem[iso];
    if(settled && disk.days[iso]) return (mem[iso]=Object.assign(disk.days[iso],{_at:Date.now()}));
    const dl=await d.fetchDayProductLogs(d.isoToMdy(iso), {noCache:!settled});
    if(dl.error) return {error:dl.error};
    const a=dayAgg(dl.rows, iso, dl.reliable);
    if(settled && dl.reliable){ disk.days[iso]=a; try{ fs.writeFileSync(CACHE_FILE, JSON.stringify(disk)); }catch(e){} }
    a._at=Date.now(); mem[iso]=a; return a;
  }

  const median=a=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y), m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
  const pct=(a,p)=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.floor(p*s.length))]; };
  const r1=x=>x==null?null:Math.round(x*10)/10;
  const isWeekend=iso=>{ const g=new Date(iso+'T12:00:00').getDay(); return g===0||g===6; };
  const toMin=s=>{ const m=/^(\d{1,2}):(\d{2})/.exec(s||''); return m?Number(m[1])*60+Number(m[2]):null; };

  /* A shift filter keeps events inside the shift's hours on the shift's kind of day (workday vs weekend).
     N1 07–15 and N2 13–21 overlap: an event at 14:00 belongs to both — the filter means "during shift hours". */
  function shiftFilter(shift){
    if(!shift) return {day:()=>true, minute:()=>true};
    const a=toMin(shift.start), b=toMin(shift.end);
    return {day:iso=>!!shift.weekend===isWeekend(iso), minute:m=> b>=a ? (m>=a && m<b) : (m>=a || m<b)};
  }
  const hourIn=(f,h)=>f.minute(h*60);

  function summarise(aggs, days, prevAggs, f, today, single, laterAggs){
    const inRange=days.filter(f.day);
    // --- 5.1 throughput -------------------------------------------------------
    const byDay=inRange.map(iso=>{ const a=aggs[iso];
      return {date:iso, weekend:isWeekend(iso), partial:iso===today,
        orders:a.coOrders.filter(([,m])=>f.minute(m)).length, units:a.coUnits.reduce((s,v,h)=>s+(hourIn(f,h)?v:0),0)}; });
    // a single chosen day counts as itself (weekend or today included); longer periods average complete workdays only
    const full=single? byDay : byDay.filter(x=>!x.partial && !x.weekend);
    const avg=arr=>arr.length? arr.reduce((s,x)=>s+x,0)/arr.length : null;
    const prevFull=prevAggs.filter(a=>a && f.day(a.date) && (single || !isWeekend(a.date)));
    const avgOrders=avg(full.map(x=>x.orders)), prevAvgOrders=avg(prevFull.map(a=>a.coOrders.filter(([,m])=>f.minute(m)).length));
    const byHour=Array.from({length:24},(_,h)=>({hour:h, orders:0, units:0}));
    const heat=Array.from({length:7},()=>new Array(24).fill(0));       // Mon..Sun × hour, orders
    inRange.forEach(iso=>{ const a=aggs[iso], dow=(new Date(iso+'T12:00:00').getDay()+6)%7;
      a.coOrders.forEach(([,m])=>{ if(!f.minute(m)) return; const h=Math.floor(m/60); byHour[h].orders++; heat[dow][h]++; });
      a.coUnits.forEach((v,h)=>{ if(hourIn(f,h)) byHour[h].units+=v; }); });
    const nDays=inRange.length||1;
    // --- 5.3 check-in → map ----------------------------------------------------
    const allMp={}, allOut={};
    Object.values(aggs).concat(prevAggs.filter(Boolean), laterAggs||[]).forEach(a=>{
      Object.entries(a.mp).forEach(([u,t])=>{ if(!(allMp[u]<=t)) allMp[u]=t; });
      Object.entries(a.out).forEach(([u,t])=>{ if(!(allOut[u]<=t)) allOut[u]=t; }); });
    const putaway=ciSet=>{ const mins=[]; let unmapped=0; const buckets={'<2h':0,'2–8h':0,'8–24h':0,'>24h':0}; const now=Date.now();
      ciSet.forEach(([u,t])=>{ const m=allMp[u]; if(m!=null && m>=t){ mins.push((m-t)/60000); return; }
        const o=allOut[u]; if(o!=null && o>=t) return;   // went out without being mapped (e.g. straight to an order)
        unmapped++; const hAge=(now-t)/3600000; buckets[hAge<2?'<2h':hAge<8?'2–8h':hAge<24?'8–24h':'>24h']++; });
      return {mins, unmapped, buckets}; };
    const ciOf=list=>list.flatMap(a=>Object.entries(a.ci).filter(([,t])=>{ const dt=new Date(t); return f.minute(dt.getHours()*60+dt.getMinutes()); }));
    const cur=putaway(ciOf(inRange.map(iso=>aggs[iso]))), prv=putaway(ciOf(prevAggs.filter(a=>a && f.day(a.date))));
    // --- 5.4 productivity ------------------------------------------------------
    const W={}, P={};
    const addW=(T,a)=>{ Object.entries(a.workers).forEach(([n,w])=>{ const o=T[n]||(T[n]={checkin:0,map:0,checkout:0,days:0}); o.checkin+=w.checkin; o.map+=w.map; o.checkout+=w.checkout; o.days++; }); };
    inRange.forEach(iso=>addW(W,aggs[iso])); prevAggs.filter(a=>a && f.day(a.date)).forEach(a=>addW(P,a));
    const weighted=o=>o.checkout*d.PERF_WEIGHT.checkout + o.checkin*d.PERF_WEIGHT.checkin + o.map*d.PERF_WEIGHT.map;
    const workers=Object.entries(W).map(([n,o])=>{ const perDay=o.days?weighted(o)/o.days:0, p=P[n], prevPerDay=p&&p.days?weighted(p)/p.days:null;
      return {operator:n, checkin:o.checkin, map:o.map, checkout:o.checkout, activeDays:o.days, weighted:r1(weighted(o)), perDay:r1(perDay), prevPerDay:r1(prevPerDay),
        changePct: prevPerDay? Math.round((perDay-prevPerDay)/prevPerDay*100) : null,
        stdHoursPerDay: o.days? r1((o.checkin*d.PERF_SECONDS.checkin + o.map*d.PERF_SECONDS.map + o.checkout*d.PERF_SECONDS.checkout)/3600/o.days) : 0}; });
    const vals=workers.map(w=>w.perDay), mean=avg(vals)||0, sd=vals.length>1? Math.sqrt(vals.reduce((s,v)=>s+(v-mean)*(v-mean),0)/vals.length) : 0;
    workers.forEach(w=>{ w.band = w.perDay>mean*1.25?'above':w.perDay<mean*0.75?'below':'average';
      w.spike = sd>0 && w.perDay>mean+2*sd; w.declining = w.changePct!=null && w.changePct<=-15; });
    workers.sort((a,b)=>b.perDay-a.perDay);
    const prodByHour=Array.from({length:24},(_,h)=>({hour:h, weighted:0}));
    inRange.forEach(iso=>{ const k=aggs[iso].kinds; for(let h=0;h<24;h++) if(hourIn(f,h)) prodByHour[h].weighted+=k.checkout[h]*d.PERF_WEIGHT.checkout+k.checkin[h]*d.PERF_WEIGHT.checkin+k.map[h]*d.PERF_WEIGHT.map; });
    return {
      throughput:{ byDay, byHour:byHour.filter(x=>x.orders||x.units).map(x=>({hour:x.hour, ordersPerDay:r1(x.orders/nDays), unitsPerDay:r1(x.units/nDays)})), heatmap:heat,
        avgOrdersPerWorkday:r1(avgOrders), prevAvgOrdersPerWorkday:r1(prevAvgOrders), workdaysCounted:full.length,
        totalOrders:byDay.reduce((s,x)=>s+x.orders,0), totalUnits:byDay.reduce((s,x)=>s+x.units,0) },
      putaway:{ pairs:cur.mins.length, medianMin:r1(median(cur.mins)), p90Min:r1(pct(cur.mins,0.9)), prevMedianMin:r1(median(prv.mins)), unmapped:cur.unmapped, unmappedBuckets:cur.buckets },
      productivity:{ workers, teamAvgPerDay:r1(mean), sdPerDay:r1(sd), byHour:prodByHour.filter(x=>x.weighted).map(x=>({hour:x.hour, weightedPerDay:r1(x.weighted/nDays)})) },
    };
  }

  /* days: the last n days ending today, or — with `date` — that single day (compared with the day before) */
  async function build(n, shiftName, date){
    const today=d.isoToday();
    const days=date? [date] : d.lastNDays(n);
    n=days.length;
    const prevDays=Array.from({length:n},(_,i)=>d.isoAddDays(days[0],-n+i));
    const db=d.loadDb()||{}; const shift=shiftName ? (db.wmsShifts||[]).find(s=>s.name===shiftName) : null;
    if(shiftName && !shift) return {error:'Turni «'+shiftName+'» s\'u gjet te WMS → Shifts.'};
    const aggs={}, prev=[]; let reliable=true;
    for(const iso of days){ const a=await getDay(iso); if(a.error) return {error:a.error}; aggs[iso]=a; if(!a.reliable) reliable=false; }
    for(const iso of prevDays){ const a=await getDay(iso); if(a.error) return {error:a.error}; prev.push(a); }
    // A period that ends before today: a unit checked in then may have been mapped (or shipped) on a later day —
    // read the days after it too, up to 14, so "not yet mapped" really means not mapped by now.
    const later=[];
    for(let iso=d.isoAddDays(days[days.length-1],1), k=0; iso<=today && k<14; iso=d.isoAddDays(iso,1), k++){
      const a=await getDay(iso); if(a.error) return {error:a.error}; later.push(a); }
    const out=summarise(aggs, days, prev, shiftFilter(shift), today, !!date, later);
    return Object.assign({ scope:{ warehouse:'Prishtinë (WH 1)', platform:'Të dyja — log-u web s\'e dallon platformën', from:days[0], to:days[days.length-1], days:n,
      prevFrom:prevDays[0], prevTo:prevDays[prevDays.length-1], shift:shift?shift.name+' '+shift.start+'–'+shift.end+(shift.weekend?' (weekend)':' (ditë pune)'):'Të gjitha' },
      refreshedAt:new Date().toISOString(), reliable }, out);
  }

  /* 10-minute response cache; concurrent identical requests share one build. */
  async function live(n, shiftName, date){
    const key=(date||n)+'|'+(shiftName||'');
    const c=responses[key]; if(c && Date.now()-c.at<RESPONSE_TTL_MS) return Object.assign({}, c.data, {cached:true});
    if(!inflight[key]) inflight[key]=build(n, shiftName, date).finally(()=>{ delete inflight[key]; });
    const data=await inflight[key];
    if(!data.error) responses[key]={at:Date.now(), data};
    return data;
  }
  /* --- Shift statistics (WMS → Shifts tab) -------------------------------------------------------------
     With a planned schedule for the day (shift-schedule.js), each operator belongs to the shift they were planned
     for; planned-but-no-scans = possible absence, scans-but-not-planned (or planned OFF) = work outside the plan,
     and the start/end signals are measured against each person's own planned hours. Shifts are grouped by planned
     hours (named after a configured shift with the same hours, else "09:00–17:00").
     Without a schedule for the day, each staff member is assigned to ONE configured shift from when they actually
     worked: the shift with most of their events in hours that belong to it only (N1 07–13, N2 15–21 — the 13–15
     overlap decides nothing), else the shift containing their first event.
     Performance counts only events inside the (planned or assigned) hours; the rest is "outside". First/last scan
     and idle gaps are scan-based signals, not clock-in times: a worker can be present without scanning. */
  const IDLE_GAP_MIN=30, LATE_MIN=15, EARLY_MIN=30;
  const hhmm=m=>m==null?null:String(Math.floor(m/60)).padStart(2,'0')+':'+String(Math.round(m%60)).padStart(2,'0');
  function shiftDay(a, iso, shifts, plan, nowMin){
    const inR=(r,m)=> r.b>=r.a ? (m>=r.a && m<r.b) : (m>=r.a || m<r.b);
    const we=isWeekend(iso), res={}, unplanned=[];
    const group=(start,end)=>{ const def=shifts.find(s=>s.start===start && s.end===end && !!s.weekend===we) || shifts.find(s=>s.start===start && s.end===end);
      const label=def? def.name : start+'–'+end;
      return res[label]||(res[label]={name:label, start, end, weekend:we, r:{a:toMin(start), b:toMin(end)}, ops:{}, orders:0, units:0, hourW:new Array(24).fill(0), planned:[], absent:[], pending:[]}); };
    const perf=(g, evs)=>{ const r=g.r, sorted=[...evs].sort((x,y)=>x[0]-y[0]), inS=sorted.filter(([m])=>inR(r,m));
      if(!inS.length) return null;
      const k={checkin:0, map:0, checkout:0}; inS.forEach(([m,t])=>{ const kind=d.PERF_KIND[t]; if(kind){ k[kind]++; g.hourW[Math.floor(m/60)]+=d.PERF_WEIGHT[kind]; } });
      const first=inS[0][0], last=inS[inS.length-1][0];
      let idleCount=0, idleMin=0; for(let j=1;j<inS.length;j++){ const gap=inS[j][0]-inS[j-1][0]; if(gap>IDLE_GAP_MIN){ idleCount++; idleMin+=gap; } }
      const endMin=r.b>=r.a? r.b : r.b+1440;
      return {...k, weighted:k.checkout*d.PERF_WEIGHT.checkout+k.checkin*d.PERF_WEIGHT.checkin+k.map*d.PERF_WEIGHT.map, events:inS.length,
        outside:sorted.length-inS.length, first, last, activeMin:last-first, idleCount, idleMin, lateMin:Math.max(0, first-r.a), earlyMin:Math.max(0, endMin-last)}; };
    const evsBy=a.ev||{};
    if(plan){
      Object.entries(plan).forEach(([name,p])=>{ if(p.off) return;
        const g=group(p.start,p.end); g.planned.push(name);
        const evs=evsBy[name], o=evs && perf(g, evs);
        if(o) g.ops[name]=o;
        else if(evs){ const ms=evs.map(e=>e[0]); unplanned.push({operator:name, reason:'skanime vetëm jashtë orarit '+p.start+'–'+p.end, events:evs.length, first:hhmm(Math.min(...ms)), last:hhmm(Math.max(...ms))}); }
        else if(nowMin!=null && nowMin<g.r.a+LATE_MIN) g.pending.push(name);        // today, shift not started yet
        else g.absent.push(name); });
      Object.entries(evsBy).forEach(([name,evs])=>{ const p=plan[name]; if(p && !p.off) return;
        const ms=evs.map(e=>e[0]); unplanned.push({operator:name, reason:p? 'OFF sipas orarit' : 'jo në orar', events:evs.length, first:hhmm(Math.min(...ms)), last:hhmm(Math.max(...ms))}); });
    } else {
      const pool=shifts.filter(s=>!!s.weekend===we).map(s=>({s, a:toMin(s.start), b:toMin(s.end)}));
      Object.entries(evsBy).forEach(([name, evs])=>{
        const score=pool.map(r=>evs.filter(([m])=>inR(r,m) && pool.filter(o=>inR(o,m)).length===1).length);
        let i=score.length? score.indexOf(Math.max(...score)) : -1;
        if(i<0 || score[i]===0) i=pool.findIndex(r=>evs.some(([m])=>inR(r,m)));
        if(i<0) return;
        const g=group(pool[i].s.start, pool[i].s.end), o=perf(g, evs); if(o) g.ops[name]=o; });
    }
    Object.values(res).forEach(g=>{ g.orders=a.coOrders.filter(([,m])=>inR(g.r,m)).length; g.units=a.coUnits.reduce((s,v,h)=>s+(inR(g.r,h*60)?v:0),0); });
    return {groups:res, unplanned, planned:!!plan};
  }
  function weekOf(iso){ const dt=new Date(iso+'T12:00:00'); const mon=d.isoAddDays(iso, -((dt.getDay()+6)%7)); return Array.from({length:7},(_,i)=>d.isoAddDays(mon,i)); }
  async function shifts(date, mode){
    const today=d.isoToday();
    const days=(mode==='week'? weekOf(date) : [date]).filter(x=>x<=today);
    const db=d.loadDb()||{}; const defs=(db.wmsShifts||[]).filter(s=>s.active!==false);
    if(!defs.length) return {error:'S\'ka ndërrime aktive te WMS → Shifts.'};
    let reliable=true; const perDay={}, absences=[], unplanned=[], planDays=[];
    for(const iso of days){ const a=await getDay(iso); if(a.error) return {error:a.error}; if(!a.reliable) reliable=false;
      const plan=d.scheduleForDay? d.scheduleForDay(iso) : null; if(plan) planDays.push(iso);
      const now=new Date(), sd=shiftDay(a, iso, defs, plan, iso===today? now.getHours()*60+now.getMinutes() : null); perDay[iso]=sd.groups;
      sd.unplanned.forEach(u=>unplanned.push(Object.assign({date:iso},u)));
      Object.values(sd.groups).forEach(g=>g.absent.forEach(n=>absences.push({date:iso, operator:n, shift:g.name, hours:g.start+'–'+g.end}))); }
    const labels=[]; days.forEach(iso=>Object.values(perDay[iso]).forEach(g=>{ if(!labels.find(l=>l.name===g.name)) labels.push({name:g.name, start:g.start, end:g.end, weekend:g.weekend}); }));
    labels.sort((x,y)=> (x.weekend-y.weekend) || toMin(x.start)-toMin(y.start) || toMin(x.end)-toMin(y.end));
    const out=labels.map(s=>{
      const ops={}, byDay=[], hourW=new Array(24).fill(0); let orders=0, units=0, nDays=0, planned=0, absent=0;
      days.forEach(iso=>{ const x=perDay[iso][s.name]; if(!x) return; nDays++; planned+=x.planned.length; absent+=x.absent.length;
        orders+=x.orders; units+=x.units; x.hourW.forEach((v,h)=>hourW[h]+=v);
        const names=Object.keys(x.ops);
        byDay.push({date:iso, operators:names.length, planned:x.planned.length, absent:x.absent.length, weighted:r1(names.reduce((t,n)=>t+x.ops[n].weighted,0)), orders:x.orders, units:x.units});
        names.forEach(n=>{ const o=x.ops[n], A=ops[n]||(ops[n]={operator:n, days:0, checkin:0, map:0, checkout:0, weighted:0, events:0, outside:0, firstSum:0, lastSum:0, activeMin:0, idleCount:0, idleMin:0, lateDays:0, earlyDays:0, lateMinSum:0});
          A.days++; ['checkin','map','checkout','weighted','events','outside','activeMin','idleCount','idleMin'].forEach(f=>A[f]+=o[f]);
          A.firstSum+=o.first; A.lastSum+=o.last; A.lateMinSum+=o.lateMin; if(o.lateMin>LATE_MIN) A.lateDays++; if(o.earlyMin>EARLY_MIN) A.earlyDays++; }); });
      const operators=Object.values(ops).map(A=>({operator:A.operator, days:A.days, checkin:A.checkin, map:A.map, checkout:A.checkout, weighted:r1(A.weighted),
        perDay:r1(A.weighted/A.days), perActiveHour:A.activeMin>0? r1(A.weighted/(A.activeMin/60)) : null, events:A.events, outside:A.outside,
        avgFirst:hhmm(A.firstSum/A.days), avgLast:hhmm(A.lastSum/A.days), avgLateMin:Math.round(A.lateMinSum/A.days), lateDays:A.lateDays, earlyDays:A.earlyDays,
        idleCount:A.idleCount, idleMin:A.idleMin})).sort((a,b)=>b.weighted-a.weighted);
      const tw=operators.reduce((t,o)=>t+o.weighted,0), opDays=operators.reduce((t,o)=>t+o.days,0);
      return {name:s.name, start:s.start, end:s.end, weekend:!!s.weekend, daysCovered:nDays, operators,
        team:{ operators:operators.length, operatorDays:opDays, plannedDays:planned, absentDays:absent, checkin:operators.reduce((t,o)=>t+o.checkin,0), map:operators.reduce((t,o)=>t+o.map,0),
          checkout:operators.reduce((t,o)=>t+o.checkout,0), weighted:r1(tw), perOperatorDay:opDays? r1(tw/opDays) : null, orders, units,
          lateStarts:operators.reduce((t,o)=>t+o.lateDays,0), earlyEnds:operators.reduce((t,o)=>t+o.earlyDays,0), idleMin:operators.reduce((t,o)=>t+o.idleMin,0),
          topShare: tw>0 && operators.length? Math.round(operators[0].weighted/tw*100) : null, topOperator: operators.length? operators[0].operator : null },
        byDay, hourly: nDays? hourW.map((v,h)=>({hour:h, weightedPerDay:r1(v/nDays)})).filter(x=>x.weightedPerDay) : [] };
    });
    return {mode, from:days[0], to:days[days.length-1], days, shifts:out, reliable, refreshedAt:new Date().toISOString(),
      schedule:{ planDays, missingDays:days.filter(x=>!planDays.includes(x)) }, absences, unplanned,
      rules:{idleGapMin:IDLE_GAP_MIN, lateMin:LATE_MIN, earlyMin:EARLY_MIN}};
  }
  return {live, shifts};
};
