/* =========================================================================
   RAPORTI I NDËRRIMIT — Raportet → tab "Raporti i ndërrimit" (the lead's template, 12.10.2026).
   Two reports per weekday: N1 and N2; on Saturday and Sunday one: Weekend (09:00–18:00). Each line of the template is an editable field; where the data has it, the field is
   filled in automatically, otherwise it is written by hand. Saving freezes the automatic figures, so the report of a day
   does not change later; "Rifresko nga të dhënat" re-reads them and replaces only the fields still as they were filled.
   Split by shift = by PEOPLE: each operator belongs to the shift of their schedule that day (starting before 12:00 → N1,
   otherwise N2); someone who worked without being on the schedule goes by their first scan. Day totals are labelled.
   Sources (all already in the app; nothing new is read from the WMS):
     /tabela/data?date=   per operator that day: orders checked out, check-in, mapping, POD, refusals; the day's
                          schedule; the board's cut-offs (backlog — only for today: the system keeps no history of it)
     /stats/live?date=    the daily orders target (Statistikat e WH settings)
     /pulse/data          orders created per day (D.daily: last 15 days; capacity.created: full weeks)
     Store                wmsPrepared (prepared orders per operator × day), observations, unlinkedReturns, processes
   Stored in the shared database: collection "shiftReports", one per date + shift (id "shr-<date>-<N1|N2>"), every change in the audit log.
   Automatic save by the agent (wms-agent.js, same srAuto): N1 at 15:03, N2 at 21:03 (Monday–Friday), Weekend at 18:03 (Sat/Sun) — creates the report or, if the lead
   already saved it, refreshes only the fields not touched by hand (srApplyAuto). This is also how the backlog of the day is kept.
   =======================================================================*/
let srDate=null, srShift='N1', srData={}, srSeq=0, srBox=null, srOnAgent=false, srFresh=null;
const SR_SECTIONS=[
  ['1. Plani dhe realizimi', [['target','Objektivi ditor i porosive'],['completed','Porositë e përfunduara'],['packed','Porositë e paketuara'],['sent','Porositë e dërguara'],['received','Porositë e pranuara gjatë ditës'],['backlogStart','Backlog në fillim'],['backlogEnd','Backlog në fund']]],
  ['2. Personeli', [['planned','Punëtorë të planifikuar'],['present','Punëtorë të pranishëm'],['absent','Mungesa / vonesa'],['realHours','Orë reale të punës'],['overtime','Orë shtesë'],['taskChanges','Ndërprerje ose ndërrime detyrash']]],
  ['3. Gabimet dhe cilësia', [['errPick','Gabime në picking'],['errPack','Gabime në packing'],['errCheckin','Gabime në check-in / inventar'],['rework','Porosi të ripërpunuara'],['damaged','Mallra të dëmtuara ose të munguara']]],
  ['4. Vonesat dhe pengesat', [['delayProcess','Procesi i prekur'],['delayDesc','Përshkrimi i problemit'],['delayDuration','Kohëzgjatja'],['delayImpact','Ndikimi në operacion'],['delayCause','Shkaku i konfirmuar ose ende i panjohur'],['delayAction','Masa e ndërmarrë']]],
  ['5. Siguria', [['incidents','Incidente'],['nearMiss','Near miss'],['risks','Rreziqe të identifikuara'],['immediate','Masa të menjëhershme'],['openIssues','Çështje ende të hapura']]],
  ['6. Veprimet dhe vendimet', [['solved','Problemet e zgjidhura'],['unsolved','Problemet e pazgjidhura'],['nextDay','Veprimet për ditën e ardhshme'],['decisions','Vendimet që kërkojnë miratim nga menaxhmenti']]],
  ['7. Vërejtje shtesë', [['wentWell','Çfarë funksionoi mirë'],['wentBad','Çfarë nuk funksionoi'],['other','Informacion tjetër relevant']]]];
const SR_LONG=new Set(['delayDesc','delayImpact','delayCause','delayAction','incidents','nearMiss','risks','immediate','openIssues','solved','unsolved','nextDay','decisions','wentWell','wentBad','other','damaged','rework','taskChanges','absent','planned','present']);
const SR_WIN={N1:['07:00','15:00'], N2:['13:00','21:00'], Weekend:['09:00','18:00']};   // for observations and returns: by time of day (13–15 is in both N1 and N2)
/* the shifts of the report: N1 / N2 on weekdays; Weekend (Saturday and Sunday, usually 09:00–18:00) is ONE shift with
   everyone who worked that day. All three can be chosen on any date; the default follows the day of the week. */
const SR_SHIFTS=['N1','N2','Weekend'];
const srIsWeekend=d=>{ const w=new Date(d+'T12:00:00').getDay(); return w===0 || w===6; };
const srDefaultShift=(d,cur)=> srIsWeekend(d)? 'Weekend' : (cur==='Weekend'? 'N1' : cur);
const srId=(d,s)=>'shr-'+d+'-'+s;
/* one report per date + shift, found by date + shift. A deleted id keeps its tombstone forever (Store.mergeFrom), so a
   report re-created after a delete gets a new id — with the same id it would vanish at the next sync. */
const srFind=(d,s)=>Store.col('shiftReports').find(r=>r.date===d && r.shift===s);
const srNewId=(d,s)=>{ const id=srId(d,s); return (Store.db.deleted||{})['shiftReports|id|'+id]? id+'-'+Date.now().toString(36) : id; };
const srHm=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
const srMin=t=>{ const m=/^(\d{1,2}):(\d{2})/.exec(String(t||'')); return m? +m[1]*60+ +m[2] : null; };
const srShiftOf=txt=>{ const s=srMin(txt); return s==null? null : s<12*60? 'N1' : 'N2'; };

function rapShiftReport(box, onAgent){
  if(!srDate){ srDate=todayStr(); srShift=srDefaultShift(srDate,srShift); } srBox=box; srOnAgent=onAgent;
  const rec=srFind(srDate,srShift), others=SR_SHIFTS.filter(s=>s!==srShift && srFind(srDate,s));
  box.innerHTML=`<style>.sr-print{display:none} @media print{ .sr-form,.pagehead,#rapTabs{display:none !important} .sr-print{display:block !important} .sr-print td{border-bottom:1px solid #ccc;padding:3px 4px} }</style>
    <div class="card no-print" style="margin-bottom:12px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label class="small" style="display:flex;gap:6px;align-items:center">Data <input type="date" id="srDate" value="${h(srDate)}" max="${h(todayStr())}" style="width:auto;min-height:34px"></label>
      <button class="btn sm" id="srToday">Sot</button>
      <span style="display:inline-flex;gap:6px;margin-left:8px">${SR_SHIFTS.map(s=>{ const r=srFind(srDate,s);
        return `<button class="btn sm ${srShift===s?'primary':''}" data-srs="${s}">${s} ${r? '<span title="i ruajtur">✓</span>' : '<span class="faint" title="ende i paruajtur">·</span>'}</button>`; }).join('')}</span>
      <span class="small faint" id="srStatus" style="margin-left:auto">${rec? 'Ruajtur '+h(new Date(rec.updatedAt).toLocaleString())+' · '+h(rec.updatedBy||'') : 'I paruajtur'} ${others.length? '· '+others.join(', ')+' ✓' : ''}</span></div></div>
    <div id="srBody"><div class="empty">Po lexohen të dhënat e ${h(fmtDateAl(srDate))}…</div></div>
    <div class="card no-print" style="margin-top:12px"><h3 style="margin-top:0">Raportet e ruajtura</h3>${srList()}</div>`;
  $$('[data-sropen]').forEach(a=>a.onclick=e=>{ e.preventDefault(); const [d,s]=a.dataset.sropen.split('|'); srDate=d; srShift=s; rapShiftReport(box,onAgent); window.scrollTo(0,0); });
  $('#srDate').onchange=e=>{ srDate= e.target.value && e.target.value<=todayStr()? e.target.value : todayStr(); srShift=srDefaultShift(srDate,srShift); rapShiftReport(box,onAgent); };
  $('#srToday').onclick=()=>{ srDate=todayStr(); srShift=srDefaultShift(srDate,srShift); rapShiftReport(box,onAgent); };
  $$('[data-srs]').forEach(b=>b.onclick=()=>{ srShift=b.dataset.srs; rapShiftReport(box,onAgent); });
  if(rec) return srDraw(rec, null);
  if(!onAgent){ srDraw(null, {note:'Hape app-in nga http://localhost:8790 që të plotësohen shifrat automatike.'}); return; }
  const sh=srShift; srLoad(srDate).then(D=>{ if(D.date!==srDate || sh!==srShift || srFind(srDate,srShift)) return; srDraw(null, srAuto(D, srShift)); });
}
function srList(){
  const rows=Store.col('shiftReports').slice().sort((a,b)=>(b.date+b.shift).localeCompare(a.date+a.shift));
  if(!rows.length) return '<div class="empty">Ende asnjë raport i ruajtur.</div>';
  const n=(r,k)=>{ const m=/^(\d+)/.exec(r[k]||''); return m? +m[1] : '—'; };
  return `<div class="tablewrap"><table><thead><tr><th>Data</th><th>Ndërrimi</th><th>Përgjegjësi</th><th>Të përfunduara</th><th>Të dërguara</th><th>Të pranishëm</th><th>Ruajtur</th></tr></thead><tbody>${rows.map(r=>`<tr>
    <td data-sort="${h(r.date)}"><a href="#" data-sropen="${h(r.date+'|'+r.shift)}">${h(fmtDateAl(r.date))}</a></td><td>${h(r.shift)}</td><td>${h(r.responsible||'—')}</td>
    <td>${n(r,'completed')}</td><td>${n(r,'sent')}</td><td>${n(r,'present')}</td><td class="small faint" data-sort="${h(r.updatedAt||'')}">${h(new Date(r.updatedAt).toLocaleString())}${r.updatedBy? ' · '+h(r.updatedBy) : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
/* reads the day once per date (cached in memory for this page) */
async function srLoad(date){
  if(srData[date] && !srData[date].loading && (date<todayStr() || Date.now()-srData[date].at<120000)) return srData[date];
  const seq=++srSeq, get=u=>fetch(u,{cache:'no-store'}).then(r=>r.json()).catch(e=>({error:e.message}));
  const [T, ST, P]=await Promise.all([get('/tabela/data?date='+date), get('/stats/live?date='+date), get('/pulse/data')]);
  const D={date, T, ST, P, at:Date.now()}; if(seq===srSeq || !srData[date]) srData[date]=D; return D;
}
/* the automatic part for one shift: values (numbers and lists) + the text each field is filled with.
   Runs in the browser (db = Store) and in the agent (db = the shared database, D.today = the agent's date) — one logic for both. */
function srAuto(D, shift, db){
  const col=n=> db? (db[n]||[]) : Store.col(n), num=v=>{ const x=parseFloat(v); return isNaN(x)? 0 : x; };
  const out={v:{}, txt:{}, src:{}, warn:[]}, T=D.T&&!D.T.error? D.T : null, date=D.date, today=date===(D.today||todayStr());
  if(!T) out.warn.push('Tabela ditore nuk u lexua'+(D.T&&D.T.error? ' ('+D.T.error+')' : '')+' — shifrat e personave mungojnë.');
  const shifts=(T&&T.shifts)||{}, ops=(T&&T.live&&T.live.ops)||[], byName={}; ops.forEach(o=>byName[o.name]=o);
  const act=o=>o? (o.orders||0)+(o.out||0)+(o.ci||0)+(o.mp||0)+(o.pod||0)+(o.ref||0)+(o.ret||0) : 0;
  const local=iso=>{ const d=new Date(iso); return d.getHours()*60+d.getMinutes(); };
  // members of the shift: scheduled in it; plus those who worked without a shift that day, by their first scan
  const wk=shift==='Weekend', inShift=s=>s!=='pushim' && (wk || srShiftOf(s)===shift);   // Weekend = everyone on the schedule that day
  const planned=Object.entries(shifts).filter(([n,s])=>inShift(s)).map(([n])=>n).sort();
  const off=Object.entries(shifts).filter(([n,s])=>s==='pushim').map(([n])=>n);
  const unsched=ops.filter(o=>act(o)>0 && !(o.name in shifts && shifts[o.name]!=='pushim') && (wk || ((local(o.first)<12*60)? 'N1':'N2')===shift)).map(o=>o.name);
  const members=[...new Set(planned.concat(unsched))], present=members.filter(n=>act(byName[n])>0), absent=planned.filter(n=>!(act(byName[n])>0));
  const S=k=>members.reduce((a,n)=>a+((byName[n]||{})[k]||0),0);
  // 1. plan and result
  const target=D.ST&&D.ST.config&&D.ST.config.targetOrdersPerDay;
  const prepared=col('wmsPrepared').filter(r=>r.date===date && members.includes(r.operator)).reduce((a,r)=>a+num(r.preparedOrders),0), prepAny=col('wmsPrepared').some(r=>r.date===date);
  const dm=date.slice(8,10)+'.'+date.slice(5,7), dd=D.P&&D.P.D&&(D.P.D.daily||[]).find(r=>r[0]===dm), cr=D.P&&D.P.capacity&&(D.P.capacity.created||[]).find(x=>x.d===date);
  const received= dd? dd[1]+dd[2] : cr? cr.o : null;
  out.v={target, completed:S('orders'), dayOut:T&&T.live? T.live.ordersOut : null, packed:prepAny? prepared : null, sent:S('pod'), daySent:T&&T.live&&T.live.pod? T.live.pod.total : null, refusals:S('ref'), received,
    planned, present, absent, off, unsched};
  out.txt.target= target? target+' (objektivi i ditës)' : ''; out.src.target='Statistikat e WH → cilësimet';
  out.txt.completed= T? `${out.v.completed} porosi nga operatorët e ${shift} · dita gjithsej ${out.v.dayOut??'—'}` : ''; out.src.completed='WMS: porosi të ndryshme me check-out, sipas operatorëve të ndërrimit';
  out.txt.packed= prepAny? `${prepared} (WMS "Prepared", operatorët e ${shift})` : ''; out.src.packed= prepAny? 'WMS GetPreparedOrders — WMS nuk ka hap të veçantë paketimi' : 'WMS "Prepared" nuk është sinkronizuar për këtë datë — plotëso me dorë';
  out.txt.sent= T? `${out.v.sent} porosi të skanuara për kurierët nga ${shift} · dita gjithsej ${out.v.daySent??'—'}${out.v.refusals? ' · refuzime të pranuara '+out.v.refusals : ''}` : ''; out.src.sent='Delivery Platform: POD (Scanned Orders) sipas llogarisë';
  out.txt.received= received!=null? received+' (dita gjithsej)' : ''; out.src.received= received!=null? 'WMS: porosi të krijuara (WMS Pulse)' : 'nuk ka shifër për këtë datë — plotëso me dorë';
  /* backlog: the board's cut-offs exist only for today (the system keeps no history), so the figure is the state at the
     moment the report is filled — the agent saves N1 at 15:03 and N2 at 21:03, which keeps it for that day.
     N1 start = ready yesterday by 17:30 and not out · N1 end = ready by 15:00 still open · N2 start = N1's end (as saved
     at 15:03; otherwise the 15:00 cut-off now) · N2 end = ready by 17:30 still open · Weekend: start as N1, end as N2. */
  const cut=T&&T.cut, at=cut&&cut.gen? ' — tabela M e orës '+String(cut.gen).slice(11,16) : '', cutOf=l=>((cut&&cut.cuts)||[]).find(c=>c.label===l);
  if(today && cut&&cut.available){ const c15=cutOf('15:00'), c17=cutOf('17:30');
    if(shift==='N1' || wk){ out.v.backlogStart=cut.carry.carry; out.txt.backlogStart=`${cut.carry.carry} porosi të gatshme dje deri 17:30 pa dalë (carryover ${cut.carry.pct}%)`;
      const ce= wk? c17 : c15; if(ce){ out.v.backlogEnd=ce.open; out.txt.backlogEnd=`${ce.open} porosi të gatshme deri ${ce.label} ende të hapura${at}`; } }
    else { const n1=col('shiftReports').find(r=>r.date===date && r.shift==='N1'), n1v=n1&&n1.auto&&n1.auto.v&&n1.auto.v.backlogEnd;
      if(n1v!=null){ out.v.backlogStart=n1v; out.txt.backlogStart=`${n1v} porosi të gatshme deri 15:00 ende të hapura (sipas raportit N1)`; }
      else if(c15){ out.v.backlogStart=c15.open; out.txt.backlogStart=`${c15.open} porosi të gatshme deri 15:00 ende të hapura${at}`; }
      if(c17){ out.v.backlogEnd=c17.open; out.txt.backlogEnd=`${c17.open} porosi të gatshme deri 17:30 ende të hapura${at}`; } } }
  out.src.backlogStart=out.src.backlogEnd= today? 'Tabela ditore (cut-off-et), gjendja në momentin e plotësimit' : 'për ditët e kaluara sistemi nuk e ruan — plotëso me dorë (ose ruhet nga agjenti: N1 15:03, N2 21:03, Weekend 18:03)';
  // 2. staff
  const sh=n=>shifts[n]&&shifts[n]!=='pushim'? ' ('+shifts[n]+')' : ' (jashtë orarit)';
  out.txt.planned= planned.length? `${planned.length}: ${planned.map(n=>n+' '+shifts[n]).join(', ')}` : (T&&T.scheduleLoaded===false? '' : '0'); out.src.planned='Orari i punës';
  out.txt.present= T? `${present.length}: ${present.join(', ')}${unsched.length? ' · pa qenë në orar: '+unsched.join(', ') : ''}` : ''; out.src.present='kush ka skanuar në WMS ose Delivery Platform atë ditë';
  out.txt.absent= absent.length? `Pa aktivitet në WMS/POD: ${absent.join(', ')} (mungesë, vonesë ose punë pa skanim — verifiko)` : (T? 'Asnjë' : ''); out.src.absent='në orar, por pa asnjë skanim atë ditë';
  const multi=present.filter(n=>{ const o=byName[n]||{}; return ['orders','ci','mp','pod','ref'].filter(k=>(o[k]||0)>0).length>=2; });
  const PN={orders:'check-out',ci:'check-in',mp:'mapim',pod:'POD',ref:'refuzime'};
  out.txt.taskChanges= multi.length? 'Punuan në disa procese: '+multi.map(n=>{ const o=byName[n]; return n+' ('+Object.keys(PN).filter(k=>(o[k]||0)>0).map(k=>PN[k]).join(', ')+')'; }).join('; ') : ''; out.src.taskChanges='WMS / Delivery Platform: proceset ku ka skanuar secili';
  // 3–5 from observations and returns of that date, in the shift's hours
  const [a,b]=SR_WIN[shift].map(srMin), inWin=t=>{ const m=srMin(t); return m==null || (m>=a && m<b); };
  const procName=id=>{ const p=col('processes').find(x=>x.id===id); return p? p.name : ''; };
  const obs=col('observations').filter(o=>o.date===date && inWin(o.time)).sort((x,y)=>String(x.time||'').localeCompare(String(y.time||'')));
  const line=o=>`${o.time||'—'} · ${procName(o.processId)||o.type} · ${o.what||o.actual||''}${o.impact? ' → '+o.impact : ''}`.replace(/\s+/g,' ').trim();
  const errs=obs.filter(o=>o.error==='Yes'||o.error===true), rew=obs.filter(o=>o.rework==='Yes'||o.rework===true);
  const delays=obs.filter(o=>/bottleneck|delay|waiting|deviation|interrupt/i.test(o.type||'') || o.interruption==='Yes');
  const safety=obs.filter(o=>/safety|siguri/i.test(o.type||''));
  if(errs.length) out.txt.errCheckin='Nga vëzhgimet:\n'+errs.map(o=>'- '+line(o)+(o.errorDetail? ' ('+o.errorDetail+')' : '')).join('\n');
  if(rew.length) out.txt.rework=rew.map(o=>'- '+line(o)+(o.reworkDetail? ' ('+o.reworkDetail+')' : '')).join('\n');
  if(delays.length){ out.txt.delayProcess=[...new Set(delays.map(o=>procName(o.processId)||o.type))].join(', ');
    out.txt.delayDesc=delays.map(o=>'- '+line(o)).join('\n');
    const imp=delays.filter(o=>o.impact).map(o=>'- '+o.impact); if(imp.length) out.txt.delayImpact=imp.join('\n');
    const cau=delays.filter(o=>o.cause).map(o=>'- '+o.cause+(o.validationStatus==='Validated'? ' (e konfirmuar)' : ' (hipotezë)')); if(cau.length) out.txt.delayCause=cau.join('\n');
    const mins=delays.reduce((s,o)=>s+(+o.waitingMin||0),0); if(mins) out.txt.delayDuration=mins+' min pritje gjithsej (sipas vëzhgimeve)'; }
  if(safety.length) out.txt.incidents=safety.map(o=>'- '+line(o)).join('\n');
  const ur=col('unlinkedReturns').filter(r=>r.date===date && inWin(r.time) && /dëmtuar|hapur/i.test(r.condition||''));
  if(ur.length) out.txt.damaged=ur.map(r=>`- ${r.time||''} ${r.productCode||r.tracking||''} — ${r.condition}${r.notes? ' · '+r.notes : ''}`.trim()).join('\n');
  ['errCheckin','rework','delayProcess','delayDesc','delayImpact','delayCause','delayDuration'].forEach(k=>out.src[k]=out.src[k]||'Daily Observation të datës, në orët e '+shift);
  out.src.incidents='Daily Observation të llojit Safety'; out.src.damaged='Kthime pa lidhje (E dëmtuar / E hapur)';
  out.v.obs=obs.length; out.v.returns=ur.length;
  const day=Object.entries(shifts).filter(([n,s])=>inShift(s)).map(([,s])=>s), cnt={}; day.forEach(s=>cnt[s]=(cnt[s]||0)+1);
  out.txt.schedule=Object.entries(cnt).sort().map(([s,n])=>s+' ('+n+')').join(' · ');
  return out;
}
/* the agent's automatic save (N1 15:03, N2 21:03): a new report gets the automatic text; in a report already saved by hand
   everything typed stays — only fields still equal to the previous automatic text are replaced. Returns the changes. */
function srApplyAuto(rec, A){
  const prev=(rec.auto&&rec.auto.txt)||{}, keys=SR_SECTIONS.flatMap(s=>s[1].map(x=>x[0])).concat(['schedule']), changes=[];
  keys.forEach(k=>{ const cur=rec[k]==null? '' : String(rec[k]), nv=(A.txt&&A.txt[k])||'';
    if(cur===(prev[k]||'') && cur!==nv){ changes.push({field:k, from:cur, to:nv}); rec[k]=nv; } });
  rec.auto={v:A.v||{}, src:A.src||{}, txt:A.txt||{}};
  return changes;
}
function srDraw(rec, A){
  const box=$('#srBody'); if(!box) return;
  srFresh=null; const auto= rec? rec.auto||{txt:{},src:{},v:{}} : A||{txt:{},src:{},v:{},warn:[]};
  const val=k=> rec? (rec[k]??'') : (auto.txt&&auto.txt[k]) || '';
  const resp= rec? rec.responsible||'' : '', sched= rec? rec.schedule||'' : (auto.txt&&auto.txt.schedule)||'';
  const staff=[...new Set(Object.keys(((srData[srDate]||{}).T||{}).shifts||{}).concat(Store.col('employees').filter(e=>e.active!==false).map(e=>e.name)))].sort();
  const fieldRow=(k,l)=>{ const long=SR_LONG.has(k), v=val(k), src=auto.src&&auto.src[k], isAuto= v && auto.txt && auto.txt[k] && auto.txt[k]===v;
    return `<div style="display:grid;grid-template-columns:minmax(150px,240px) 1fr;gap:8px;align-items:start;padding:5px 0;border-bottom:1px dashed var(--line)">
      <label for="sr_${k}" class="small" style="padding-top:6px"><b>${h(l)}</b>${src? `<div class="faint" style="font-size:11px">${isAuto? '⚙ ' : ''}${h(src)}</div>` : ''}</label>
      ${long? `<textarea id="sr_${k}" data-srk="${k}" rows="${Math.min(6,Math.max(2,String(v).split('\n').length))}" style="width:100%">${h(v)}</textarea>` : `<input id="sr_${k}" data-srk="${k}" value="${h(v)}" style="width:100%;min-height:34px">`}</div>`; };
  const printRow=(k,l)=>{ const v=val(k); return `<tr><td style="width:34%;vertical-align:top"><b>${h(l)}</b></td><td style="white-space:pre-wrap">${h(v||'—')}</td></tr>`; };
  const head=`RAPORTI DITOR — WAREHOUSE & FULFILLMENT`;
  box.innerHTML=`${(auto.warn||[]).length? `<div class="hint no-print" style="color:var(--warn);margin-bottom:8px">${auto.warn.map(h).join('<br>')}</div>` : ''}${auto.note? `<div class="hint no-print" style="margin-bottom:8px">${h(auto.note)}</div>` : ''}
    <div class="card sr-form">
      <h3 style="margin-top:0">${head}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:8px">
        <label class="small"><b>Data</b><input value="${h(fmtDateAl(srDate))}" disabled style="min-height:34px"></label>
        <label class="small"><b>Ndërrimi</b><input value="${h(srShift)}" disabled style="min-height:34px"></label>
        <label class="small"><b>Përgjegjësi</b><input id="sr_responsible" list="srStaff" value="${h(resp)}" placeholder="shefi i ndërrimit" style="min-height:34px"><datalist id="srStaff">${staff.map(n=>`<option value="${h(n)}"></option>`).join('')}</datalist></label>
        <label class="small"><b>Orari i punës</b><input id="sr_schedule" value="${h(sched)}" style="min-height:34px"></label></div>
      ${SR_SECTIONS.map(([t,fields])=>`<h3 style="margin:14px 0 4px">${h(t)}</h3>${fields.map(([k,l])=>fieldRow(k,l)).join('')}`).join('')}
      <div class="btnrow no-print" style="margin-top:12px"><button class="btn primary" id="srSave">💾 Ruaj raportin ${h(srShift)}</button>
        <button class="btn" id="srRefresh" title="Lexon sërish shifrat; ndryshon vetëm fushat që nuk i ke prekur">⟳ Rifresko nga të dhënat</button>
        ${rec? '<button class="btn ghost" id="srDelete">🗑 Fshi</button>' : ''}<button class="btn ghost" id="srPrint">🖨 Printo</button></div>
      <div class="hint">⚙ = plotësuar automatikisht nga burimi i shënuar; çdo fushë mund të ndryshohet. Ndarja sipas ndërrimit bëhet sipas personave të secilit ndërrim (orari i asaj dite); totalet e ditës shënohen veç. Ruajtja i ngrin shifrat; "Rifresko" ndryshon vetëm fushat që janë ende si u plotësuan.</div></div>
    <div class="sr-print"><h2 style="margin:0 0 4px">${head}</h2>
      <table style="width:100%;font-size:12px;margin-bottom:8px"><tr><td><b>Data:</b> ${h(fmtDateAl(srDate))}</td><td><b>Ndërrimi:</b> ${h(srShift)}</td><td><b>Përgjegjësi:</b> <span id="srPResp">${h(resp||'—')}</span></td><td><b>Orari i punës:</b> <span id="srPSched">${h(sched||'—')}</span></td></tr></table>
      ${SR_SECTIONS.map(([t,fields])=>`<h3 style="margin:10px 0 4px">${h(t)}</h3><table style="width:100%;font-size:12px;border-collapse:collapse">${fields.map(([k,l])=>printRow(k,l)).join('')}</table>`).join('')}
      <div class="small faint" style="margin-top:8px">${rec? 'Ruajtur '+h(new Date(rec.updatedAt).toLocaleString())+(rec.updatedBy? ' · '+h(rec.updatedBy) : '') : 'Draft i paruajtur'} · Warehouse Observation App</div></div>`;
  // the print view follows what is typed
  $$('[data-srk]').forEach(el=>el.oninput=()=>{ const k=el.dataset.srk, row=[...$$('.sr-print td b')].find(b=>b.textContent===((SR_SECTIONS.flatMap(s=>s[1]).find(x=>x[0]===k)||[])[1])); if(row) row.closest('tr').cells[1].textContent=el.value||'—'; });
  $('#sr_responsible').oninput=e=>$('#srPResp').textContent=e.target.value||'—'; $('#sr_schedule').oninput=e=>$('#srPSched').textContent=e.target.value||'—';
  $('#srPrint').onclick=()=>window.print();
  $('#srSave').onclick=()=>srSave(rec, auto);
  $('#srRefresh').onclick=async()=>{ const btn=$('#srRefresh'); btn.disabled=true; btn.textContent='⏳ Po lexohen…'; delete srData[srDate];
    const D=await srLoad(srDate), N=srAuto(D, srShift); let changed=0;
    $$('[data-srk]').forEach(el=>{ const k=el.dataset.srk, prev=((srFresh||auto).txt||{})[k];
      if((el.value===(prev||'')) && (N.txt[k]||'')!==el.value){ el.value=N.txt[k]||''; changed++; } });
    const sc=$('#sr_schedule'); if(sc && (!sc.value || sc.value===((srFresh||auto).txt||{}).schedule)) sc.value=N.txt.schedule||'';
    $$('[data-srk]').forEach(el=>el.oninput&&el.oninput()); if(sc) sc.oninput({target:sc});
    srFresh=N;
    btn.disabled=false; btn.textContent='⟳ Rifresko nga të dhënat'; toast(changed? changed+' fusha u rifreskuan (të tjerat i ke ndryshuar ti)' : 'Asgjë për të rifreskuar'); };
  const del=$('#srDelete'); if(del) del.onclick=()=>confirmDelete('raportin '+srShift+' të '+fmtDateAl(srDate), ()=>{ Store.remove('shiftReports', rec.id); toast('Raporti u fshi'); rapShiftReport(srBox, srOnAgent); });
}
function srSave(rec, auto){
  const f={}; $$('[data-srk]').forEach(el=>f[el.dataset.srk]=el.value.trim());
  /* each field is its own property, so the audit log shows field by field what changed; auto = the figures as read when saved */
  const A=srFresh||auto;
  const data=Object.assign({date:srDate, shift:srShift, responsible:($('#sr_responsible').value||'').trim(), schedule:($('#sr_schedule').value||'').trim(),
    auto:{v:A.v||{}, src:A.src||{}, txt:A.txt||{}}}, f);
  if(rec) Store.update('shiftReports', rec.id, data); else Store.insert('shiftReports', Object.assign({id:srNewId(srDate,srShift)}, data));
  toast('Raporti '+srShift+' i '+fmtDateAl(srDate)+' u ruajt');
  rapShiftReport(srBox, srOnAgent);
}
if(typeof module!=='undefined' && module.exports) module.exports={srAuto, srApplyAuto, srId, SR_SECTIONS, srIsWeekend};   // used by wms-agent.js (automatic save)
