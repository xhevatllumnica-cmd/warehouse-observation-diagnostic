/* ============================================================================
   Warehouse Observation & Diagnostic System
   Single-page, offline, localStorage-backed MVP.
   Philosophy: Understand -> Measure -> Stabilize -> Improve
   Keeps FACT vs INTERPRETATION separate. Baseline before targets.
   ==========================================================================*/
'use strict';

/* ---------------------------------------------------------------- constants */
const DB_KEY = 'wods_db_v1';
const TIMER_KEY = 'wods_timer_v1';   // running measurement, persisted so it survives reload / app update
const APP_VERSION = '1.0';

/* Operational observation categories. Legacy category-style types (Process/People/System…) from earlier
   records are preserved via obsTypeOptions() so existing observations are never broken. */
const OBS_TYPES = ['Observed Current Practice','Normal operation','Delay / Waiting','Bottleneck','Process deviation','Error','Rework','Interruption','Quality issue','Safety issue','Resource issue','Other'];
const OBS_TYPES_LEGACY = ['Process','People','System','Inventory','Layout','Safety','Quality','Communication','HQ Interface','Customer impact'];
/* the list for the dropdown = operational types + any legacy/other type actually present in the DB + the current value */
function obsTypeOptions(current){
  const set=[...OBS_TYPES];
  Store.col('observations').forEach(o=>{ if(o.type && !set.includes(o.type)) set.push(o.type); });
  if(current && !set.includes(current)) set.push(current);
  return set;
}
const OBS_STATUS = ['New','Observed','Under validation','Validated','Rejected','Converted to problem','Resolved'];
const VALIDATION_STATUS = ['Not required','Pending validation','Validated','Not confirmed','Partially validated'];
const VALIDATION_METHODS = ['Repeat observation','Time measurement','Count occurrences','Compare stations','Compare shifts','Check system data','Check SOP / standard','Interview operator','Physical inspection','Other'];
/* KPIs / objectives requested by management (HQ). Used as suggestions on the Related-KPI field. */
const MANAGEMENT_KPIS = ['Orders/day','Same-day shipping','No carryover','Cost per order','Picking/Packing errors','Staffing / shift discipline','Attendance / punctuality','Customer returns','Safety','Inventory handling'];
const SEVERITIES = [
  {k:'Critical', cls:'b-crit', dot:'🔴'},
  {k:'Important', cls:'b-imp', dot:'🟠'},
  {k:'Improvement', cls:'b-warn', dot:'🟡'},
  {k:'Minor', cls:'b-minor', dot:'🟢'},
];
const SKILL_LEVELS = ['Not trained','Learning','Basic','Competent','Advanced','Trainer']; // index = level 0..5
const ROLE_TAGS = ['Primary','Backup','Trainer','Training required'];
const PROB_STATUS = ['Open','Under validation','Validated','In progress','Resolved','Rejected'];

/* Process classification for Actual Process Flow. Configurable per process.
   Measured = actively timed · Linked = may connect to another · Conditional = only in some flows · Exception = recorded when relevant. */
const FLOW_TYPES = ['Measured','Linked','Conditional','Exception'];
const FLOW_TYPE_BADGE = {Measured:'b-ok', Linked:'b-new', Conditional:'b-warn', Exception:'b-imp'};
const FLOW_TYPE_DEFAULTS = {
  'Claim':'Measured','Picking':'Measured','Packing/Check-out':'Measured','Check-out':'Measured','Packing':'Measured','Mapping':'Measured','Receiving':'Measured',
  'Arrival':'Linked','Check-in':'Linked','Boxing':'Linked','Dispatch':'Linked',
  'Verification':'Conditional','Put-away':'Conditional','Storage':'Conditional','Returns':'Conditional','Refusals':'Conditional','Returns verification':'Conditional',
  'Damaged Goods':'Exception','Waste':'Exception','Inventory':'Exception',
};
function defaultFlowType(name){ return FLOW_TYPE_DEFAULTS[name] || 'Linked'; }
/* special "next step" tokens for transitions that are not another process */
const NEXT_END = '__end__';         // flow terminated (dispatched / to customer / stored — end of observed journey)
const NEXT_EXCEPTION = '__exception__';
function nextStepLabel(v){ if(v===NEXT_END) return '▣ Ended / Dispatched'; if(v===NEXT_EXCEPTION) return '⚠ Exception'; return procName(v)||''; }

const PHASES = [
  {n:1, name:'Observe & Understand', from:1, to:10, focus:['observations','interviews','process understanding','evidence']},
  {n:2, name:'Map & Measure',        from:11,to:20, focus:['measurements','process maps','KPI baseline','bottlenecks']},
  {n:3, name:'Stabilize',            from:21,to:25, focus:['SOP','5S','cross-training','quick wins']},
  {n:4, name:'Improve & Report',     from:26,to:30, focus:['KPI','accountability','improvements','management reporting']},
];

const KPI_CATALOG = {
  'Productivity':['Orders/hour','Lines/hour','Units/hour'],
  'Quality':['Picking accuracy','Packing accuracy','Fulfillment accuracy'],
  'Speed':['Claim → Picking','Picking → Check-out','Check-out → Boxing','Boxing → Dispatch'],
  'Inventory':['Inventory accuracy','Missing SKU','Misplaced SKU','Damaged products'],
  'People':['Attendance','Punctuality','Productivity/person','Overtime'],
  'Inbound':['Receiving lead time','Check-in time','Mapping time','Put-away time','Receiving accuracy','Damage rate'],
};

/* Official Warehouse Lead KPI Cockpit — targets set by management (HQ).
   kind: pct (goal %) · min (>= goal) · zero (target 0) · reduce/baseline (reduce vs baseline) .
   dir: 'up' higher-is-better, 'down' lower-is-better. def: default status colour before data. */
const OFFICIAL_KPIS = [
  {id:'sameday',   name:'Same-Day Fulfillment',       target:'100%',            kind:'pct',      goal:100, dir:'up',   def:'red',    unit:'%'},
  {id:'ordersday', name:'Orders Shipped / Day',       target:'≥ 1,000',         kind:'min',      goal:1000,dir:'up',   def:'red',    unit:'orders'},
  {id:'carryover', name:'Carryover Orders',           target:'0',               kind:'zero',     goal:0,   dir:'down', def:'red',    unit:'orders'},
  {id:'costorder', name:'Cost / Order',               target:'Baseline first',  kind:'baseline', dir:'down', def:'yellow', unit:'€'},
  {id:'pickerr',   name:'Picking / Packing Errors',   target:'Reduce',          kind:'reduce',   dir:'down', def:'yellow', unit:'count'},
  {id:'rework',    name:'Rework',                      target:'Reduce',          kind:'reduce',   dir:'down', def:'yellow', unit:'count'},
  {id:'attend',    name:'Shift Attendance',           target:'100%',            kind:'pct',      goal:100, dir:'up',   def:'yellow', unit:'%'},
  {id:'ontime',    name:'On-Time Shift Start',        target:'100%',            kind:'pct',      goal:100, dir:'up',   def:'yellow', unit:'%'},
  {id:'safety',    name:'Safety Violations',          target:'0',               kind:'zero',     goal:0,   dir:'down', def:'green',  unit:'count'},
  {id:'invrule',   name:'Inventory Rule Violations',  target:'0',               kind:'zero',     goal:0,   dir:'down', def:'green',  unit:'count'},
  {id:'packwaste', name:'Packaging Waste',            target:'Reduce',          kind:'reduce',   dir:'down', def:'yellow', unit:''},
];

const ORDER_STAGES = ['Claim','Picking','Packing/Check-out','Boxing'];
/* Planned/reference sequences — used to SUGGEST the next step after a measurement.
   These are suggestions only; the actual observed next step is whatever the Lead chooses. */
const REFERENCE_CHAINS = [
  ['Claim','Picking','Packing/Check-out','Boxing'],
  ['Receiving','Check-in','Mapping'],
  ['Returns','Returns verification','Mapping'],   // opened returns: verified by service, then mapped
  ['Refusals','Mapping'],                          // unopened refusals: mapped directly (automatic)
];
function referenceNextName(name){ for(const ch of REFERENCE_CHAINS){ const i=ch.indexOf(name); if(i>=0 && i<ch.length-1) return ch[i+1]; } return null; }
function referenceNextProc(pid){ const p=Store.get('processes',pid); if(!p) return null; const nn=referenceNextName(p.name); if(!nn) return null; const np=activeProcesses().find(x=>x.name===nn); return np?np.id:null; }
const INBOUND_STAGES = ['Arrival','Receiving','Check-in','Mapping','System update'];
const DISCREPANCIES = ['SKU missing','Barcode missing','Quantity mismatch','Wrong SKU','Damaged product','Product not in system','Incorrect location'];
/* Multi-seller / split-order handling. Some order items are picked from stock (received earlier, mapped & stored),
   others are cross-docked (received later, staged straight to check-out — skipping mapping/put-away/storage). */
const FULFILLMENT_TYPES = ['Single source','From stock (picked)','Cross-dock (staged to check-out)','Split — stock + cross-dock'];
const INBOUND_HANDLING = ['To storage (map → put-away)','Cross-dock → check-out','Staged (awaiting other items)'];

/* ------------------------------------------------------------------- helpers */
const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));
const uid = (p='id')=> p+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const nowISO = ()=> new Date().toISOString();
const todayStr = ()=> new Date().toISOString().slice(0,10);
const nowTime  = ()=> new Date().toTimeString().slice(0,5);
function h(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function num(v,d=0){ const n=parseFloat(v); return isNaN(n)?d:n; }
function daysBetween(a,b){ return Math.round((new Date(b+'T00:00') - new Date(a+'T00:00'))/86400000); }
function fmtMin(sec){ if(sec==null) return '—'; const m=Math.floor(sec/60), s=Math.round(sec%60); return m+'m '+String(s).padStart(2,'0')+'s'; }
/* Report/export duration: minutes when >= 60s, otherwise seconds. */
function fmtDur(sec){ if(sec==null||sec==='') return '—'; sec=Number(sec); if(isNaN(sec)) return '—';
  return sec<60 ? Math.round(sec)+' sec' : (Math.round(sec/60*10)/10)+' min'; }
function fmtClock(sec){ const m=Math.floor(sec/60), s=Math.floor(sec%60); return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }
function pct(n){ return (n==null||isNaN(n))?'—':(Math.round(n*10)/10)+'%'; }
function na(v){ return (v===''||v==null)?'<span class="na">Not yet recorded</span>':h(v); }
function sevBadge(k){ const s=SEVERITIES.find(x=>x.k===k); return s?`<span class="badge ${s.cls}">${s.dot} ${s.k}</span>`:`<span class="badge b-muted">${h(k||'—')}</span>`; }
function statusBadge(s){
  const map={'New':'b-new','Observed':'b-muted','Under validation':'b-warn','Validated':'b-valid','Rejected':'b-muted','Converted to problem':'b-imp','Resolved':'b-ok',
             'Open':'b-new','In progress':'b-warn'};
  return `<span class="badge ${map[s]||'b-muted'}">${h(s||'—')}</span>`;
}
function toast(msg){
  let t=$('#toast'); if(!t){ t=document.createElement('div'); t.id='toast';
    t.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#0e3a2a;color:#5bd6a0;border:1px solid #1e4a34;padding:11px 18px;border-radius:10px;z-index:200;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.4)'; document.body.appendChild(t); }
  t.textContent=msg; t.style.opacity='1';
  clearTimeout(t._h); t._h=setTimeout(()=>{ t.style.transition='opacity .4s'; t.style.opacity='0'; },1800);
}

/* --------------------------------------------------------------- data store */
const Store = {
  db:null,
  load(){
    try{ this.db = JSON.parse(localStorage.getItem(DB_KEY)); }catch(e){ this.db=null; }
    if(!this.db){ this.db = seedDB(); this.persist(); }
    // ensure collections exist (forward-compat)
    seedCollections.forEach(c=>{ if(!this.db[c]) this.db[c]=[]; });
    // additive migration: classify existing processes for Actual Process Flow (never overwrites an existing choice)
    let migrated=false;
    (this.db.processes||[]).forEach(p=>{ if(!p.flowType){ p.flowType=defaultFlowType(p.name); migrated=true; } });
    // one-time: drop "Arrival" — it is a starting event, not an operational process.
    if(!this.db.config) this.db.config={};
    this.db.config.migrations = this.db.config.migrations || {};
    if(!this.db.config.migrations.dropArrival){
      const arr=(this.db.processes||[]).find(p=>p.name==='Arrival' && p.category==='Inbound');
      if(arr){
        const referenced = ['measurements','observations','staffSkills','problems'].some(c=>(this.db[c]||[]).some(r=>r.processId===arr.id))
          || (this.db.measurements||[]).some(r=>r.nextProcessId===arr.id);
        if(referenced) arr.active=false;                                   // keep data intact, just hide it
        else this.db.processes=this.db.processes.filter(p=>p.id!==arr.id); // safe to remove entirely
      }
      this.db.config.migrations.dropArrival=true; migrated=true;
    }
    // one-time: merge "Packing" into "Check-out" as a single "Packing/Check-out" process (data reassigned, not lost)
    if(!this.db.config.migrations.mergePackingCheckout){
      const procs=this.db.processes||[];
      const co=procs.find(p=>p.name==='Check-out');
      const pk=procs.find(p=>p.name==='Packing');
      if(co){ co.name='Packing/Check-out'; }
      if(co && pk){
        const target=co.id, from=pk.id;
        (this.db.measurements||[]).forEach(r=>{ if(r.processId===from) r.processId=target; if(r.nextProcessId===from) r.nextProcessId=target; });
        ['observations','problems','staffObs'].forEach(c=>(this.db[c]||[]).forEach(r=>{ if(r.processId===from) r.processId=target; }));
        // capability rows: move to target unless the employee already has one there, then drop the duplicate
        const skills=this.db.staffSkills||[];
        skills.forEach(s=>{ if(s.processId===from){ const dup=skills.find(x=>x.processId===target && x.employeeId===s.employeeId); if(dup) s._drop=true; else s.processId=target; } });
        this.db.staffSkills=skills.filter(s=>!s._drop);
        this.db.processes=procs.filter(p=>p.id!==from);   // remove the now-merged Packing process
      }
      this.db.config.migrations.mergePackingCheckout=true; migrated=true;
    }
    // one-time: retire Verification / Put-away / Storage / Dispatch as processes; ensure Inventory exists.
    if(!this.db.config.migrations.processRevision1){
      const retire=['Verification','Put-away','Storage','Dispatch'];
      retire.forEach(name=>{
        const p=(this.db.processes||[]).find(x=>x.name===name); if(!p) return;
        const referenced = ['measurements','observations','staffSkills','problems','staffObs'].some(c=>(this.db[c]||[]).some(r=>r.processId===p.id))
          || (this.db.measurements||[]).some(r=>r.nextProcessId===p.id);
        if(referenced) p.active=false;                                    // keep history, hide from lists
        else this.db.processes=this.db.processes.filter(x=>x.id!==p.id);  // safe to remove
      });
      if(!(this.db.processes||[]).some(x=>x.name==='Inventory')){
        const max=Math.max(0,...(this.db.processes||[]).map(x=>x.order||0));
        this.db.processes.push({id:uid('prc'),name:'Inventory',category:'Other',order:max+1,active:true,flowType:'Exception'});
      } else { const inv=this.db.processes.find(x=>x.name==='Inventory'); if(inv) inv.active=true; }
      this.db.config.migrations.processRevision1=true; migrated=true;
    }
    // one-time: add the "Refusals" returns category (unopened) alongside "Returns" (opened)
    if(!this.db.config.migrations.returnsCategories){
      if(!(this.db.processes||[]).some(x=>x.name==='Refusals')){
        const max=Math.max(0,...(this.db.processes||[]).map(x=>x.order||0));
        this.db.processes.push({id:uid('prc'),name:'Refusals',category:'Other',order:max+1,active:true,flowType:'Conditional'});
      }
      this.db.config.migrations.returnsCategories=true; migrated=true;
    }
    // one-time: add "Returns verification" (service check before mapping opened returns)
    if(!this.db.config.migrations.returnsVerification){
      if(!(this.db.processes||[]).some(x=>x.name==='Returns verification')){
        const max=Math.max(0,...(this.db.processes||[]).map(x=>x.order||0));
        this.db.processes.push({id:uid('prc'),name:'Returns verification',category:'Other',order:max+1,active:true,flowType:'Conditional'});
      }
      this.db.config.migrations.returnsVerification=true; migrated=true;
    }
    // one-time: seed WMS module (shifts config + connection settings)
    if(!this.db.config.migrations.wmsInit){
      if(!this.db.wmsShifts || !this.db.wmsShifts.length){
        this.db.wmsShifts=[
          {id:uid('sh'),name:'N1',start:'07:00',end:'15:00',weekend:false,active:true},
          {id:uid('sh'),name:'N2',start:'13:00',end:'21:00',weekend:false,active:true},
          {id:uid('sh'),name:'Weekend',start:'09:00',end:'18:00',weekend:true,active:true},
        ];
      }
      this.db.wms = this.db.wms || {url:'https://wms.gjirafamall.com/', autoSync:true, lastSuccess:null, lastFailed:null, logTypeMap:{}};
      this.db.config.migrations.wmsInit=true; migrated=true;
    }
    // one-time: default WMS auto-sync ON (earlier builds seeded it OFF); user can still turn it off later
    if(!this.db.config.migrations.wmsAutoDefaultOn){
      if(this.db.wms && this.db.wms.autoSync===false) this.db.wms.autoSync=true;
      this.db.config.migrations.wmsAutoDefaultOn=true; migrated=true;
    }
    if(migrated) this.persist();
    return this.db;
  },
  persist(){ localStorage.setItem(DB_KEY, JSON.stringify(this.db)); this.schedulePush(); },
  /* ---- shared server copy (wods-db.json via the local agent) ------------------------------
     Every browser on this machine (Chrome, Edge, the Claude pane…) has its own localStorage, so
     the agent keeps ONE canonical copy. Boot pulls it, every persist pushes it (debounced), and a
     60 s poll pulls changes made elsewhere (another tab, or the agent's 21:30 report job). */
  serverSavedAt:null, pushTimer:null, pushing:false,
  onAgent(){ return typeof wmsOnAgent==='function' && wmsOnAgent(); },
  stamp(){ this.db.meta=this.db.meta||{}; this.db.meta.savedAt=nowISO(); return this.db.meta.savedAt; },
  schedulePush(){ if(!this.onAgent()) return; clearTimeout(this.pushTimer); this.pushTimer=setTimeout(()=>this.pushToServer(),600); },
  async pushToServer(){
    if(!this.onAgent() || this.pushing) { if(this.pushing) this.schedulePush(); return; }
    this.pushing=true;
    try{
      const savedAt=this.stamp(); localStorage.setItem(DB_KEY, JSON.stringify(this.db));
      const r=await fetch('/db',{method:'PUT',headers:{'Content-Type':'application/json','X-Base-Saved-At':this.serverSavedAt||''},body:JSON.stringify(this.db)});
      if(r.status===409){ const j=await r.json(); if(j&&j.db){ this.mergeFrom(j.db); this.serverSavedAt=j.db.meta&&j.db.meta.savedAt; this.pushing=false; return this.pushToServer(); } }
      else if(r.ok){ this.serverSavedAt=savedAt; }
    }catch(e){ /* agent offline — local copy stays authoritative until it is back */ }
    this.pushing=false;
  },
  async pullFromServer(opts){
    opts=opts||{}; if(!this.onAgent()) return false;
    try{
      const r=await fetch('/db'+(this.serverSavedAt?'?since='+encodeURIComponent(this.serverSavedAt):''),{cache:'no-store'});
      if(r.status===404){ await this.pushToServer(); return false; }         // first browser on this machine seeds the server copy
      if(r.status===304 || !r.ok) return false;
      const srv=await r.json(); if(!srv||!srv.config) return false;
      const srvAt=(srv.meta&&srv.meta.savedAt)||''; const locAt=(this.db.meta&&this.db.meta.savedAt)||'';
      this.serverSavedAt=srvAt;
      // a browser that never joined the shared copy: adopt it outright when this browser holds nothing of its own,
      // otherwise union the two (natural keys — nothing is lost, nothing double-counted) and push the result
      if(opts.initial && !locAt){
        const own=['observations','measurements','problems','staffObs','kpiRecords','validations'].reduce((a,c)=>a+((this.db[c]||[]).length),0);
        if(!own){ this.db=srv; localStorage.setItem(DB_KEY, JSON.stringify(this.db)); this.load(); return true; }
        this.mergeFrom(srv); localStorage.setItem(DB_KEY, JSON.stringify(this.db)); this.load(); await this.pushToServer(); return true;
      }
      if(srvAt && srvAt!==locAt){ const changed=this.mergeFrom(srv); if(changed){ localStorage.setItem(DB_KEY, JSON.stringify(this.db)); } return changed; }
    }catch(e){}
    return false;
  },
  /* union per collection (natural keys for WMS rows so two browsers' separate syncs never double-count),
     newest record wins; config/meta/wms objects: newer side wins */
  natKey(k,r){
    if(k==='wmsPrepared'||k==='wmsCheckin') return 'nk|'+r.date+'|'+r.operator;
    if(k==='wmsFlow') return 'nk|'+r.date;
    if(k==='wmsStats') return 'nk|'+r.at;
    if(k==='wmsSyncLog') return 'nk|'+r.at+'|'+r.operation;
    if(k==='dailyReports') return 'nk|'+r.date;
    if(k==='weeklyReports') return 'nk|'+r.weekStart;
    if(k==='observations' && r.analysisKey) return 'ak|'+r.analysisKey;
    return 'id|'+r.id;
  },
  mergeFrom(other){
    const ts=r=>r.updatedAt||r.importedAt||r.generatedAt||r.createdAt||r.at||'';
    let changed=false; const mine=this.db;
    const srvNewer=((other.meta&&other.meta.savedAt)||'') > ((mine.meta&&mine.meta.savedAt)||'');
    // tombstones from both sides: a record deleted anywhere stays deleted everywhere
    const dead=Object.assign({}, other.deleted||{}, mine.deleted||{});
    if(JSON.stringify(dead)!==JSON.stringify(mine.deleted||{})){ mine.deleted=dead; changed=true; }
    Object.keys(other).forEach(k=>{
      const ov=other[k];
      if(k==='deleted') return;
      if(Array.isArray(ov)){
        const mv=Array.isArray(mine[k])?mine[k]:(mine[k]=[]);
        // drop anything the other side has deleted since
        for(let i=mv.length-1;i>=0;i--){ if(mv[i]&&typeof mv[i]==='object'&&('id' in mv[i])&&dead[k+'|'+this.natKey(k,mv[i])]){ mv.splice(i,1); changed=true; } }
        if(!ov.length) return;
        if(!ov[0] || typeof ov[0]!=='object' || !('id' in ov[0])){ if(srvNewer && JSON.stringify(mv)!==JSON.stringify(ov)){ mine[k]=ov; changed=true; } return; }
        const byKey=new Map(mv.map(r=>[this.natKey(k,r),r]));
        ov.forEach(r=>{ const key=this.natKey(k,r); if(dead[k+'|'+key]) return; const m=byKey.get(key); if(!m){ mv.push(r); byKey.set(key,r); changed=true; } else if(ts(r)>ts(m) || (srvNewer && ts(r)===ts(m) && JSON.stringify(r)!==JSON.stringify(m))){ Object.assign(m,r); changed=true; } });
        // keep newest-first ordering the UI expects
        mv.sort((a,b)=>ts(b)<ts(a)?-1:(ts(b)>ts(a)?1:0));
      } else if(ov && typeof ov==='object'){
        if(k==='meta') return;
        if(srvNewer && JSON.stringify(mine[k])!==JSON.stringify(ov)){ mine[k]=ov; changed=true; }
      }
    });
    if(srvNewer){ mine.meta=Object.assign({},mine.meta,other.meta); }
    return changed;
  },
  startPolling(){ if(!this.onAgent() || this._poll) return;
    this._poll=setInterval(async()=>{ if($('#modalRoot') && $('#modalRoot').children.length) return;   // never re-render under an open form
      const changed=await this.pullFromServer(); if(changed){ go(); toast('Të dhënat u rifreskuan'); } }, 60000); },
  col(name){ return this.db[name] || (this.db[name]=[]); },
  get(name,id){ return this.col(name).find(r=>r.id===id); },
  insert(name,rec){
    rec.id = rec.id||uid(name.slice(0,3));
    rec.createdAt = nowISO(); rec.createdBy = Store.db.config.currentUser;
    rec.updatedAt = rec.createdAt; rec.updatedBy = rec.createdBy;
    this.col(name).unshift(rec);
    audit(name, rec.id, 'create', null, rec);
    this.persist(); return rec;
  },
  update(name,id,patch){
    const rec=this.get(name,id); if(!rec) return;
    const before=JSON.parse(JSON.stringify(rec));
    Object.assign(rec,patch); rec.updatedAt=nowISO(); rec.updatedBy=Store.db.config.currentUser;
    audit(name, id, 'update', before, rec);
    this.persist(); return rec;
  },
  remove(name,id){
    const i=this.col(name).findIndex(r=>r.id===id); if(i<0) return;
    const before=this.col(name)[i];
    audit(name, id, 'delete', before, null);
    // tombstone: a union merge with another browser would otherwise resurrect the record
    this.db.deleted=this.db.deleted||{}; this.db.deleted[name+'|'+this.natKey(name,before)]=nowISO();
    this.col(name).splice(i,1); this.persist();
  },
};
const seedCollections = ['config','employees','departments','processes','observations','measurements',
  'orders','products','staffSkills','staffObs','problems','kpiRecords','hqInteractions','quickWins','briefings','validations',
  'wmsLogs','wmsStats','wmsShifts','wmsSyncLog','wmsOrders','wmsPrepared','wmsCheckin','wmsFlow','dailyReports','weeklyReports','audit'];

function audit(entity,recId,action,before,after){
  const changes=[];
  if(action==='update' && before && after){
    Object.keys(after).forEach(k=>{
      if(['updatedAt','updatedBy'].includes(k)) return;
      if(JSON.stringify(before[k])!==JSON.stringify(after[k])) changes.push({field:k, from:before[k], to:after[k]});
    });
    if(!changes.length) return;
  }
  Store.db.audit.unshift({id:uid('aud'), at:nowISO(), by:Store.db.config.currentUser, entity, recId, action, changes,
     snapshot: action==='create'?summarize(after):(action==='delete'?summarize(before):null)});
  if(Store.db.audit.length>1000) Store.db.audit.length=1000;
}
function summarize(r){ if(!r) return ''; return r.title||r.what||r.problem||r.name||r.orderRef||r.sku||r.metric||r.id||''; }

/* ----------------------------------------------------------------- seed data */
function seedDB(){
  const P=(name,cat,i)=>({id:uid('prc'),name,category:cat,order:i,active:true,flowType:defaultFlowType(name)});
  let i=0;
  const processes=[
    ...['Receiving','Check-in','Mapping'].map(n=>P(n,'Inbound',i++)),
    ...['Claim','Picking','Packing/Check-out','Boxing'].map(n=>P(n,'Outbound',i++)),
    ...['Refusals','Returns','Returns verification','Damaged Goods','Waste','Inventory'].map(n=>P(n,'Other',i++)),
  ];
  const departments=['Operations','Procurement','Sales','Customer Support','IT/Product','Finance','HR/BNJ','Logistics/Delivery']
    .map(n=>({id:uid('dep'),name:n}));
  // A few example employees (clearly editable) so the matrix is usable immediately.
  const employees=[
    {id:uid('emp'),name:'Employee A',role:'Operator',shift:'Day',active:true,example:true},
    {id:uid('emp'),name:'Employee B',role:'Operator',shift:'Day',active:true,example:true},
    {id:uid('emp'),name:'Employee C',role:'Operator',shift:'Evening',active:true,example:true},
    {id:uid('emp'),name:'Employee D',role:'Team Lead',shift:'Day',active:true,example:true},
  ];
  return {
    config:{ warehouseName:'My Warehouse', startDate: todayStr(), currentUser:'Warehouse Lead',
             role:'Warehouse Lead', workDays:[1,2,3,4,5], holidays:[], createdAt:nowISO(), version:APP_VERSION },
    employees, departments, processes,
    observations:[], measurements:[], orders:[], products:[], staffSkills:[], staffObs:[],
    problems:[], kpiRecords:[], hqInteractions:[], quickWins:[], briefings:[], audit:[],
  };
}

/* --------------------------------------------------------------- derived data */
function dobj(s){ const p=(s||'').split('-').map(Number); return new Date(p[0],(p[1]||1)-1,p[2]||1); }
function fmtLocalDate(t){ return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`; }
/* working days configurable (default Mon–Fri); weekends and listed holidays don't count toward the 30 */
function workDays(){ const w=Store.db.config.workDays; return (Array.isArray(w)&&w.length)? w : [1,2,3,4,5]; }
function isWorkDay(dateStr){ if(!dateStr) return false; const dow=dobj(dateStr).getDay();
  if(!workDays().includes(dow)) return false;
  if((Store.db.config.holidays||[]).includes(dateStr)) return false;
  return true; }
/* inclusive count of working days in [start, end] */
function workingDaysCount(start,end){
  if(!start||!end||end<start) return 0;
  let n=0, t=dobj(start); const e=dobj(end);
  for(; t<=e; t.setDate(t.getDate()+1)){ if(isWorkDay(fmtLocalDate(t))) n++; }
  return n;
}
function currentDay(){ return Math.max(1, workingDaysCount(Store.db.config.startDate, todayStr())); }
/* Phases can overlap in practice (e.g. observing AND measuring at once).
   By default the phase follows the 30-day calendar, but the Lead can manually
   select one or more active phases in Configuration (config.activePhases). */
function autoPhase(){
  const day=Math.min(currentDay(),30);
  return PHASES.find(p=> day>=p.from && day<=p.to) || PHASES[3];
}
function currentPhaseNums(){
  const a=Store.db.config.activePhases;
  return (Array.isArray(a)&&a.length) ? a.slice().sort((x,y)=>x-y) : [autoPhase().n];
}
function currentPhaseObjs(){ return currentPhaseNums().map(n=>PHASES.find(p=>p.n===n)).filter(Boolean); }
function isPhaseAuto(){ const a=Store.db.config.activePhases; return !(Array.isArray(a)&&a.length); }
function currentPhase(){ const o=currentPhaseObjs(); return o[o.length-1]||autoPhase(); }   // primary = most advanced active phase
function currentPhasesLabel(){
  const objs=currentPhaseObjs();
  if(objs.length<=1){ const p=objs[0]||autoPhase(); return {nums:String(p.n), names:p.name}; }
  return {nums:objs.map(o=>o.n).join('+'), names:objs.map(o=>o.name).join(' + ')};
}
function currentPhaseFocus(){ const set=new Set(); currentPhaseObjs().forEach(o=>o.focus.forEach(f=>set.add(f))); return [...set]; }
function procName(id){ const p=Store.get('processes',id); return p?p.name:''; }
function empName(id){ const e=Store.get('employees',id); return e?e.name:''; }
function activeProcesses(){ return Store.col('processes').filter(p=>p.active).sort((a,b)=>a.order-b.order); }
function processesByCat(cat){ return activeProcesses().filter(p=>p.category===cat); }

/* =========================================================================
   ROUTER + NAV
   =======================================================================*/
const ROUTES = [
  {sec:'Observe'},
  {id:'dashboard', title:'Dashboard', ic:'▤', render:renderDashboard},
  {id:'observations', title:'Daily Observation', ic:'👁', render:renderObservations},
  {id:'timer', title:'Process Measurement', ic:'⏱', render:renderTimer},
  {id:'raportet', title:'Raportet', ic:'📑', render:renderRaportet},
  {sec:'Flows'},
  {id:'orders', title:'Order Flow', ic:'➜', render:renderOrders},
  {id:'inbound', title:'Product / Inbound Flow', ic:'⇩', render:renderInbound},
  {id:'maps', title:'Process Maps', ic:'🗺', render:renderMaps},
  {id:'flows', title:'Actual Process Flow', ic:'🔀', render:renderActualFlows},
  {sec:'People'},
  {id:'matrix', title:'Staff Capability Matrix', ic:'▦', render:renderMatrix},
  {id:'staffobs', title:'Staff Observation Log', ic:'📝', render:renderStaffObs},
  {sec:'Diagnose'},
  {id:'problems', title:'Bottleneck Register', ic:'⚠', render:renderProblems},
  {id:'kpi', title:'KPI Baseline', ic:'📊', render:renderKPI},
  {id:'validation', title:'Validation', ic:'⚖', render:renderValidation},
  {id:'insights', title:'Insights & Alerts', ic:'💡', render:renderInsights},
  {sec:'Interface'},
  {id:'hq', title:'HQ Interface', ic:'🏢', render:renderHQ},
  {sec:'WMS'},
  {id:'wms', title:'WMS Data & Performance', ic:'🔌', render:renderWMS},
  {sec:'Reports'},
  {id:'reports', title:'Reports', ic:'📄', render:renderReports},
  {sec:'System'},
  {id:'search', title:'Global Search', ic:'🔍', render:renderSearch},
  {id:'config', title:'Configuration', ic:'⚙', render:renderConfig},
  {id:'data', title:'Data & Export', ic:'💾', render:renderData},
];
function route(id){ return ROUTES.find(r=>r.id===id); }

function buildNav(){
  const nav=$('#nav'); nav.innerHTML='';
  ROUTES.forEach(r=>{
    if(r.sec){ const d=document.createElement('div'); d.className='sec'; d.textContent=r.sec; nav.appendChild(d); return; }
    const a=document.createElement('a'); a.href='#'+r.id; a.dataset.id=r.id;
    a.innerHTML=`<span class="ic">${r.ic}</span><span>${r.title}</span>`;
    nav.appendChild(a);
  });
}
function go(){
  let id=(location.hash||'#dashboard').slice(1);
  if(!route(id)){ id='dashboard'; }
  const r=route(id);
  $$('#nav a').forEach(a=>a.classList.toggle('active',a.dataset.id===id));
  $('#pageTitle').textContent=r.title;
  updatePills();
  if(timerTick && id!=='timer'){ clearInterval(timerTick); timerTick=null; } // keep a running timer ticking only while on its page
  const view=$('#view'); view.innerHTML=''; window.scrollTo(0,0);
  r.render(view);
  closeSidebar();
}
function updatePills(){
  const day=currentDay(), lbl=currentPhasesLabel();
  const multi=currentPhaseObjs().length>1;
  const off=!isWorkDay(todayStr());
  $('#dayPill').innerHTML='Work-day '+Math.min(day,30)+'/30'+(off?' <span style="opacity:.65">· off</span>':'');
  $('#phasePill').innerHTML=`${multi?'Phases':'Phase'} <b>${lbl.nums}</b> · ${h(lbl.names)}${isPhaseAuto()?'':' <span style="opacity:.6">(manual)</span>'}`;
}
function closeSidebar(){ $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('on'); }

/* ---------------------------------------------------------- generic UI atoms */
function phaseFocusStrip(){
  const set=new Set(currentPhaseNums());
  return `<div class="flowstrip">${PHASES.map(p=>`<span class="${set.has(p.n)?'on':''}">Phase ${p.n}: ${p.name}</span>`).join('<i>›</i>')}</div>`;
}
function pipelineStrip(active){
  const steps=['Observe','Measure','Validate','Diagnose','Report'];
  return `<div class="flowstrip">${steps.map(s=>`<span class="${s===active?'on':''}">${s}</span>`).join('<i>›</i>')}</div>`;
}
function pagehead(title,desc,actionsHTML=''){
  return `<div class="pagehead"><div><div style="font-size:19px;font-weight:700">${h(title)}</div>
    <div class="desc">${desc}</div></div><div class="actions">${actionsHTML}</div></div>`;
}
function emptyRow(cols,msg){ return `<tr><td colspan="${cols}"><div class="empty">${h(msg)}</div></td></tr>`; }

/* modal + form engine ------------------------------------------------------ */
function closeModal(){ $('#modalRoot').innerHTML=''; }
function openModal(title, bodyHTML, footHTML){
  $('#modalRoot').innerHTML=`<div class="modal-bg" id="mbg"><div class="modal">
    <div class="head"><h2>${h(title)}</h2><button class="x" id="mx">×</button></div>
    <div class="body">${bodyHTML}</div>
    <div class="foot">${footHTML||''}</div></div></div>`;
  $('#mx').onclick=closeModal;
  $('#mbg').onclick=e=>{ if(e.target.id==='mbg') closeModal(); };
}
/* field spec: {name,label,type,options,required,value,hint,rows,col} */
function fieldHTML(f){
  if(f.type==='section') return `<div class="formsection">${h(f.label)}${f.hint?`<span>${f.hint}</span>`:''}</div>`;
  const req=f.required?'<span class="req"> *</span>':'';
  const v=f.value!=null?f.value:'';
  let input='';
  const common=`id="f_${f.name}" name="${f.name}"`;
  switch(f.type){
    case 'textarea': input=`<textarea ${common} rows="${f.rows||3}" placeholder="${h(f.ph||'')}">${h(v)}</textarea>`; break;
    case 'select':
      input=`<select ${common}><option value="">— select —</option>${(f.options||[]).map(o=>{
        const val=typeof o==='object'?o.v:o, lab=typeof o==='object'?o.l:o;
        return `<option value="${h(val)}" ${String(v)===String(val)?'selected':''}>${h(lab)}</option>`;}).join('')}</select>`; break;
    case 'number': input=`<input type="number" step="${f.step||'any'}" ${common} value="${h(v)}" placeholder="${h(f.ph||'')}">`; break;
    case 'date': input=`<input type="date" ${common} value="${h(v|| (f.noToday?'':todayStr()))}">`; break;
    case 'time': input=`<input type="time" ${common} value="${h(v||nowTime())}">`; break;
    case 'checkbox': input=`<label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--text)"><input type="checkbox" ${common} style="width:auto;min-height:auto" ${v?'checked':''}> ${h(f.cbLabel||'Yes')}</label>`; break;
    case 'chips':
      input=`<div class="chips" data-chips="${f.name}">${(f.options||[]).map(o=>`<span class="chip ${String(v)===String(o)?'on':''}" data-val="${h(o)}">${h(o)}</span>`).join('')}</div><input type="hidden" ${common} value="${h(v)}">`; break;
    case 'attachments':
      input=`<input type="file" ${common} accept="image/*,.pdf" multiple><div id="att_${f.name}" class="attlist" style="margin-top:8px"></div>`; break;
    case 'datalist':
      input=`<input type="text" ${common} value="${h(v)}" placeholder="${h(f.ph||'')}" list="dl_${f.name}" autocomplete="off"><datalist id="dl_${f.name}">${(f.options||[]).map(o=>`<option value="${h(o)}"></option>`).join('')}</datalist>`; break;
    case 'empmulti':
      input=`<div id="empm_${f.name}"></div><button type="button" class="btn sm" id="empadd_${f.name}">＋ Add employee</button>`; break;
    default: input=`<input type="text" ${common} value="${h(v)}" placeholder="${h(f.ph||'')}">`;
  }
  return `<div class="field" ${f.col?`style="grid-column:${f.col}"`:''}><label for="f_${f.name}">${h(f.label)}${req}</label>${input}${f.hint?`<div class="hint">${f.hint}</div>`:''}</div>`;
}
function formHTML(fields){
  // group by row hints: fields with .row group consecutive
  let html=''; let i=0;
  while(i<fields.length){
    const f=fields[i];
    if(f.row){ const grp=[f]; let j=i+1; while(j<fields.length && fields[j].row===f.row){ grp.push(fields[j]); j++; }
      html+=`<div class="row${grp.length}">${grp.map(fieldHTML).join('')}</div>`; i=j; }
    else { html+=fieldHTML(f); i++; }
  }
  return html;
}
function readForm(fields){
  const out={};
  fields.forEach(f=>{
    if(f.type==='section'||f.type==='attachments'||f.type==='empmulti') return;   // handled outside the generic reader
    const el=$('#f_'+f.name); if(!el) return;
    if(f.type==='checkbox') out[f.name]=el.checked;
    else if(f.type==='number') out[f.name]= el.value===''?null:num(el.value);
    else out[f.name]=el.value.trim();
  });
  return out;
}
function wireChips(){
  $$('[data-chips]').forEach(box=>{
    box.onclick=e=>{ const c=e.target.closest('.chip'); if(!c) return;
      box.querySelectorAll('.chip').forEach(x=>x.classList.remove('on')); c.classList.add('on');
      box.parentElement.querySelector('input[type=hidden]').value=c.dataset.val;
    };
  });
}
/** Open a record editor. spec:{title, fields, values, onSave(values,fields)} */
function openForm(spec){
  const fields=spec.fields.map(f=>({...f, value: spec.values? spec.values[f.name] : f.value }));
  openModal(spec.title, `<form id="recForm" onsubmit="return false">${formHTML(fields)}</form>${spec.extra||''}`,
    `<button class="btn ghost" id="mcancel">Cancel</button><button class="btn primary" id="msave">${spec.saveLabel||'Save'}</button>`);
  wireChips();
  if(spec.afterRender) spec.afterRender(document.getElementById('recForm'));
  $('#mcancel').onclick=closeModal;
  $('#msave').onclick=()=>{
    const vals=readForm(fields);
    for(const f of fields){ if(f.required && (vals[f.name]===''||vals[f.name]==null)){ toast('Please fill: '+f.label); $('#f_'+f.name)?.focus(); return; } }
    spec.onSave(vals, fields);
  };
}
function confirmDelete(label, fn){
  openModal('Delete', `<p>Delete <b>${h(label)}</b>? This is recorded in the audit log but cannot be undone.</p>`,
    `<button class="btn ghost" id="mcancel">Cancel</button><button class="btn danger" id="mdel">Delete</button>`);
  $('#mcancel').onclick=closeModal;
  $('#mdel').onclick=()=>{ fn(); closeModal(); };
}

/* option helpers */
const procOpts = ()=> activeProcesses().map(p=>({v:p.id,l:p.name+' ('+p.category+')'}));
const empOpts  = ()=> Store.col('employees').filter(e=>e.active!==false).map(e=>({v:e.id,l:e.name}));
const depOpts  = ()=> Store.col('departments').map(d=>({v:d.id,l:d.name}));

/* =========================================================================
   DASHBOARD
   =======================================================================*/
function computeStats(){
  const obs=Store.col('observations'), meas=Store.col('measurements'), probs=Store.col('problems');
  const validObs=obs.filter(o=>o.status==='Validated').length;
  const openObs=obs.filter(o=>['New','Observed','Under validation'].includes(o.status)).length;
  const procsObserved=new Set(obs.map(o=>o.processId).filter(Boolean)).size;
  const staffObserved=new Set([...Store.col('staffObs').map(s=>s.employeeId), ...obs.flatMap(o=>o.staff||[])].filter(Boolean)).size;
  const totalProc=meas.reduce((a,m)=>a+(m.processingSec||0),0);
  const totalWait=meas.reduce((a,m)=>a+(m.waitingSec||0),0);
  const hqContacted=new Set(Store.col('hqInteractions').map(x=>x.departmentId)).size;
  return {
    obs:obs.length, validObs, openObs, procsObserved,
    orders:Store.col('orders').length, products:Store.col('products').length,
    staffObserved, meas:meas.length,
    problems:probs.length, validProblems:probs.filter(p=>['Validated','In progress','Resolved'].includes(p.status)).length,
    critical:probs.filter(p=>p.severity==='Critical' && p.status!=='Resolved' && p.status!=='Rejected').length,
    kpi:Store.col('kpiRecords').length, hqContacted,
    quickWins:Store.col('quickWins').length,
    totalProc, totalWait,
    waitPct: (totalProc+totalWait)>0 ? totalWait/(totalProc+totalWait)*100 : null,
  };
}
function kpiCard(val,lbl,foot,cls,accent){
  return `<div class="card kpi ${accent?'accent':''}"><div class="val ${cls||''}">${val}</div><div class="lbl">${lbl}</div>${foot?`<div class="foot">${foot}</div>`:''}</div>`;
}
function renderDashboard(v){
  const s=computeStats(), day=currentDay(), ph=currentPhase();
  const donePct=Math.min(100, Math.round(Math.min(day,30)/30*100));
  const avgW = s.meas? s.waitPct : null;

  v.innerHTML = `
  ${pipelineStrip('Observe')}
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:baseline">
      <div><b style="font-size:15px">${h(Store.db.config.warehouseName)}</b> — 30 Working-Day Observation
        <span class="muted">· filloi ${h(fmtDateAl(Store.db.config.startDate))}</span></div>
      <div class="muted">Ditë pune <b style="color:var(--accent);font-size:16px">${Math.min(day,30)}</b> / 30 · ${currentPhaseObjs().length>1?'Phases':'Phase'} ${currentPhaseObjs().length>1?'':''}${currentPhasesLabel().nums}: ${h(currentPhasesLabel().names)}${isPhaseAuto()?'':' <span class="faint">(manual)</span>'}</div>
    </div>
    <div class="progress" style="margin-top:10px"><i style="width:${donePct}%"></i></div>
    ${!isWorkDay(todayStr())?`<div class="note" style="margin-top:8px">📅 Sot është <b>ditë jopune</b> (vikend/pushim) — numëruesi i ditëve të punës nuk ecën sot. Vëzhgimet/matjet mund t'i futësh gjithsesi.</div>`:''}
    <div class="hint" style="margin-top:8px">Numërohen vetëm <b>ditët e punës</b> (${workDays().map(n=>['Die','Hën','Mar','Mër','Enj','Pre','Sht'][n]).join(', ')}). Fokusi aktual: ${currentPhaseFocus().map(f=>`<b>${h(f)}</b>`).join(' · ')}</div>
  </div>

  <div class="grid g-kpi" style="margin-bottom:16px">
    ${kpiCard(s.critical, 'Open critical problems', 'evidence-linked', s.critical?'crit':'ok', true)}
    ${kpiCard(avgW==null?'—':pct(avgW), 'Waiting share of cycle time', s.meas?'from '+s.meas+' measurements':'no measurements yet', avgW>50?'warn':'')}
    ${kpiCard(s.obs, 'Observations logged', s.validObs+' validated · '+s.openObs+' open')}
    ${kpiCard(s.problems, 'Problems in register', s.validProblems+' validated')}
    ${kpiCard(s.meas, 'Measurements', 'processing vs waiting split')}
    ${kpiCard(s.orders, 'Orders observed', 'flow tracking')}
    ${kpiCard(s.products, 'Products / inbound', 'flow tracking')}
    ${kpiCard(s.kpi, 'KPI data points', 'baseline building')}
  </div>

  <div class="grid g-2" style="margin-bottom:16px">
    <div class="card"><h3>Processing vs Waiting Time <span class="sub">observed measurements</span></h3>${chartProcWait()}</div>
    <div class="card"><h3>Problems by process <span class="sub">register</span></h3>${chartProblemsByProcess()}</div>
    <div class="card"><h3>Problems by severity</h3>${chartSeverity()}</div>
    <div class="card"><h3>Observations by day</h3>${chartObsByDay()}</div>
  </div>

  <div class="grid g-2">
    <div class="card"><h3>Coverage snapshot <span class="sub">what has been touched</span></h3>
      ${coverageList([
        ['Processes observed', s.procsObserved, activeProcesses().length],
        ['Staff observed', s.staffObserved, Store.col('employees').filter(e=>e.active!==false).length],
        ['HQ departments contacted', s.hqContacted, Store.col('departments').length],
      ])}
    </div>
    <div class="card"><h3>Top open findings <span class="sub">by priority</span></h3>${dashTopProblems()}</div>
  </div>

  <div class="note" style="margin-top:14px">📌 <b>Observation phase discipline.</b> This dashboard reports what has been <b>observed and measured</b>, not conclusions.
   Establish a <b>baseline</b> first; targets and major changes come after validation. Every number here traces back to a record.</div>`;
}
function coverageList(rows){
  return rows.map(([lbl,have,total])=>{
    const p= total? Math.round(have/total*100):0;
    return `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${lbl}</span><span class="muted">${have} / ${total}</span></div>
      <div class="progress" style="margin-top:4px"><i style="width:${p}%"></i></div></div>`;
  }).join('');
}
function dashTopProblems(){
  const ps=Store.col('problems').filter(p=>!['Resolved','Rejected'].includes(p.status))
    .sort((a,b)=>(b.priorityScore||0)-(a.priorityScore||0)).slice(0,5);
  if(!ps.length) return `<div class="empty">No problems in register yet.</div>`;
  return `<div>${ps.map(p=>`<div style="display:flex;gap:9px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)">
     ${sevBadge(p.severity)}<span class="wrap" style="flex:1">${h(p.problem)}</span>
     <span class="muted small">${h(procName(p.processId))||''}</span></div>`).join('')}</div>`;
}
/* mini charts (pure DOM bars, offline) */
function barRow(label,val,max,color,valLabel){
  const w= max>0? Math.max(2,Math.round(val/max*100)):0;
  return `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:12px"><span class="wrap">${h(label)}</span><span class="muted">${valLabel!=null?valLabel:val}</span></div>
   <div style="height:12px;background:var(--bg);border-radius:6px;overflow:hidden;margin-top:3px;border:1px solid var(--line)"><i style="display:block;height:100%;width:${w}%;background:${color}"></i></div></div>`;
}
function chartProcWait(){
  const m=Store.col('measurements'); if(!m.length) return `<div class="empty">Run the Process Measurement timer to populate this.</div>`;
  // aggregate by process
  const agg={};
  m.forEach(x=>{ const k=procName(x.processId)||'—'; agg[k]=agg[k]||{p:0,w:0}; agg[k].p+=x.processingSec||0; agg[k].w+=x.waitingSec||0; });
  const rows=Object.entries(agg).sort((a,b)=>(b[1].p+b[1].w)-(a[1].p+a[1].w)).slice(0,8);
  return rows.map(([k,o])=>{
    const tot=o.p+o.w, wp= tot? Math.round(o.w/tot*100):0, pp=100-wp;
    return `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between;font-size:12px"><span>${h(k)}</span>
      <span class="muted">${fmtMin(o.p)} proc · <b style="color:var(--warn)">${fmtMin(o.w)} wait</b></span></div>
      <div class="splitbar" style="margin:5px 0 0;height:20px">
        <span class="proc" style="width:${pp}%">${pp>12?pp+'%':''}</span>
        <span class="wait" style="width:${wp}%">${wp>12?wp+'%':''}</span></div></div>`;
  }).join('') + `<div class="hint" style="margin-top:8px"><span class="etag et-data">data-derived</span> split of active work vs waiting — not a root-cause conclusion.</div>`;
}
function chartProblemsByProcess(){
  const p=Store.col('problems'); if(!p.length) return `<div class="empty">No problems logged.</div>`;
  const agg={}; p.forEach(x=>{ const k=procName(x.processId)||'Unassigned'; agg[k]=(agg[k]||0)+1; });
  const rows=Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0,8); const max=Math.max(...rows.map(r=>r[1]));
  return rows.map(([k,c])=>barRow(k,c,max,'var(--imp)')).join('');
}
function chartSeverity(){
  const p=Store.col('problems'); if(!p.length) return `<div class="empty">No problems logged.</div>`;
  return SEVERITIES.map(s=>{ const c=p.filter(x=>x.severity===s.k).length;
    const col={Critical:'var(--crit)',Important:'var(--imp)',Improvement:'var(--warn)',Minor:'var(--minor)'}[s.k];
    return barRow(s.dot+' '+s.k, c, p.length, col); }).join('');
}
function chartObsByDay(){
  const o=Store.col('observations'); if(!o.length) return `<div class="empty">No observations logged.</div>`;
  const agg={}; o.forEach(x=>{ const k=x.date||'—'; agg[k]=(agg[k]||0)+1; });
  const rows=Object.entries(agg).sort((a,b)=>a[0]<b[0]?-1:1).slice(-10); const max=Math.max(...rows.map(r=>r[1]));
  return rows.map(([k,c])=>barRow(k,c,max,'var(--accent)')).join('');
}

/* =========================================================================
   DAILY OBSERVATION
   =======================================================================*/
const OBS_FIELDS = (current)=>[
  {type:'section',label:'1 · When & where'},
  {name:'date',label:'Date',type:'date',required:true,row:'a'},
  {name:'time',label:'Time',type:'time',required:true,row:'a'},
  {name:'processId',label:'Process',type:'select',options:procOpts(),row:'b'},
  {name:'subProcess',label:'Sub-process (specific activity)',type:'text',row:'b'},
  {name:'location',label:'Location / zone',type:'text'},

  {type:'section',label:'2 · Observation', hint:'the facts — only what you saw'},
  {name:'type',label:'Observation type',type:'select',options:obsTypeOptions(current&&current.type),required:true,row:'c'},
  {name:'staffText',label:'Staff involved',type:'text',ph:'names or roles',row:'c'},
  {name:'ref',label:'Order / SKU reference',type:'text'},
  {name:'what',label:'What happened — FACT, only what you observed',type:'textarea',required:true,hint:'Record only what you saw or measured. No conclusions, causes or assumptions here — those belong in the Hypothesis section below.'},

  {type:'section',label:'3 · Expected vs actual', hint:'for spotting process deviations'},
  {name:'expected',label:'Expected process (per SOP / intended workflow)',type:'textarea',rows:2,row:'d'},
  {name:'actual',label:'Actual process (what actually happened)',type:'textarea',rows:2,row:'d'},

  {type:'section',label:'4 · Evidence & impact'},
  {name:'evidence',label:'Evidence (what supports the observation)',type:'text',ph:'stopwatch, order ID, SKU, photo ref, system record, count…',hint:'Evidence is separate from the observation — it is what backs it up.'},
  {name:'evidenceLink',label:'Evidence link / URL (optional)',type:'text',ph:'https://…  or a system-record link'},
  {name:'attachments',label:'Attach files (photo, PDF…)',type:'attachments',hint:'Photos are compressed automatically and saved in your browser. For very large files, use the link field instead.'},
  {name:'impact',label:'Impact (the effect of the event)',type:'textarea',rows:2,hint:'The effect it had — e.g. added 2 min, station idle, order delayed. Not the cause.'},
  {name:'waitingMin',label:'Waiting time (min)',type:'number',row:'e'},
  {name:'processingMin',label:'Processing time (min)',type:'number',row:'e'},
  {name:'interruption',label:'Interruption?',type:'checkbox',cbLabel:'Yes',row:'f'},
  {name:'rework',label:'Rework?',type:'checkbox',cbLabel:'Yes',row:'f'},
  {name:'error',label:'Error?',type:'checkbox',cbLabel:'Yes',row:'f'},
  {name:'interruptionDetail',label:'Interruption — type / description',type:'text'},
  {name:'reworkDetail',label:'Rework — what had to be repeated?',type:'text'},
  {name:'errorDetail',label:'Error — type / description',type:'text'},

  {type:'section',label:'5 · Hypothesis', hint:'a suspicion, not a conclusion'},
  {name:'cause',label:'Possible cause (hypothesis — not confirmed)',type:'textarea',rows:2,hint:'What you suspect may be behind it. It stays a hypothesis until validated below.'},

  {type:'section',label:'6 · Validation / follow-up', hint:'investigate the hypothesis later'},
  {name:'validationStatus',label:'Validation status',type:'select',options:VALIDATION_STATUS,row:'g'},
  {name:'validationMethod',label:'Validation method',type:'select',options:VALIDATION_METHODS,row:'g'},
  {name:'validationAction',label:'Validation action / next step',type:'textarea',rows:2,ph:'e.g. Observe 20 consecutive orders at Station 4 and record how often the operator leaves the station for packing material.',hint:'What should be checked to validate this hypothesis?'},
  {name:'followUpDate',label:'Follow-up date',type:'date',noToday:true},
  {name:'validationResult',label:'Validation result — what did the validation show?',type:'textarea',rows:2,hint:'Complete later, after investigating. This becomes the evidence-based conclusion.'},

  {type:'section',label:'Record'},
  {name:'severity',label:'Severity (optional)',type:'select',options:SEVERITIES.map(s=>s.k),row:'i'},
  {name:'status',label:'Record status',type:'select',options:OBS_STATUS,row:'i'},
];
let obsFormAtt=[];   // attachments being edited in the open observation form
function openObsForm(existing){
  obsFormAtt = (existing && Array.isArray(existing.attachments)) ? JSON.parse(JSON.stringify(existing.attachments)) : [];
  const fields=OBS_FIELDS(existing);
  openForm({ title: existing?'Edit observation':'New observation', fields,
    values: existing || {date:todayStr(),time:nowTime(),status:'New'},
    saveLabel: existing?'Save':'Add observation',
    afterRender: (root)=>{ wireObsValidation(root, existing); wireObsAttachments(root); },
    onSave:(vals)=>{
      vals.attachments = obsFormAtt.slice();
      if(existing) Store.update('observations',existing.id,vals);
      else Store.insert('observations',{...vals});
      closeModal(); toast('Observation saved'); go();
    }});
}
/* ---- evidence file attachments (stored as data URIs in localStorage) ---- */
const ATT_MAX_BYTES = 1500000;   // ~1.5MB cap for non-image files
function readAsDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }
function compressImage(file, maxDim, quality){ return new Promise(res=>{
  const url=URL.createObjectURL(file); const img=new Image();
  img.onload=()=>{ let w=img.naturalWidth, hgt=img.naturalHeight; const scale=Math.min(1, maxDim/Math.max(w,hgt)); w=Math.round(w*scale); hgt=Math.round(hgt*scale);
    const c=document.createElement('canvas'); c.width=w; c.height=hgt; c.getContext('2d').drawImage(img,0,0,w,hgt);
    URL.revokeObjectURL(url); try{ res(c.toDataURL('image/jpeg', quality)); }catch(e){ res(null); } };
  img.onerror=()=>{ URL.revokeObjectURL(url); res(null); };
  img.src=url;
}); }
async function processObsFiles(files){
  for(const file of files){
    try{
      if(file.type && file.type.startsWith('image/')){
        const dataUrl=await compressImage(file, 1200, 0.7);
        if(dataUrl) obsFormAtt.push({name:file.name, type:'image/jpeg', dataUrl, addedAt:nowISO()});
        else toast('Could not read image '+file.name);
      } else {
        if(file.size>ATT_MAX_BYTES){ toast('“'+file.name+'” is too large to store — use the link field instead'); continue; }
        obsFormAtt.push({name:file.name, type:file.type||'file', dataUrl:await readAsDataURL(file), addedAt:nowISO()});
      }
    }catch(e){ toast('Could not attach '+file.name); }
  }
  renderObsAtt();
}
function renderObsAtt(){
  const box=document.getElementById('att_attachments'); if(!box) return;
  box.innerHTML = obsFormAtt.length ? obsFormAtt.map((a,i)=>`<div class="attitem">
      ${a.type&&a.type.startsWith('image')?`<img src="${a.dataUrl}" alt="" data-attview="${i}" style="cursor:pointer">`:'<span style="font-size:20px">📄</span>'}
      <span class="attname" title="${h(a.name||'file')}">${h(a.name||'file')}</span>
      <button type="button" class="btn sm" data-attview="${i}">View</button>
      <button type="button" class="btn sm danger" data-attrm="${i}">✕</button></div>`).join('')
    : '<div class="hint">No files attached yet.</div>';
  box.querySelectorAll('[data-attrm]').forEach(b=>b.onclick=()=>{ obsFormAtt.splice(+b.dataset.attrm,1); renderObsAtt(); });
  box.querySelectorAll('[data-attview]').forEach(b=>b.onclick=()=>viewAttachment(obsFormAtt[+b.dataset.attview]));
}
/* Browsers block opening data: URLs in a new tab — convert to a blob URL, which is allowed. */
function dataURLtoBlob(dataUrl){
  const [head, b64]=dataUrl.split(',');
  const mime=(head.match(/data:(.*?)(;base64)?$/)||[])[1]||'application/octet-stream';
  const bin=atob(b64||''); const arr=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr],{type:mime});
}
function viewAttachment(a){
  if(!a||!a.dataUrl) return;
  try{ const url=URL.createObjectURL(dataURLtoBlob(a.dataUrl));
    const w=window.open(url,'_blank');
    if(!w) toast('Pop-up blocked — allow pop-ups to view the file');
    setTimeout(()=>URL.revokeObjectURL(url), 60000);
  }catch(e){ toast('Could not open file'); }
}
function wireObsAttachments(root){
  renderObsAtt();
  const inp=root.querySelector('#f_attachments');
  if(inp) inp.onchange=()=>{ if(inp.files&&inp.files.length){ processObsFiles([...inp.files]); inp.value=''; } };
}
/* conditional behaviour: cause → default validation status; status → show/hide result; Yes checkboxes → detail fields */
function wireObsValidation(root, existing){
  const q=id=>root.querySelector('#f_'+id);
  const field=id=>{ const el=q(id); return el?el.closest('.field'):null; };
  const cause=q('cause'), status=q('validationStatus');
  // detail fields shown only when their checkbox is Yes
  [['interruption','interruptionDetail'],['rework','reworkDetail'],['error','errorDetail']].forEach(([cb,det])=>{
    const cbEl=q(cb), detF=field(det); if(!cbEl||!detF) return;
    const upd=()=>{ detF.hidden=!cbEl.checked; if(!cbEl.checked){ const di=q(det); if(di) di.value=''; } };
    cbEl.addEventListener('change',upd); upd();
  });
  // validation status default follows the presence of a Possible Cause, unless the user sets it manually
  let statusTouched = !!(existing && existing.validationStatus);
  if(status) status.addEventListener('change',()=>{ statusTouched=true; toggleResult(); });
  function syncDefault(){
    if(statusTouched || !status) return;
    status.value = (cause && cause.value.trim()) ? 'Pending validation' : 'Not required';
    toggleResult();
  }
  function toggleResult(){
    const resF=field('validationResult'); if(!resF||!status) return;
    resF.hidden = !['Validated','Not confirmed','Partially validated'].includes(status.value);
    const actF=field('validationAction');
    if(actF){ const a=q('validationAction'); if(a) a.style.borderColor = status.value==='Pending validation' ? 'var(--accent)' : ''; }
  }
  if(cause) cause.addEventListener('input', syncDefault);
  syncDefault(); toggleResult();
}
function renderObservations(v){
  const acts=`<button class="btn primary big" id="addObs">＋ Quick Observation</button>`;
  v.innerHTML = pagehead('Daily Observation','A dated journal of what was actually seen. Facts stay separate from interpretation — the “possible cause” field is a hypothesis until validated.',acts)
    + `<div class="card" id="obsSummaryCard" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <b>📄 Daily observation summary</b>
          <input type="date" id="obsSumDate" value="${h(obsSumDate||todayStr())}" style="width:auto;min-height:36px">
          <span class="hint" style="margin:0">Auto-generated from the journal · updates as you add or edit observations</span>
          <button class="btn sm" id="obsSumPrint" style="margin-left:auto">🖨 Print</button>
        </div>
        <div id="obsSummary" style="margin-top:12px"></div>
      </div>`
    + observationsFilters() + `<div id="obsTable"></div>`;
  $('#addObs').onclick=()=>openObsForm();
  $('#obsSumDate').onchange=e=>drawObsSummary(e.target.value);
  $('#obsSumPrint').onclick=()=>window.print();
  wireObsFilters();
  drawObsTable();       // also refreshes the summary
}
let obsSumDate=null;
function fmtDateAl(d){ const p=(d||'').split('-'); return p.length===3?`${p[2]}.${p[1]}.${p[0]}`:d; }
const slAl=items=>{ items=items.filter(Boolean); if(!items.length) return ''; if(items.length===1) return items[0]; return items.slice(0,-1).join(', ')+' dhe '+items[items.length-1]; };
/* metrics for one day, combining observations AND measurements (matjet) */
function dayMetrics(date){
  const obs=Store.col('observations').filter(o=>o.date===date);
  const meas=Store.col('measurements').filter(m=>m.date===date);
  let oInt=0,oRew=0,err=0,withHyp=0,validated=0,pending=0;
  obs.forEach(o=>{ if(o.interruption)oInt++; if(o.rework)oRew++; if(o.error)err++; if(o.cause)withHyp++;
    if(o.validationStatus==='Validated')validated++; if(o.validationStatus==='Pending validation')pending++; });
  let mInt=0,mRew=0,procSec=0,waitSec=0;
  meas.forEach(m=>{ mInt+=m.interruptions||0; mRew+=m.rework||0; procSec+=m.processingSec||0; waitSec+=m.waitingSec||0; });
  const waitMin=waitSec/60 + obs.reduce((a,o)=>a+num(o.waitingMin,0),0);
  const procMin=procSec/60 + obs.reduce((a,o)=>a+num(o.processingMin,0),0);
  const total=waitMin+procMin, activity=obs.length+meas.length;
  const neg=oInt+mInt+oRew+mRew+err;
  return { date, obsN:obs.length, measN:meas.length, activity, interruptions:oInt+mInt, rework:oRew+mRew, errors:err,
    withHyp, validated, pending, waitMin, procMin, waitShare: total>0? waitMin/total*100 : null,
    neg, negRate: activity>0? neg/activity : 0, problems: Store.col('problems').filter(p=>p.dateIdentified===date).length };
}
/* average of prior days that have data — the comparison baseline for trend */
function priorBaseline(d){
  const dates=[...new Set([...Store.col('observations').map(o=>o.date), ...Store.col('measurements').map(m=>m.date)])].filter(x=>x&&x<d);
  const days=dates.map(dayMetrics).filter(m=>m.activity>0);
  if(!days.length) return null;
  const ws=days.filter(m=>m.waitShare!=null);
  return { n:days.length,
    negRate: days.reduce((a,m)=>a+m.negRate,0)/days.length,
    waitShare: ws.length? ws.reduce((a,m)=>a+m.waitShare,0)/ws.length : null };
}
/* Daily narrative summary. The narrative itself is built by shared.js (WODS.buildDailyNarrative — the very same
   code the agent runs for the 21:30 report), so browser and archive never disagree on wording. If the agent has
   archived a report for the day, that snapshot is shown by default (WMS figures keep drifting after the shift);
   "Shiko live" recomputes from current data. Counters, charts and lists sit under a fold. */
function storedReport(d){ return Store.col('dailyReports').find(r=>r.date===d)||null; }
let obsSumLive=false;
function drawObsSummary(date){
  if(date){ obsSumDate=date; obsSumLive=false; }
  const d=obsSumDate||todayStr();
  const box=$('#obsSummary'); if(!box) return;
  const rows=Store.col('observations').filter(o=>o.date===d);
  const stored=storedReport(d);
  const live=WODS.buildDailyNarrative(Store.db,d);
  if(live.empty && !stored){ box.innerHTML=`<div class="empty">Ende s'ka vëzhgime as të dhëna WMS për ${h(fmtDateAl(d))}. Sapo t'i futësh, kjo përmbledhje ndërtohet vetë.</div>`; return; }
  const useStored=!!stored && !obsSumLive;
  const narrative=useStored? stored.html : live.html;

  // ---- detail figures (journal only) ----
  const byType={}, byProc={}, bySev={}, byVal={};
  let withHyp=0,validated=0,pending=0,attCount=0;
  rows.forEach(o=>{
    byType[o.type||'—']=(byType[o.type||'—']||0)+1;
    const pn=procName(o.processId)||'I pacaktuar'; byProc[pn]=(byProc[pn]||0)+1;
    if(o.severity) bySev[o.severity]=(bySev[o.severity]||0)+1;
    if(o.validationStatus && o.validationStatus!=='Not required') byVal[o.validationStatus]=(byVal[o.validationStatus]||0)+1;
    if(o.cause) withHyp++; if(o.validationStatus==='Validated') validated++; if(o.validationStatus==='Pending validation') pending++;
    attCount+=(o.attachments||[]).length;
  });
  const topType=Object.entries(byType).sort((a,b)=>b[1]-a[1]);
  const topProc=Object.entries(byProc).sort((a,b)=>b[1]-a[1]);
  const maxT=Math.max(1,...topType.map(x=>x[1])), maxP=Math.max(1,...topProc.map(x=>x[1]));
  const openHyp=rows.filter(o=>o.cause && (!o.validationStatus || o.validationStatus==='Pending validation'));
  const dueFollow=Store.col('observations').filter(o=>o.followUpDate && o.followUpDate<=d && !['Validated','Not confirmed','Partially validated'].includes(o.validationStatus||''));
  const M=dayMetrics(d); const W=WODS.wmsDayFacts(Store.db,d);

  const genAt=stored? new Date(stored.generatedAt) : null;
  const toolbar=`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      ${stored?`<span class="badge ${useStored?'b-ok':'b-muted'}" title="Gjeneruar nga agjenti">${useStored?'📌 Raport i arkivuar':'Raport i arkivuar'} · ${h(genAt.toLocaleDateString())} ${h(genAt.toTimeString().slice(0,5))}</span>
                <button class="btn sm" id="obsSumToggle">${useStored?'Shiko live':'Shiko të arkivuarin'}</button>`
              :`<span class="badge b-muted">Live · nga të dhënat aktuale</span>`}
      ${Store.onAgent()?`<button class="btn sm" id="obsSumRun" title="Sinkronizon WMS, shton gjetjet automatike dhe arkivon raportin për këtë datë">⚙ Gjenero raportin tani</button>`:''}
      <span class="hint" style="margin:0 0 0 auto">Raporti automatik gjenerohet nga agjenti çdo ditë pas orës ${h((Store.db.wms&&Store.db.wms.dailyReportTime)||'21:30')}.</span>
    </div>`;

  const kpi=(val,lbl,cls)=>`<div style="flex:1;min-width:120px"><div style="font-size:22px;font-weight:800" class="${cls||''}">${val}</div><div class="muted small">${lbl}</div></div>`;
  box.innerHTML=toolbar+narrative+`
    <div class="meta muted small" style="margin-bottom:8px">${useStored?'Arkivuar':'Gjeneruar'} ${h((genAt||new Date()).toLocaleString())} · ${rows.length} vëzhgime më ${h(fmtDateAl(d))}</div>
    <details>
      <summary style="cursor:pointer;font-weight:600;font-size:13px;padding:6px 0">Detajet dhe shifrat</summary>
    <div style="display:flex;gap:14px;flex-wrap:wrap;padding:10px;background:var(--bg2);border-radius:10px;border:1px solid var(--line);margin-top:8px">
      ${kpi(rows.length,'Vëzhgime')}
      ${kpi(withHyp,'Me hipotezë','')}
      ${kpi(pending,'Presin validim', pending?'warn':'')}
      ${kpi(validated,'Të validuara', validated?'ok':'')}
      ${kpi(M.interruptions+'/'+M.rework+'/'+M.errors,'Ndërprerje / ripërpunim / gabim', (M.errors?'crit':''))}
      ${kpi(Math.round(M.procMin)+'m / '+Math.round(M.waitMin)+'m','Procesim / pritje (obs+matje)')}
      ${W&&W.prep?kpi(W.prep,'Porosi të përgatitura (WMS)'):''}
      ${W&&W.outRate!=null?kpi(W.outRate+'%','Check-out / check-in (WMS)', W.outRate<75?'warn':'ok'):''}
    </div>
    ${rows.length?`<div class="grid g-2" style="margin-top:12px">
      <div><h3 style="font-size:12.5px;margin:0 0 6px">Sipas tipit të vëzhgimit</h3>${topType.map(([k,c])=>barRow(k,c,maxT,'var(--accent)')).join('')}</div>
      <div><h3 style="font-size:12.5px;margin:0 0 6px">Sipas procesit</h3>${topProc.map(([k,c])=>barRow(k,c,maxP,'var(--imp)')).join('')}</div>
    </div>`:''}
    ${Object.keys(bySev).length?`<div style="margin-top:10px"><b class="small">Rëndësia:</b> ${SEVERITIES.filter(s=>bySev[s.k]).map(s=>`${sevBadge(s.k)} ${bySev[s.k]}`).join(' &nbsp; ')}</div>`:''}
    ${Object.keys(byVal).length?`<div style="margin-top:6px"><b class="small">Validimi:</b> ${Object.entries(byVal).map(([k,c])=>`<span class="badge b-muted">${h(k)}: ${c}</span>`).join(' ')}</div>`:''}
    ${rows.length?`<h3 style="font-size:12.5px;margin:14px 0 6px">Faktet e vëzhguara <span class="faint">(çka u pa realisht)</span></h3>
    <ul style="margin:0;padding-left:18px">${rows.map(o=>`<li style="margin:3px 0"><span class="etag et-obs">e vëzhguar</span>${h(o.time||'')} ${h(o.what||'')}${o.type?` <span class="faint small">[${h(o.type)}]</span>`:''}${o.auto?` <span class="faint small">· auto</span>`:''}</li>`).join('')}</ul>`:''}
    ${openHyp.length?`<h3 style="font-size:12.5px;margin:14px 0 6px">Hipotezat e hapura <span class="faint">(kërkojnë validim)</span></h3>
      <ul style="margin:0;padding-left:18px">${openHyp.map(o=>`<li style="margin:3px 0"><span class="etag et-hyp">hipotezë</span>${h(o.cause)}${o.validationAction?` <span class="faint small">→ ${h(o.validationAction)}</span>`:''}</li>`).join('')}</ul>`:''}
    ${dueFollow.length?`<div class="note warn" style="margin-top:12px"><b>Follow-up që duhen bërë (deri më ${h(fmtDateAl(d))}):</b><ul style="margin:6px 0 0;padding-left:18px">${dueFollow.map(o=>`<li>${h(fmtDateAl(o.followUpDate))} — ${h((o.what||o.cause||'').slice(0,70))} <span class="faint small">(${h(o.validationStatus||'pending')})</span></li>`).join('')}</ul></div>`:''}
    ${attCount?`<div class="hint" style="margin-top:8px">📎 ${attCount} fajll(a) evidencë bashkëngjitur vëzhgimeve të kësaj dite.</div>`:''}
    </details>`;
  const tg=$('#obsSumToggle'); if(tg) tg.onclick=()=>{ obsSumLive=!obsSumLive; drawObsSummary(); };
  const run=$('#obsSumRun'); if(run) run.onclick=async()=>{
    run.disabled=true; run.textContent='⏳ Po gjenerohet…';
    try{ const r=await fetch('/report/run?date='+encodeURIComponent(d),{method:'POST'}); const j=await r.json();
      if(!r.ok||j.error) throw new Error(j.error||('HTTP '+r.status));
      await Store.pullFromServer(); obsSumLive=false; drawObsTable();
      toast(`Raporti u arkivua · ${j.autoObservations||0} gjetje automatike${j.synced?' · WMS sync ✓':''}`); }
    catch(e){ toast('Gjenerimi dështoi: '+e.message); run.disabled=false; run.textContent='⚙ Gjenero raportin tani'; }
  };
}
let obsFilter={q:'',type:'',status:'',proc:''};
function observationsFilters(){
  return `<div class="filters">
    <input type="text" id="of_q" placeholder="Search text, location, ref…" value="${h(obsFilter.q)}">
    <select id="of_type"><option value="">All types</option>${obsTypeOptions().map(t=>`<option ${obsFilter.type===t?'selected':''}>${t}</option>`).join('')}</select>
    <select id="of_status"><option value="">All statuses</option>${OBS_STATUS.map(t=>`<option ${obsFilter.status===t?'selected':''}>${t}</option>`).join('')}</select>
    <select id="of_proc"><option value="">All processes</option>${activeProcesses().map(p=>`<option value="${p.id}" ${obsFilter.proc===p.id?'selected':''}>${h(p.name)}</option>`).join('')}</select>
  </div>`;
}
function wireObsFilters(){
  $('#of_q').oninput=e=>{obsFilter.q=e.target.value;drawObsTable();};
  $('#of_type').onchange=e=>{obsFilter.type=e.target.value;drawObsTable();};
  $('#of_status').onchange=e=>{obsFilter.status=e.target.value;drawObsTable();};
  $('#of_proc').onchange=e=>{obsFilter.proc=e.target.value;drawObsTable();};
}
function filteredObs(){
  const q=obsFilter.q.toLowerCase();
  return Store.col('observations').filter(o=>{
    if(obsFilter.type&&o.type!==obsFilter.type) return false;
    if(obsFilter.status&&o.status!==obsFilter.status) return false;
    if(obsFilter.proc&&o.processId!==obsFilter.proc) return false;
    if(q){ const blob=[o.what,o.location,o.ref,o.subProcess,o.impact,o.cause,o.staffText,procName(o.processId)].join(' ').toLowerCase(); if(!blob.includes(q)) return false; }
    return true;
  }).sort((a,b)=>(b.date+b.time)<(a.date+a.time)?-1:1);
}
function drawObsTable(){
  const rows=filteredObs();
  $('#obsTable').innerHTML=`<div class="tablewrap"><table>
    <thead><tr><th>Date/Time</th><th>Type</th><th>Process</th><th class="wrap">What happened</th><th>Flags</th><th>Sev</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.length? rows.map(o=>`<tr>
      <td>${h(o.date)}<div class="faint small">${h(o.time)}</div></td>
      <td><span class="badge b-muted">${h(o.type)}</span></td>
      <td>${na(procName(o.processId))}</td>
      <td class="wrap"><span class="etag et-obs">observed</span>${h(o.what)}${o.cause?`<div class="small"><span class="etag et-hyp">hypothesis</span>${h(o.cause)}</div>`:''}${o.validationStatus && o.validationStatus!=='Not required'?`<div class="small"><span class="etag et-data">validation</span>${h(o.validationStatus)}${o.followUpDate?` · follow-up ${h(o.followUpDate)}`:''}${o.validationResult?` · result recorded`:''}</div>`:''}${(o.attachments&&o.attachments.length)||o.evidenceLink?`<div class="small"><span class="etag et-data">evidence</span>${o.evidenceLink&&/^https?:\/\//i.test(o.evidenceLink)?`<a href="${h(o.evidenceLink)}" target="_blank" rel="noopener">link</a> `:(o.evidenceLink?h(o.evidenceLink)+' ':'')}${o.attachments&&o.attachments.length?`📎 ${o.attachments.length} file(s)`:''}</div>`:''}</td>
      <td class="small muted">${[o.interruption?'⏸ int':'',o.rework?'↻ rework':'',o.error?'✕ error':''].filter(Boolean).join('<br>')||'—'}</td>
      <td>${o.severity?sevBadge(o.severity):'—'}</td>
      <td>${statusBadge(o.status)}</td>
      <td><button class="btn sm" data-edit="${o.id}">Edit</button> <button class="btn sm ghost" data-conv="${o.id}" title="Convert to problem">→⚠</button> <button class="btn sm danger" data-del="${o.id}">✕</button></td>
    </tr>`).join('') : emptyRow(8,'No observations yet. Tap “Quick Observation” — it takes under 30 seconds.')}</tbody></table></div>`;
  $$('#obsTable [data-edit]').forEach(b=>b.onclick=()=>openObsForm(Store.get('observations',b.dataset.edit)));
  $$('#obsTable [data-del]').forEach(b=>b.onclick=()=>{ const o=Store.get('observations',b.dataset.del); confirmDelete(o.what.slice(0,40),()=>{Store.remove('observations',o.id);drawObsTable();toast('Deleted');}); });
  $$('#obsTable [data-conv]').forEach(b=>b.onclick=()=>convertObsToProblem(b.dataset.conv));
  if($('#obsSummary')) drawObsSummary();   // keep the daily summary in sync with the journal
}
function convertObsToProblem(id){
  const o=Store.get('observations',id); if(!o) return;
  Store.insert('problems',{ dateIdentified:todayStr(), processId:o.processId, problem:o.what, location:o.location,
    frequency:1, evidence:o.evidence, impact:o.impact, cause:o.cause, severity:o.severity||'Improvement',
    status:'Under validation', relatedObs:[o.id], priorityScore:0 });
  Store.update('observations',id,{status:'Converted to problem'});
  toast('Converted to a register entry'); go();
}

/* =========================================================================
   PROCESS MEASUREMENT TIMER
   =======================================================================*/
/* Multiple concurrent measurement timers — measure several processes in parallel.
   All running timers are persisted (survive reload/update) and each keeps time by wall-clock anchor. */
let timers=[];        // array of concurrent timer objects (persisted under TIMER_KEY)
let timerTick=null;   // single interval handle, cleared on leaving the timer page
function freshTimer(){ return {id:uid('tmr'), running:false, waiting:false, procSec:0, waitSec:0, anchor:null,
  interruptions:0, rework:0, marks:[],
  inputs:{processId:'', employeeId:'', ref:'', packages:null, workers:null, operators:[], orders:null, lines:null, units:null, note:''}}; }
function normalizeTimer(t){ if(!t.id) t.id=uid('tmr'); if(!t.inputs) t.inputs=freshTimer().inputs; return t; }
function loadTimers(){ try{ const raw=JSON.parse(localStorage.getItem(TIMER_KEY));
    if(Array.isArray(raw)) return raw.map(normalizeTimer);
    if(raw && typeof raw==='object') return [normalizeTimer(raw)];   // migrate old single-timer format
  }catch(e){} return []; }
function saveTimers(){ if(timers.length) localStorage.setItem(TIMER_KEY, JSON.stringify(timers)); else localStorage.removeItem(TIMER_KEY); }
/* add real elapsed time since the last anchor to processing or waiting, then re-anchor to now */
function foldOne(t){ if(t.running && t.anchor){ const d=(Date.now()-t.anchor)/1000; if(d>0){ if(t.waiting) t.waitSec+=d; else t.procSec+=d; } t.anchor=Date.now(); } }
function foldAll(){ timers.forEach(foldOne); }
function anyRunning(){ return timers.some(t=>t.running); }

function renderTimer(v){
  v.innerHTML = pipelineStrip('Measure') + pagehead('Process Measurement',
    'Time several processes <b>in parallel</b> — one timer per measurement. Each separates processing from waiting, saves automatically (survives reload/update), and can run at the same time as the others.',
    `<button class="btn primary" id="t_add">＋ Add parallel measurement</button>`)
    + `<div id="timerCards" class="grid g-2" style="margin-bottom:16px"></div>
       <div class="card"><h3>Recent measurements <span class="sub">${Store.col('measurements').length} total</span></h3><div id="measList"></div></div>`;
  drawMeasList();

  // restore persisted timers; catch up real elapsed time for any that were running
  timers = loadTimers();
  const wasRunning = anyRunning();
  if(wasRunning) foldAll();
  if(!timers.length) timers=[freshTimer()];   // always show at least one empty timer
  saveTimers();
  drawTimerCards();
  if(wasRunning){ ensureTick(); toast('Measurement(s) in progress restored — they kept running'); }

  $('#t_add').onclick=()=>{ timers.push(freshTimer()); saveTimers(); drawTimerCards(); };
}
function ensureTick(){
  if(timerTick) return;
  timerTick=setInterval(()=>{
    if(!anyRunning()){ clearInterval(timerTick); timerTick=null; return; }
    foldAll(); saveTimers(); timers.forEach(paintCard);
  },1000);
}
const tid=(k,id)=>document.getElementById(k+'_'+id);
function isReceivingProc(pid){ const p=Store.get('processes',pid); return !!p && p.name==='Receiving'; }
/* show the Packages field only for the Receiving process; clear it otherwise */
function updatePkgVisibility(t){
  const wrap=tid('pkgwrap',t.id), psel=tid('p',t.id); if(!wrap||!psel) return;
  const show=isReceivingProc(psel.value);
  wrap.style.display = show ? '' : 'none';
  // for Receiving, the operator list replaces the single Employee field; hide/show accordingly
  const empF=tid('e',t.id)?tid('e',t.id).closest('.field'):null;
  if(empF) empF.hidden = show;
  if(!show){ let changed=false; ['pk','wk'].forEach(k=>{ const el=tid(k,t.id); if(el && el.value!==''){ el.value=''; changed=true; } });
    if((t.inputs.operators||[]).length){ t.inputs.operators=[]; renderOperators(t); changed=true; }
    if(changed){ snapshotInputs(t); saveTimers(); } }
}
/* keep the Workers-engaged number equal to the number of operator name-slots */
function syncWorkersField(t){ const wk=tid('wk',t.id); const n=(t.inputs.operators||[]).length; t.inputs.workers=n||null; if(wk) wk.value=n||''; }
/* render one dropdown per engaged operator; the count matches Workers engaged */
function renderOperators(t){
  const box=tid('ops',t.id); if(!box) return;
  const ops=t.inputs.operators||[];
  box.innerHTML = ops.length? ops.map((val,i)=>`<div style="display:flex;gap:6px;margin-bottom:6px">
    <select data-op="${t.id}" data-opi="${i}" style="flex:1"><option value="">— operator ${i+1} —</option>${empOpts().map(o=>`<option value="${o.v}" ${val===o.v?'selected':''}>${h(o.l)}</option>`).join('')}</select>
    <button type="button" class="btn sm danger" data-oprm="${t.id}" data-opi="${i}">✕</button></div>`).join('')
    : `<div class="hint" style="margin:2px 0">No operators yet — set “Workers engaged” or press “Add operator”.</div>`;
  box.querySelectorAll(`select[data-op="${t.id}"]`).forEach(s=>s.addEventListener('change',()=>{ t.inputs.operators[+s.dataset.opi]=s.value; snapshotInputs(t); saveTimers(); paintCard(t); }));
  box.querySelectorAll(`[data-oprm="${t.id}"]`).forEach(b=>b.onclick=()=>{ t.inputs.operators.splice(+b.dataset.opi,1); syncWorkersField(t); renderOperators(t); snapshotInputs(t); saveTimers(); paintCard(t); });
}
function valNum(el){ return el&&el.value!==''? num(el.value):null; }
function snapshotInputs(t){
  const g=k=>tid(k,t.id);
  if(!g('p')) return;
  const ops=[...document.querySelectorAll(`select[data-op="${t.id}"]`)].map(s=>s.value);
  const wkVal=valNum(g('wk'));
  t.inputs={ processId:g('p').value, employeeId:(g('e').value||''), ref:g('r').value.trim(),
    packages:valNum(g('pk')), workers:(ops.length?ops.length:wkVal), operators:ops,
    orders:valNum(g('o')), lines:valNum(g('l')), units:valNum(g('u')), note:(g('nt')?g('nt').value.trim():'') };
}
function timerCardHTML(t){
  const id=t.id;
  return `<div class="card" data-timer="${id}">
    <div class="field"><label>Process <span class="req">*</span></label><select id="p_${id}">${activeProcesses().map(p=>`<option value="${p.id}" ${t.inputs.processId===p.id?'selected':''}>${h(p.name)} (${p.category})</option>`).join('')}</select></div>
    <div class="row2"><div class="field"><label>Employee</label><select id="e_${id}"><option value="">—</option>${empOpts().map(o=>`<option value="${o.v}" ${t.inputs.employeeId===o.v?'selected':''}>${h(o.l)}</option>`).join('')}</select></div>
      <div class="field"><label>Order / SKU ref</label><input type="text" id="r_${id}" value="${h(t.inputs.ref||'')}"></div></div>
    <div id="pkgwrap_${id}" style="${isReceivingProc(t.inputs.processId||((activeProcesses()[0]||{}).id))?'':'display:none'}">
      <div class="row2">
        <div class="field"><label>Packages / parcels</label><input type="number" min="0" step="1" id="pk_${id}" value="${t.inputs.packages??''}" placeholder="e.g. 5"></div>
        <div class="field"><label>Workers engaged</label><input type="number" min="1" step="1" id="wk_${id}" value="${t.inputs.workers??''}" placeholder="e.g. 3"></div>
      </div>
      <div class="hint">Received shipments arrive as parcels; one package may contain several orders. <b>Workers engaged</b> gives total labor time = measured time × workers.</div>
      <div class="field" style="margin-top:6px">
        <label>Operators (names) — kept in sync with Workers engaged</label>
        <div id="ops_${id}"></div>
        <button type="button" class="btn sm" id="opadd_${id}">＋ Add operator</button>
      </div>
      <div class="hint" id="lab_${id}" style="display:none"></div>
    </div>
    <div class="row3">
      <div class="field"><label>Orders</label><input type="number" min="0" step="1" id="o_${id}" value="${t.inputs.orders??''}" placeholder="e.g. 3"></div>
      <div class="field"><label>Product types</label><input type="number" min="0" step="1" id="l_${id}" value="${t.inputs.lines??''}"></div>
      <div class="field"><label>Units</label><input type="number" min="0" step="1" id="u_${id}" value="${t.inputs.units??''}"></div>
    </div>
    <div class="field"><label>Note / reason (why it took longer, problems observed…)</label><textarea id="nt_${id}" rows="2" placeholder="e.g. waited for packaging material; printer jam; missing SKU">${h(t.inputs.note||'')}</textarea></div>
    <div class="timerbox">
      <div class="clock" id="c_${id}">00:00</div>
      <div class="state" id="s_${id}">Ready</div>
      <div class="splitbar" id="sp_${id}" style="visibility:hidden"><span class="proc" id="pb_${id}" style="width:50%"></span><span class="wait" id="wb_${id}" style="width:50%"></span></div>
    </div>
    <div class="btnrow" style="justify-content:center">
      <button class="btn ok" id="st_${id}">▶ Start</button>
      <button class="btn" id="wt_${id}" disabled>⏸ Wait</button>
      <button class="btn" id="in_${id}" disabled>⚠ Int</button>
      <button class="btn" id="rw_${id}" disabled>↻ Rework</button>
      <button class="btn" id="pa_${id}" disabled>⏯ Pause</button>
      <button class="btn primary" id="en_${id}" disabled>⏹ End &amp; Save</button>
    </div>
    <div class="btnrow" style="justify-content:center;margin-top:6px"><button class="btn sm ghost" id="ds_${id}">✕ Remove</button></div>
    <div class="hint" id="lv_${id}" style="text-align:center;margin-top:8px"></div>
  </div>`;
}
function paintCard(t){
  const clock=tid('c',t.id); if(!clock) return;
  const tot=t.procSec+t.waitSec;
  clock.textContent=fmtClock(tot);
  const state=tid('s',t.id); state.className='state '+(t.running?(t.waiting?'wait':'run'):'');
  state.textContent= !t.running?(tot>0?'Paused':'Ready'):(t.waiting?'WAITING':'PROCESSING');
  const split=tid('sp',t.id);
  if(tot>0){ split.style.visibility='visible'; const wp=Math.round(t.waitSec/tot*100), pp=100-wp;
    tid('pb',t.id).style.width=pp+'%'; tid('wb',t.id).style.width=wp+'%';
    tid('pb',t.id).textContent=pp>12?pp+'%':''; tid('wb',t.id).textContent=wp>12?wp+'%':''; }
  else split.style.visibility='hidden';
  tid('lv',t.id).innerHTML=`Processing <b style="color:var(--ok)">${fmtMin(t.procSec)}</b> · Waiting <b style="color:var(--warn)">${fmtMin(t.waitSec)}</b> · Int ${t.interruptions} · Rework ${t.rework}`;
  const lab=tid('lab',t.id);
  if(lab){ const w=t.inputs.workers;
    if(isReceivingProc(t.inputs.processId) && w>0 && tot>0){ lab.style.display=''; lab.innerHTML=`⏳ Total labor time: <b>${fmtMin(tot*w)}</b> (${fmtMin(tot)} × ${w} workers)`; }
    else lab.style.display='none'; }
  tid('st',t.id).disabled=t.running; tid('st',t.id).textContent=(!t.running && tot>0)?'▶ Resume':'▶ Start';
  tid('wt',t.id).disabled=!t.running; tid('wt',t.id).textContent=t.waiting?'▶ Resume work':'⏸ Wait';
  tid('in',t.id).disabled=!t.running; tid('rw',t.id).disabled=!t.running;
  const pa=tid('pa',t.id); if(pa) pa.disabled=!t.running;   // pause only while running (Resume is the Start button)
  tid('en',t.id).disabled = !t.running && tot===0;
  tid('ds',t.id).textContent = tot>0 ? '✕ Discard' : '✕ Remove';
}
function drawTimerCards(){
  const box=$('#timerCards'); if(!box) return;
  box.innerHTML = timers.map(timerCardHTML).join('');
  timers.forEach(t=>{
    // persist input edits
    ['p','e','r','pk','o','l','u','nt'].forEach(k=>{ const el=tid(k,t.id); if(el) el.addEventListener('input',()=>{ snapshotInputs(t); saveTimers(); paintCard(t); }); });
    // Workers engaged ↔ operator slots stay in sync
    { const wk=tid('wk',t.id); if(wk) wk.addEventListener('input',()=>{ const n=Math.max(0, Math.floor(num(wk.value)||0));
        const ops=t.inputs.operators||[]; while(ops.length<n) ops.push(''); if(ops.length>n) ops.length=n; t.inputs.operators=ops;
        renderOperators(t); snapshotInputs(t); saveTimers(); paintCard(t); }); }
    { const add=tid('opadd',t.id); if(add) add.onclick=()=>{ t.inputs.operators=t.inputs.operators||[]; t.inputs.operators.push('');
        syncWorkersField(t); renderOperators(t); snapshotInputs(t); saveTimers(); paintCard(t); }; }
    renderOperators(t);
    { const psel=tid('p',t.id); if(psel) psel.addEventListener('change',()=>updatePkgVisibility(t)); updatePkgVisibility(t); }
    tid('st',t.id).onclick=()=>{ if(!t.running){ snapshotInputs(t); t.running=true; if((t.procSec+t.waitSec)===0) t.waiting=false; t.anchor=Date.now(); saveTimers(); ensureTick(); paintCard(t); toast((t.procSec+t.waitSec)>0?'Timer resumed':'Timer running'); } };
    { const pa=tid('pa',t.id); if(pa) pa.onclick=()=>{ if(!t.running) return; foldOne(t); t.running=false; saveTimers(); if(!anyRunning()&&timerTick){clearInterval(timerTick);timerTick=null;} paintCard(t); toast('Paused — clock frozen'); }; }
    tid('wt',t.id).onclick=()=>{ if(!t.running) return; foldOne(t); t.waiting=!t.waiting; t.anchor=Date.now(); if(t.waiting) t.marks.push('wait@'+fmtClock(t.procSec+t.waitSec)); saveTimers(); paintCard(t); };
    tid('in',t.id).onclick=()=>{ if(!t.running) return; foldOne(t); t.interruptions++; saveTimers(); paintCard(t); toast('Interruption logged'); };
    tid('rw',t.id).onclick=()=>{ if(!t.running) return; foldOne(t); t.rework++; saveTimers(); paintCard(t); toast('Rework logged'); };
    tid('en',t.id).onclick=()=>endTimer(t.id);
    tid('ds',t.id).onclick=()=>discardTimer(t.id);
    paintCard(t);
  });
}
function endTimer(id){
  const t=timers.find(x=>x.id===id); if(!t) return;
  foldOne(t); snapshotInputs(t);
  const opsFull=(t.inputs.operators||[]).slice();               // keep length = workers (slots), blanks allowed
  const employeeId = opsFull.find(Boolean) || t.inputs.employeeId;  // for Receiving, primary = first named operator
  const workers = opsFull.length ? opsFull.length : t.inputs.workers;  // number ≡ number of operator slots
  const rec={ date:todayStr(), time:nowTime(), processId:t.inputs.processId, employeeId,
    ref:t.inputs.ref, processingSec:Math.round(t.procSec), waitingSec:Math.round(t.waitSec), totalSec:Math.round(t.procSec+t.waitSec),
    interruptions:t.interruptions, rework:t.rework, packages:t.inputs.packages, workers, operators:opsFull, orders:t.inputs.orders, lines:t.inputs.lines, units:t.inputs.units,
    nextProcessId:'', note:t.inputs.note||'' };
  if(workers>0) rec.laborSec = Math.round(rec.totalSec * workers);   // total person-time, persisted (elapsed × workers)
  if(rec.totalSec<1){ toast('Nothing to save yet'); return; }
  const saved=Store.insert('measurements',rec);
  const wp=rec.totalSec?Math.round(rec.waitingSec/rec.totalSec*100):0;
  const pkh=ratePerHour(rec.packages, rec.processingSec), oph=ratePerHour(rec.orders, rec.processingSec);
  const rateStr = pkh!=null?' · '+pkh+' pkg/h' : (oph!=null?' · '+oph+' orders/h':'');
  toast('Saved · '+fmtMin(rec.totalSec)+' total'+rateStr);
  if(wp>=60) setTimeout(()=>toast(wp+'% of this cycle was non-processing time'),700);
  removeTimer(id);
  drawMeasList(); updateTimerTotalLabel();
  const nextId=referenceNextProc(saved.processId);
  if(nextId) promptContinue(saved, nextId);
}
/* After a measurement, offer to continue with the planned next process (chained flow). */
function promptContinue(saved, nextId){
  const curName=procName(saved.processId), nextName=procName(nextId);
  openModal('Next planned step',
    `<p>Recorded <b>${h(curName)}</b>${saved.ref?` for <b>${h(saved.ref)}</b>`:''}.</p>
     <p>Planned next step: <b>${h(nextName)}</b>. Continue measuring it?</p>
     <div class="hint">“Continue” records the actual transition (${h(curName)} → ${h(nextName)}) and opens a ready timer that carries over the <b>employee, order/SKU ref, orders, product types and units</b> from this step. It won’t auto-start — press Start when ${h(nextName)} actually begins, so any waiting between steps is captured correctly.</div>`,
    `<button class="btn ghost" id="mno">No, done</button><button class="btn primary" id="mcont">▶ Continue with ${h(nextName)}</button>`);
  $('#mno').onclick=closeModal;
  $('#mcont').onclick=()=>{
    Store.update('measurements',saved.id,{nextProcessId:nextId});   // record the actual observed transition
    const nt=freshTimer();
    nt.inputs.processId=nextId; nt.inputs.ref=saved.ref||''; nt.inputs.employeeId=saved.employeeId||'';
    nt.inputs.orders=saved.orders??null; nt.inputs.lines=saved.lines??null; nt.inputs.units=saved.units??null;  // carry over quantities
    timers.push(nt); saveTimers(); drawTimerCards(); drawMeasList();
    closeModal(); toast(nextName+' timer ready — press Start when it begins');
    const card=document.querySelector(`[data-timer="${nt.id}"]`); if(card) card.scrollIntoView({behavior:'smooth',block:'center'});
  };
}
function discardTimer(id){
  const t=timers.find(x=>x.id===id); if(!t) return;
  if((t.procSec+t.waitSec)===0){ removeTimer(id); return; }
  openModal('Discard measurement','<p>Discard this measurement without saving? The elapsed time will be lost.</p>',
    `<button class="btn ghost" id="mcancel">Cancel</button><button class="btn danger" id="mdo">Discard</button>`);
  $('#mcancel').onclick=closeModal;
  $('#mdo').onclick=()=>{ removeTimer(id); closeModal(); toast('Discarded'); };
}
function removeTimer(id){
  timers=timers.filter(x=>x.id!==id);
  if(!timers.length) timers=[freshTimer()];   // keep one empty timer visible
  if(!anyRunning() && timerTick){ clearInterval(timerTick); timerTick=null; }
  saveTimers(); drawTimerCards();
}
function updateTimerTotalLabel(){ const el=$('#measList'); if(el) drawMeasList(); }
/* throughput per hour from a count and active processing seconds; null if not computable */
function ratePerHour(count, procSec){ if(count==null||!procSec||procSec<=0) return null; return Math.round(count/(procSec/3600)*10)/10; }
function drawMeasList(){
  const m=Store.col('measurements').slice(0,12);
  const box=$('#measList'); if(!box) return;
  if(!m.length){ box.innerHTML=`<div class="empty">No measurements yet. Start the timer on a live process.</div>`; return; }
  box.innerHTML=`<div class="tablewrap"><table><thead><tr><th>When</th><th>Process</th><th>Proc</th><th>Wait</th><th>Wait%</th><th>Qty (Pkg/Ord/Types/Units)</th><th>Rate/h</th><th>Next observed step</th><th>Int/Rew</th><th class="wrap">Note / reason</th><th></th></tr></thead>
   <tbody>${m.map(x=>{ const wp=x.totalSec?Math.round(x.waitingSec/x.totalSec*100):0;
     const qty=[x.packages,x.orders,x.lines,x.units].some(v=>v!=null)? `${x.packages??'—'}/${x.orders??'—'}/${x.lines??'—'}/${x.units??'—'}` : '—';
     const pkh=ratePerHour(x.packages,x.processingSec), oph=ratePerHour(x.orders,x.processingSec);
     const rate = pkh!=null?('<b>'+pkh+'</b> pkg') : (oph!=null?('<b>'+oph+'</b> ord') : '—');
     const opNames=(x.operators||[]).map(empName).filter(Boolean);
     const laborSec=(x.laborSec!=null)?x.laborSec:((x.workers>0)?(x.totalSec||0)*x.workers:null);
     return `<tr><td class="small">${h(x.date)} ${h(x.time)}</td><td>${na(procName(x.processId))}${x.workers>0?`<div class="small muted">👥 ${x.workers} workers${opNames.length?` (${h(opNames.join(', '))})`:''} · ${fmtMin(laborSec)} labor</div>`:''}</td>
      <td>${fmtMin(x.processingSec)}</td><td style="color:var(--warn)">${fmtMin(x.waitingSec)}</td>
      <td>${wp>=60?`<span class="badge b-warn">${wp}%</span>`:wp+'%'}</td>
      <td class="small">${qty}</td><td class="small">${rate}</td>
      <td>${nextStepSelectHTML(x.nextProcessId, x.id)}</td>
      <td class="small muted">${x.interruptions}/${x.rework}</td>
      <td class="wrap"><input type="text" class="small" style="min-height:32px;padding:5px 8px;min-width:160px" data-note="${x.id}" value="${h(x.note||'')}" placeholder="add reason…"></td>
      <td style="white-space:nowrap"><button class="btn sm" data-me="${x.id}">Edit</button> <button class="btn sm danger" data-dm="${x.id}">✕</button></td></tr>`;}).join('')}</tbody></table></div>
   <div class="hint" style="margin-top:6px">Forgot to enter quantities during timing? Use <b>Edit</b> to add or change Packages / Orders / Product types / Units (and process, ref, times). “Next observed step” and “Note / reason” can also be edited inline here anytime.</div>`;
  $$('#measList [data-dm]').forEach(b=>b.onclick=()=>{ Store.remove('measurements',b.dataset.dm); drawMeasList(); });
  $$('#measList [data-me]').forEach(b=>b.onclick=()=>openMeasEditForm(Store.get('measurements',b.dataset.me)));
  $$('#measList [data-next]').forEach(sel=>sel.onchange=()=>{ Store.update('measurements',sel.dataset.next,{nextProcessId:sel.value}); toast('Next step recorded'); });
  $$('#measList [data-note]').forEach(inp=>inp.onchange=()=>{ Store.update('measurements',inp.dataset.note,{note:inp.value.trim()}); toast('Note saved'); });
}
/* edit a saved measurement — add forgotten quantities, fix process/ref, adjust times */
function openMeasEditForm(m){
  if(!m) return;
  const fields=[
    {name:'processId',label:'Process',type:'select',options:procOpts(),required:true,row:'a'},
    {name:'employeeId',label:'Employee',type:'select',options:empOpts(),row:'a'},
    {name:'ref',label:'Order / SKU ref',type:'text',row:'b'},
    {name:'packages',label:'Packages / parcels',type:'number',row:'f'},
    {name:'workers',label:'Workers engaged',type:'number',row:'f',hint:'Receiving: total labor time = measured time × workers.'},
    {name:'orders',label:'Orders',type:'number',row:'c'},
    {name:'lines',label:'Product types',type:'number',row:'c'},
    {name:'units',label:'Units',type:'number',row:'c'},
    {name:'processingMin',label:'Processing (min)',type:'number',step:'0.1',row:'d'},
    {name:'waitingMin',label:'Waiting (min)',type:'number',step:'0.1',row:'d'},
    {name:'interruptions',label:'Interruptions',type:'number',row:'e'},
    {name:'rework',label:'Rework',type:'number',row:'e'},
    {name:'note',label:'Note / reason',type:'textarea',rows:2},
  ];
  const values={...m, processingMin: m.processingSec!=null?Math.round(m.processingSec/60*10)/10:'', waitingMin: m.waitingSec!=null?Math.round(m.waitingSec/60*10)/10:''};
  openForm({ title:'Edit measurement', fields, values, saveLabel:'Save changes',
    onSave:(vals)=>{
      const patch={ processId:vals.processId, employeeId:vals.employeeId, ref:vals.ref,
        packages:vals.packages, workers:vals.workers, orders:vals.orders, lines:vals.lines, units:vals.units,
        interruptions:vals.interruptions!=null?vals.interruptions:0, rework:vals.rework!=null?vals.rework:0,
        note:vals.note };
      if(vals.processingMin!=null||vals.waitingMin!=null){
        const ps=Math.round(num(vals.processingMin)*60), ws=Math.round(num(vals.waitingMin)*60);
        patch.processingSec=ps; patch.waitingSec=ws; patch.totalSec=ps+ws;
      }
      // keep total labor time (person-time) consistent with edited workers/times
      const totalSec = patch.totalSec!=null ? patch.totalSec : m.totalSec;
      patch.laborSec = (patch.workers>0) ? Math.round((totalSec||0)*patch.workers) : null;
      Store.update('measurements',m.id,patch);
      closeModal(); drawMeasList(); toast('Measurement updated');
    }});
}
/* dropdown for the observed transition after a measured step */
function nextStepSelectHTML(current, id){
  const opts=activeProcesses().map(p=>`<option value="${p.id}" ${current===p.id?'selected':''}>${h(p.name)}</option>`).join('');
  return `<select class="small" style="min-height:34px;padding:5px 8px" data-next="${id}">
    <option value="">— not recorded —</option>${opts}
    <option value="${NEXT_END}" ${current===NEXT_END?'selected':''}>▣ Ended / Dispatched</option>
    <option value="${NEXT_EXCEPTION}" ${current===NEXT_EXCEPTION?'selected':''}>⚠ Exception</option></select>`;
}

/* =========================================================================
   ORDER FLOW OBSERVATION
   =======================================================================*/
function renderOrders(v){
  v.innerHTML = pagehead('Order Flow Observation',
    'Track a real order through Claim → Picking → Check-out/Packing → Boxing → Dispatch. Record a timestamp at each stage; durations and waiting between stages are computed automatically.',
    `<button class="btn primary" id="addOrder">＋ New order</button>`)
    + `<div id="ordersBody"></div>`;
  $('#addOrder').onclick=()=>openOrderForm();
  drawOrders();
}
function openOrderForm(existing){
  const fields=[
    {name:'orderRef',label:'Order reference',type:'text',required:true,row:'a'},
    {name:'date',label:'Date',type:'date',required:true,row:'a'},
    {name:'lines',label:'Product types',type:'number',row:'b'},
    {name:'units',label:'Units',type:'number',row:'b'},
    {name:'picker',label:'Picker / owner',type:'select',options:empOpts(),row:'b'},
    {name:'seller',label:'Seller(s) / source',type:'text',ph:'e.g. Seller A + Seller B',row:'c'},
    {name:'fulfillment',label:'Fulfillment path',type:'select',options:FULFILLMENT_TYPES,row:'c',hint:'How the order was fulfilled. Split = part picked from stock, part cross-docked straight to check-out.'},
    {name:'note',label:'Note',type:'text',ph:'e.g. late items from Seller B staged to check-out; early items picked from racks'},
  ];
  openForm({title: existing?'Edit order':'New order flow', fields, values: existing||{date:todayStr()},
    onSave:(vals)=>{
      if(existing) Store.update('orders',existing.id,vals);
      else Store.insert('orders',{...vals, stamps:{}});
      closeModal(); drawOrders(); toast('Order saved');
    }});
}
function drawOrders(){
  const orders=Store.col('orders');
  const box=$('#ordersBody');
  if(!orders.length){ box.innerHTML=`<div class="card"><div class="empty">No orders tracked yet. Add one and stamp each stage as it happens.</div></div>`; return; }
  box.innerHTML = orders.map(o=>orderCard(o)).join('') + orderCompareCard();
  orders.forEach(o=>{
    ORDER_STAGES.forEach(st=>{ const b=$(`#stamp_${o.id}_${cssId(st)}`); if(b) b.onclick=()=>stampOrder(o.id,st); });
    $(`#oedit_${o.id}`).onclick=()=>openOrderForm(o);
    $(`#odel_${o.id}`).onclick=()=>confirmDelete(o.orderRef,()=>{Store.remove('orders',o.id);drawOrders();});
  });
}
const cssId=s=>s.replace(/[^a-z0-9]/gi,'');
function orderCard(o){
  const stamps=o.stamps||{};
  const stageRows=ORDER_STAGES.map((st,i)=>{
    const t=stamps[st];
    let dur='—';
    if(i>0){ const prev=stamps[ORDER_STAGES[i-1]]; if(prev&&t){ const d=(new Date(t)-new Date(prev))/1000; dur=d>=0?fmtMin(d):'⚠'; } }
    return `<tr><td>${h(st)}</td><td>${t?h(new Date(t).toLocaleString()):'<span class="na">not stamped</span>'}</td>
      <td class="muted">${i===0?'<span class="faint">start</span>':dur}</td>
      <td><button class="btn sm ${t?'':'primary'}" id="stamp_${o.id}_${cssId(st)}">${t?'Re-stamp':'Stamp now'}</button></td></tr>`;
  }).join('');
  // key intervals
  const iv=(a,b)=>{ const x=stamps[a],y=stamps[b]; if(!x||!y) return '—'; const d=(new Date(y)-new Date(x))/1000; return d>=0?fmtMin(d):'⚠'; };
  const isSplit = o.fulfillment==='Split — stock + cross-dock';
  const isCross = o.fulfillment && o.fulfillment.startsWith('Cross-dock');
  const fBadge = o.fulfillment? `<span class="badge ${isSplit?'b-imp':(isCross?'b-new':'b-muted')}">${h(o.fulfillment)}</span>`:'';
  return `<div class="card" style="margin-bottom:14px">
    <h3>🧾 ${h(o.orderRef)} <span class="sub">${h(o.date)} · ${o.lines||'—'} types · ${o.units||'—'} units · ${h(empName(o.picker))||'no owner'}</span></h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      ${o.seller?`<span class="small muted">🏷 ${h(o.seller)}</span>`:''} ${fBadge}
    </div>
    ${(isSplit||isCross)?`<div class="note">${isSplit?'Split order — part <b>picked from stock</b> (received earlier, mapped & stored), part <b>cross-docked</b> straight to check-out.':'Cross-dock — items go straight to check-out.'} Skipped stages (mapping / put-away / storage, or picking) are <b>expected here, not missing data</b>.</div>`:''}
    ${o.note?`<div class="small muted" style="margin-bottom:8px">📝 ${h(o.note)}</div>`:''}
    <div class="tablewrap" style="margin-bottom:10px"><table><thead><tr><th>Stage</th><th>Timestamp</th><th>Duration from prev</th><th></th></tr></thead><tbody>${stageRows}</tbody></table></div>
    <div class="flowstrip">
      ${ORDER_STAGES.slice(1).map((st,i)=>`<span>${h(ORDER_STAGES[i])}→${h(st)} <b>${iv(ORDER_STAGES[i],st)}</b></span>`).join('')}
      <span class="on">Total <b>${iv(ORDER_STAGES[0],ORDER_STAGES[ORDER_STAGES.length-1])}</b></span>
    </div>
    <div class="btnrow" style="margin-top:10px"><button class="btn sm" id="oedit_${o.id}">Edit</button><button class="btn sm danger" id="odel_${o.id}">Delete</button></div>
  </div>`;
}
function stampOrder(id,stage){
  const o=Store.get('orders',id); const stamps={...(o.stamps||{})}; stamps[stage]=nowISO();
  Store.update('orders',id,{stamps}); drawOrders(); toast(stage+' stamped');
}
function orderCompareCard(){
  const orders=Store.col('orders').filter(o=>o.stamps&&o.stamps.Claim&&o.stamps.Dispatch);
  if(orders.length<2) return '';
  const max=Math.max(...orders.map(o=>(new Date(o.stamps.Dispatch)-new Date(o.stamps.Claim))/1000));
  return `<div class="card"><h3>Order comparison <span class="sub">total observed fulfillment time</span></h3>
    ${orders.map(o=>{ const d=(new Date(o.stamps.Dispatch)-new Date(o.stamps.Claim))/1000; return barRow(o.orderRef,d,max,'var(--accent)',fmtMin(d)); }).join('')}</div>`;
}

/* =========================================================================
   PRODUCT / INBOUND FLOW
   =======================================================================*/
function renderInbound(v){
  v.innerHTML = pagehead('Product / Inbound Flow',
    'Track a product or batch through Arrival → Receiving → Check-in → Verification → Mapping → Put-away → Storage. Records discrepancies and compares system vs physical location.',
    `<button class="btn primary" id="addProd">＋ New batch</button>`)
    + `<div id="inbBody"></div>`;
  $('#addProd').onclick=()=>openProdForm();
  drawInbound();
}
function openProdForm(existing){
  const fields=[
    {name:'sku',label:'SKU',type:'text',required:true,row:'a'},
    {name:'desc',label:'Description',type:'text',row:'a'},
    {name:'date',label:'Date',type:'date',required:true,row:'b'},
    {name:'packages',label:'Packages / parcels',type:'number',row:'b',hint:'International shipments arrive as packages; one package may hold several orders.'},
    {name:'ordersInside',label:'Orders inside',type:'number',row:'b'},
    {name:'qtyExpected',label:'Qty expected (units)',type:'number',row:'e'},
    {name:'qtyReceived',label:'Qty received (units)',type:'number',row:'e'},
    {name:'physicalLoc',label:'Physical location',type:'text',row:'c'},
    {name:'systemLoc',label:'System location',type:'text',row:'c'},
    {name:'seller',label:'Seller / source',type:'text',row:'d'},
    {name:'handling',label:'Handling',type:'select',options:INBOUND_HANDLING,row:'d',hint:'Cross-dock = staged straight to check-out (skips storage). Staged = waiting for the rest of a split order.'},
    {name:'orderRef',label:'Belongs to order (ref)',type:'text',ph:'link to a split order, optional'},
    {name:'discrepancy',label:'Discrepancy',type:'select',options:DISCREPANCIES},
    {name:'note',label:'Note',type:'text'},
  ];
  openForm({title:existing?'Edit batch':'New inbound batch', fields, values:existing||{date:todayStr()},
    onSave:(vals)=>{
      if(existing) Store.update('products',existing.id,vals);
      else Store.insert('products',{...vals, stamps:{}});
      closeModal(); drawInbound(); toast('Batch saved');
    }});
}
function drawInbound(){
  const items=Store.col('products'); const box=$('#inbBody');
  if(!items.length){ box.innerHTML=`<div class="card"><div class="empty">No inbound batches tracked yet.</div></div>`; return; }
  box.innerHTML=items.map(p=>inboundCard(p)).join('');
  items.forEach(p=>{
    INBOUND_STAGES.forEach(st=>{ const b=$(`#istamp_${p.id}_${cssId(st)}`); if(b) b.onclick=()=>{ const s={...(p.stamps||{})}; s[st]=nowISO(); Store.update('products',p.id,{stamps:s}); drawInbound(); toast(st+' stamped'); }; });
    $(`#pedit_${p.id}`).onclick=()=>openProdForm(p);
    $(`#pdel_${p.id}`).onclick=()=>confirmDelete(p.sku,()=>{Store.remove('products',p.id);drawInbound();});
  });
}
function inboundCard(p){
  const stamps=p.stamps||{};
  const qtyMismatch = p.qtyExpected!=null && p.qtyReceived!=null && p.qtyExpected!==p.qtyReceived;
  const locMismatch = p.physicalLoc && p.systemLoc && p.physicalLoc!==p.systemLoc;
  const flags=[];
  if(p.discrepancy) flags.push(p.discrepancy);
  if(qtyMismatch) flags.push('Quantity mismatch ('+p.qtyExpected+'→'+p.qtyReceived+')');
  if(locMismatch) flags.push('Location mismatch');
  const chips=INBOUND_STAGES.map((st,i)=>{
    const t=stamps[st]; let dur=''; if(i>0){ const prev=stamps[INBOUND_STAGES[i-1]]; if(prev&&t){ const d=(new Date(t)-new Date(prev))/1000; dur=' · '+(d>=0?fmtMin(d):'⚠'); } }
    return `<span class="${t?'on':''}" style="cursor:pointer" id="istamp_${p.id}_${cssId(st)}" title="Stamp">${h(st)}${t?dur:''}</span>`;
  }).join('<i>›</i>');
  const isCross = p.handling && p.handling.startsWith('Cross-dock');
  const hBadge = p.handling? `<span class="badge ${isCross?'b-new':(p.handling.startsWith('Staged')?'b-warn':'b-muted')}">${h(p.handling)}</span>`:'';
  return `<div class="card" style="margin-bottom:14px">
    <h3>📦 ${h(p.sku)} <span class="sub">${h(p.desc||'')} · ${h(p.date)}</span></h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      ${p.seller?`<span class="small muted">🏷 ${h(p.seller)}</span>`:''} ${hBadge} ${p.orderRef?`<span class="small muted">→ order ${h(p.orderRef)}</span>`:''}
    </div>
    <div class="flowstrip">${chips}</div>
    ${isCross?`<div class="note" style="margin-top:8px">Cross-dock — staged straight to check-out. Mapping / put-away / storage are <b>expected to be skipped</b>, not missing data.</div>`:''}
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;margin-top:8px" class="muted">
      ${p.packages!=null?`<span>Packages: <b>${p.packages}</b>${p.ordersInside!=null?` (${p.ordersInside} orders)`:''}</span>`:''}
      <span>Qty exp/rec: <b>${p.qtyExpected??'—'} / ${p.qtyReceived??'—'}</b></span>
      <span>Physical: <b>${na(p.physicalLoc)}</b></span>
      <span>System: <b>${na(p.systemLoc)}</b></span>
    </div>
    ${flags.length?`<div class="note crit" style="margin-top:8px"><span class="etag et-data">discrepancy</span>${flags.map(h).join(' · ')}</div>`:''}
    <div class="btnrow" style="margin-top:10px"><button class="btn sm" id="pedit_${p.id}">Edit</button><button class="btn sm danger" id="pdel_${p.id}">Delete</button></div>
  </div>`;
}

/* =========================================================================
   PROCESS MAPS (generated current-state)
   =======================================================================*/
function renderMaps(v){
  v.innerHTML = pagehead('Current-State Process Maps',
    'Generated from collected data only. Where data has not been captured, the map shows <b>“Data not yet available”</b> — it never invents values.')
    + `<div class="note">These describe the <b>CURRENT STATE</b> (how the warehouse works today). Future-state design belongs in the reports, kept separate.</div>`
    + processMapCard('Inbound', ['Receiving','Check-in','Mapping'])
    + processMapCard('Outbound', ['Claim','Picking','Packing/Check-out','Boxing']);
}
function processMapCard(cat, stageNames){
  const rows=stageNames.map(name=>{
    const p=activeProcesses().find(x=>x.name===name);
    const meas=Store.col('measurements').filter(m=>procName(m.processId)===name);
    const avgP=meas.length? meas.reduce((a,m)=>a+m.processingSec,0)/meas.length:null;
    const avgW=meas.length? meas.reduce((a,m)=>a+m.waitingSec,0)/meas.length:null;
    const errs=Store.col('observations').filter(o=>procName(o.processId)===name&&o.error).length;
    const probs=Store.col('problems').filter(pr=>procName(pr.processId)===name&&!['Resolved','Rejected'].includes(pr.status));
    const owner=ownerFor(name,'Primary'), backup=ownerFor(name,'Backup');
    const bottleneck = avgW!=null && avgP!=null && avgW>avgP;
    return `<tr>
      <td><b>${h(name)}</b></td>
      <td>${owner||'<span class="na">Data not yet available</span>'}</td>
      <td>${backup||'<span class="na">—</span>'}</td>
      <td>${avgP!=null?fmtMin(avgP):'<span class="na">Data not yet available</span>'}</td>
      <td style="color:var(--warn)">${avgW!=null?fmtMin(avgW):'<span class="na">—</span>'}</td>
      <td>${errs||'—'}</td>
      <td>${bottleneck?'<span class="badge b-imp">⚠ wait&gt;proc</span>':(probs.length?`<span class="badge b-warn">${probs.length} issue(s)</span>`:'—')}</td>
    </tr>`;
  }).join('');
  return `<div class="card" style="margin-bottom:14px"><h3>${cat} process map <span class="sub">current state</span></h3>
    <div class="tablewrap"><table><thead><tr><th>Step</th><th>Owner</th><th>Backup</th><th>Avg processing</th><th>Avg waiting</th><th>Errors</th><th>Signal</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}
function ownerFor(procName_, role){
  const p=activeProcesses().find(x=>x.name===procName_); if(!p) return '';
  const sk=Store.col('staffSkills').find(s=>s.processId===p.id && (s.roles||[]).includes(role));
  return sk? empName(sk.employeeId):'';
}

/* =========================================================================
   ACTUAL PROCESS FLOW  (derived from real measurements — the source of truth
   for Current State). Reference sequences are only what we expect; here we show
   what was actually observed.
   =======================================================================*/
/* Reconstruct observed journeys by grouping measurements that share an order/SKU ref,
   ordered by time. Each distinct sequence of processes is one Actual Observed Flow. */
function computeActualFlows(inRange){
  let meas=Store.col('measurements').filter(m=>m.ref && String(m.ref).trim()!=='');
  if(inRange) meas=meas.filter(m=>inRange(m.date));
  const byRef={}; meas.forEach(m=>{ (byRef[m.ref]=byRef[m.ref]||[]).push(m); });
  const patterns={}; let journeys=0;
  Object.values(byRef).forEach(steps=>{
    steps.sort((a,b)=>(a.date+a.time)<(b.date+b.time)?-1:1);
    const seq=steps.map(s=>procName(s.processId)||'?');
    const last=steps[steps.length-1];
    if(last.nextProcessId===NEXT_END) seq.push('▣ Dispatched/Customer');
    else if(last.nextProcessId===NEXT_EXCEPTION) seq.push('⚠ Exception');
    else if(last.nextProcessId && procName(last.nextProcessId)) seq.push(procName(last.nextProcessId));
    const key=seq.join(' → ');
    const cyc=steps.reduce((a,s)=>a+(s.totalSec||0),0);
    const wait=steps.reduce((a,s)=>a+(s.waitingSec||0),0);
    const repeated = new Set(steps.map(s=>s.processId)).size < steps.length;
    const p=patterns[key]||(patterns[key]={seq,count:0,cyc:0,wait:0,steps:steps.length,repeated:false});
    p.count++; p.cyc+=cyc; p.wait+=wait; if(repeated) p.repeated=true;
    journeys++;
  });
  const flows=Object.values(patterns).map(p=>({seq:p.seq, count:p.count, pct: journeys?p.count/journeys*100:0,
    avgCycleSec:p.cyc/p.count, avgWaitSec:p.wait/p.count, steps:p.steps, repeated:p.repeated}))
    .sort((a,b)=>b.count-a.count);
  const noRef=Store.col('measurements').filter(m=>!(m.ref&&String(m.ref).trim())).length;
  return {flows, journeys, noRef};
}
/* Transitions: Current Process -> Next observed process, from recorded nextProcessId. */
function computeTransitions(){
  const edges={};
  Store.col('measurements').forEach(m=>{ if(!m.nextProcessId) return;
    const from=procName(m.processId)||'?'; const to=nextStepLabel(m.nextProcessId)||'?';
    const key=from+' → '+to; const e=edges[key]||(edges[key]={from,to,count:0,fromProc:0,fromWait:0});
    e.count++; e.fromProc+=m.processingSec||0; e.fromWait+=m.waitingSec||0; });
  return Object.values(edges).map(e=>({...e, avgFromProc:e.fromProc/e.count, avgFromWait:e.fromWait/e.count})).sort((a,b)=>b.count-a.count);
}
function flowChainHTML(seq){
  return `<span class="flowstrip" style="display:inline-flex;margin:0">${seq.map(s=>{
    const cls = s.startsWith('▣')?'on':(s.startsWith('⚠')?'':'');
    return `<span class="${cls}" style="${s.startsWith('⚠')?'color:var(--crit)':''}">${h(s)}</span>`;
  }).join('<i>›</i>')}</span>`;
}
function renderActualFlows(v){
  const {flows, journeys, noRef}=computeActualFlows();
  const trans=computeTransitions();
  const byType={}; FLOW_TYPES.forEach(t=>byType[t]=activeProcesses().filter(p=>(p.flowType||defaultFlowType(p.name))===t));
  v.innerHTML = pagehead('Actual Process Flow',
    'How the warehouse <b>actually</b> flowed, derived from real measurements — the source of truth for Current State. This is separate from the <b>reference</b> sequences (what we expect). Variation is labelled <b>Observed Process Variation</b>, not a problem, until you validate it.')
  + `<div class="note">The warehouse does not have to follow one fixed sequence. A journey that goes Receiving → Check-in → Check-out → Boxing → Dispatch is just as valid as Receiving → Check-in → Mapping → Put-away → Storage. A step that did not occur is <b>not missing data</b>.</div>`

  + `<div class="card" style="margin-bottom:14px"><h3>Actual Observed Flows <span class="sub">grouped by order/SKU ref · ${journeys} journey(s)</span></h3>`
  + (flows.length? `<div class="tablewrap"><table><thead><tr><th class="wrap">Observed sequence</th><th>Obs</th><th>%</th><th>Avg cycle</th><th>Avg waiting</th><th>Notes</th></tr></thead>
     <tbody>${flows.map((f,i)=>`<tr>
        <td class="wrap"><b class="faint">Flow ${i+1}</b><br>${flowChainHTML(f.seq)}</td>
        <td><b>${f.count}</b></td><td>${Math.round(f.pct)}%</td>
        <td>${f.avgCycleSec?fmtDur(f.avgCycleSec):'<span class="na">—</span>'}</td>
        <td style="color:var(--warn)">${f.avgWaitSec?fmtDur(f.avgWaitSec):'—'}</td>
        <td class="small">${f.repeated?'<span class="badge b-warn">repeated step</span>':''}${f.steps===1?'<span class="faint">single step</span>':''}</td>
      </tr>`).join('')}</tbody></table></div>
      <div class="hint" style="margin-top:6px"><span class="etag et-data">observed variation</span> Different sequences here are real paths the warehouse took — not errors.${noRef?` ${noRef} measurement(s) have no order/SKU ref, so they cannot be joined into a journey yet.`:''}</div>`
     : `<div class="empty">No multi-step journeys yet. Enter the same <b>order/SKU ref</b> on the measurements that belong to one journey, and set “Next observed step”. Flows appear here automatically.</div>`)
  + `</div>`

  + `<div class="card" style="margin-bottom:14px"><h3>Observed transitions <span class="sub">Current → Next actual step</span></h3>`
  + (trans.length? `<div class="tablewrap"><table><thead><tr><th>From</th><th></th><th>To (actual)</th><th>Times</th><th>Avg proc (from)</th><th>Avg wait (from)</th></tr></thead>
     <tbody>${trans.map(e=>`<tr><td>${h(e.from)}</td><td class="faint">→</td><td>${h(e.to)}</td><td><b>${e.count}</b></td>
        <td>${fmtDur(e.avgFromProc)}</td><td style="color:var(--warn)">${fmtDur(e.avgFromWait)}</td></tr>`).join('')}</tbody></table></div>
      <div class="hint" style="margin-top:6px">Supports skipped steps, alternative paths, repeats, branching, merging, termination and exceptions — whatever was actually recorded.</div>`
     : `<div class="empty">No transitions recorded yet. On the Process Measurement page, set “Next observed step” on a measurement.</div>`)
  + `</div>`

  + `<div class="card"><h3>Process classification <span class="sub">configurable</span></h3>
     <div class="grid g-2">${FLOW_TYPES.map(t=>`<div><span class="badge ${FLOW_TYPE_BADGE[t]}">${t}</span>
        <div class="small muted" style="margin-top:4px">${byType[t].map(p=>h(p.name)).join(', ')||'<span class="na">none</span>'}</div></div>`).join('')}</div>
     <div class="hint" style="margin-top:8px">${flowTypeLegend()} Change any classification in <a href="#config">Configuration</a>.</div></div>`;
}
function flowTypeLegend(){ return 'Measured = actively timed · Linked = may connect to another · Conditional = only in some flows · Exception = recorded when relevant.'; }
/* compact Actual Observed Flows block for reports */
function reportFlowsBlock(inRange){
  const {flows, journeys}=computeActualFlows(inRange);
  if(!flows.length) return `<h3>Actual observed flows</h3><p class="na">No multi-step journeys captured yet (needs shared order/SKU refs across measurements).</p>`;
  return `<h3>Actual observed flows <span class="meta">(source of truth for current state · ${journeys} journeys)</span></h3>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Observed sequence</th><th>Obs</th><th>%</th><th>Avg cycle</th></tr></thead>
    <tbody>${flows.slice(0,6).map((f,i)=>`<tr><td>${i+1}</td><td><span class="etag et-data">observed</span>${h(f.seq.join(' → '))}</td><td>${f.count}</td><td>${Math.round(f.pct)}%</td><td>${f.avgCycleSec?fmtDur(f.avgCycleSec):'—'}</td></tr>`).join('')}</tbody></table></div>
    <p class="meta">Observed Process Variation — different sequences are real paths, not errors.</p>`;
}

/* =========================================================================
   STAFF CAPABILITY MATRIX
   =======================================================================*/
function skillFor(empId,procId){ return Store.col('staffSkills').find(s=>s.employeeId===empId&&s.processId===procId); }
function hasSkillData(procId){ return Store.col('staffSkills').some(s=>s.processId===procId); }
/* operational processes shown in the capability matrix: Inbound/Outbound plus Inventory */
function matrixProcesses(){ return activeProcesses().filter(p=>['Inbound','Outbound'].includes(p.category) || p.name==='Inventory'); }
/* processes with capability data captured, so gaps are real findings not "not yet observed" */
function spofRisks(){
  const emps=Store.col('employees').filter(e=>e.active!==false);
  const risks=[];
  matrixProcesses().filter(p=>hasSkillData(p.id)).forEach(p=>{
    const comp=emps.filter(e=>{const s=skillFor(e.id,p.id);return s&&s.level>=3;});
    if(comp.length===0) risks.push({name:p.name, n:0, who:'', crit:true});
    else if(comp.length===1) risks.push({name:p.name, n:1, who:comp[0].name, crit:false});
  });
  return risks;
}
function renderMatrix(v){
  const procs=matrixProcesses();
  const emps=Store.col('employees').filter(e=>e.active!==false);
  v.innerHTML = pagehead('Staff Capability Matrix',
    'Who can do what. Click a cell to set skill level. The system flags <b>single points of failure</b> automatically. This is a capability map — <b>not</b> a performance评估 during the observation phase.',
    `<button class="btn" id="addEmp">＋ Employee</button>`)
    + spofPanel()
    + `<div class="tablewrap"><table class="matrix"><thead><tr><th class="emp">Employee</th>${procs.map(p=>`<th title="${p.category}">${h(p.name)}</th>`).join('')}</tr></thead>
       <tbody>${emps.length? emps.map(e=>`<tr><td class="emp">${h(e.name)}<div class="faint small">${h(e.role||'')}</div></td>
         ${procs.map(p=>{ const s=skillFor(e.id,p.id); const lv=s?s.level:0;
           return `<td style="padding:4px"><div class="lvl lvl${lv}" data-cell="${e.id}|${p.id}" title="${SKILL_LEVELS[lv]}">${lv}</div></td>`; }).join('')}
         </tr>`).join('') : emptyRow(procs.length+1,'No employees. Add one to build the matrix.')}</tbody></table></div>
    <div class="hint" style="margin-top:8px">Levels: 0 Not trained · 1 Learning · 2 Basic · 3 Competent · 4 Advanced · 5 Trainer. Roles (Primary/Backup/Trainer/Training required) set per cell.</div>`;
  $('#addEmp').onclick=()=>openEmpForm();
  $$('[data-cell]').forEach(c=>c.onclick=()=>openSkillCell(...c.dataset.cell.split('|')));
}
function openEmpForm(existing){
  const fields=[
    {name:'name',label:'Name',type:'text',required:true,row:'a'},
    {name:'role',label:'Role / title',type:'text',row:'a'},
    {name:'shift',label:'Shift',type:'select',options:['Day','Evening','Night'],row:'b'},
    {name:'active',label:'Active',type:'checkbox',cbLabel:'Currently active',value:true,row:'b'},
  ];
  openForm({title:existing?'Edit employee':'New employee', fields, values:existing||{active:true},
    onSave:(vals)=>{ if(existing) Store.update('employees',existing.id,vals); else Store.insert('employees',{...vals,active:vals.active!==false}); closeModal(); go(); toast('Saved'); }});
}
function openSkillCell(empId,procId){
  const s=skillFor(empId,procId)||{level:0,roles:[]};
  const body=`<p class="muted small">${h(empName(empId))} · ${h(procName(procId))}</p>
    <div class="field"><label>Skill level</label><div class="chips" id="sk_lv">${SKILL_LEVELS.map((l,i)=>`<span class="chip ${s.level===i?'on':''}" data-v="${i}">${i} · ${l}</span>`).join('')}</div></div>
    <div class="field"><label>Role tags</label><div class="chips" id="sk_roles">${ROLE_TAGS.map(r=>`<span class="chip ${(s.roles||[]).includes(r)?'on':''}" data-v="${r}">${r}</span>`).join('')}</div></div>`;
  openModal('Set capability', body, `<button class="btn ghost" id="mcancel">Cancel</button><button class="btn primary" id="msave">Save</button>`);
  let level=s.level; let roles=[...(s.roles||[])];
  $('#sk_lv').onclick=e=>{ const c=e.target.closest('.chip'); if(!c)return; level=+c.dataset.v; $$('#sk_lv .chip').forEach(x=>x.classList.remove('on')); c.classList.add('on'); };
  $('#sk_roles').onclick=e=>{ const c=e.target.closest('.chip'); if(!c)return; const r=c.dataset.v; if(roles.includes(r)){roles=roles.filter(x=>x!==r);c.classList.remove('on');}else{roles.push(r);c.classList.add('on');} };
  $('#mcancel').onclick=closeModal;
  $('#msave').onclick=()=>{
    const existing=skillFor(empId,procId);
    if(existing) Store.update('staffSkills',existing.id,{level,roles});
    else Store.insert('staffSkills',{employeeId:empId,processId:procId,level,roles});
    closeModal(); go(); toast('Capability saved');
  };
}
function spofPanel(){
  const risks=spofRisks();
  if(!risks.length) return `<div class="note">No single points of failure detected in captured data. Keep filling the matrix — processes without any capability data are treated as “not yet observed”, not as gaps.</div>`;
  return `<div class="note crit"><b>⚠ HIGH OPERATIONAL RISK — coverage gaps</b><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px">
    ${risks.map(r=>`<span class="badge ${r.crit?'b-crit':'b-imp'}">${h(r.name)}: ${r.n===0?'no competent staff':'only '+(r.who||'1 person')}</span>`).join('')}</div>
    <div class="hint" style="margin-top:6px">Competent = level ≥ 3. Data-derived from the matrix; validate against the roster before acting.</div></div>`;
}

/* =========================================================================
   STAFF OBSERVATION LOG
   =======================================================================*/
function renderStaffObs(v){
  v.innerHTML = pagehead('Staff Observation Log',
    'Observations tied to a person and a situation. Critically, it forces you to classify the issue: is it a <b>process</b>, <b>system</b>, <b>capacity</b>, or genuinely a <b>person</b> issue? Do not label someone a performance problem on a single observation.',
    `<button class="btn primary" id="addSO">＋ Observation</button>`)
    + `<div id="soTable"></div>`;
  $('#addSO').onclick=()=>openStaffObsForm();
  drawStaffObs();
}
let staffObsEmp=[];   // employees selected in the open staff-observation form
function renderStaffObsEmp(){
  const box=document.getElementById('empm_employees'); if(!box) return;
  if(!staffObsEmp.length) staffObsEmp=[''];   // always show at least one selector
  box.innerHTML=staffObsEmp.map((val,i)=>`<div style="display:flex;gap:6px;margin-bottom:6px">
    <select data-soe="${i}" style="flex:1"><option value="">— employee ${i+1} —</option>${empOpts().map(o=>`<option value="${o.v}" ${val===o.v?'selected':''}>${h(o.l)}</option>`).join('')}</select>
    ${staffObsEmp.length>1?`<button type="button" class="btn sm danger" data-soerm="${i}">✕</button>`:''}</div>`).join('');
  box.querySelectorAll('[data-soe]').forEach(s=>s.onchange=()=>{ staffObsEmp[+s.dataset.soe]=s.value; });
  box.querySelectorAll('[data-soerm]').forEach(b=>b.onclick=()=>{ staffObsEmp.splice(+b.dataset.soerm,1); renderStaffObsEmp(); });
}
function openStaffObsForm(existing){
  staffObsEmp = existing ? ((existing.employees&&existing.employees.length)?existing.employees.slice():(existing.employeeId?[existing.employeeId]:[''])) : [''];
  const fields=[
    {name:'date',label:'Date',type:'date',required:true,row:'a'},
    {name:'processId',label:'Process',type:'select',options:procOpts(),row:'a'},
    {name:'employees',label:'Employee(s)',type:'empmulti',hint:'Add one row per employee involved.'},
    {name:'attribution',label:'This is primarily a…',type:'select',options:['Process issue','System issue','Capacity issue','Person / skill issue','Positive behavior','Training opportunity'],required:true,hint:'Separate the person from the process/system/capacity.'},
    {name:'situation',label:'Situation',type:'textarea',rows:2},
    {name:'observation',label:'Observation (what was seen)',type:'textarea',required:true},
    {name:'evidence',label:'Evidence',type:'text'},
    {name:'result',label:'Result / outcome',type:'text',row:'c'},
    {name:'cause',label:'Possible cause (hypothesis)',type:'text',row:'c'},
    {name:'trainingOpp',label:'Training opportunity',type:'text'},
  ];
  openForm({title:existing?'Edit staff observation':'New staff observation', fields, values:existing||{date:todayStr()},
    afterRender:(root)=>{ renderStaffObsEmp(); const add=root.querySelector('#empadd_employees'); if(add) add.onclick=()=>{ staffObsEmp.push(''); renderStaffObsEmp(); }; },
    onSave:(vals)=>{
      const emps=staffObsEmp.filter(Boolean);
      if(!emps.length){ toast('Please select at least one employee'); return; }
      vals.employees=emps; vals.employeeId=emps[0];   // employeeId kept = first, for compatibility
      if(existing) Store.update('staffObs',existing.id,vals); else Store.insert('staffObs',vals);
      closeModal(); drawStaffObs(); toast('Saved'); }});
}
function drawStaffObs(){
  const rows=Store.col('staffObs');
  const attrCls={'Process issue':'b-warn','System issue':'b-imp','Capacity issue':'b-warn','Person / skill issue':'b-crit','Positive behavior':'b-ok','Training opportunity':'b-new'};
  $('#soTable').innerHTML=`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Employee</th><th>Process</th><th>Classification</th><th class="wrap">Observation</th><th></th></tr></thead>
    <tbody>${rows.length? rows.map(s=>`<tr><td>${h(s.date)}</td><td>${h(((s.employees&&s.employees.length)?s.employees:[s.employeeId]).map(empName).filter(Boolean).join(', '))}</td><td>${na(procName(s.processId))}</td>
      <td><span class="badge ${attrCls[s.attribution]||'b-muted'}">${h(s.attribution)}</span></td>
      <td class="wrap">${h(s.observation)}${s.trainingOpp?`<div class="small muted">🎓 ${h(s.trainingOpp)}</div>`:''}</td>
      <td><button class="btn sm" data-e="${s.id}">Edit</button> <button class="btn sm danger" data-d="${s.id}">✕</button></td></tr>`).join('')
      : emptyRow(6,'No staff observations yet.')}</tbody></table></div>`;
  $$('#soTable [data-e]').forEach(b=>b.onclick=()=>openStaffObsForm(Store.get('staffObs',b.dataset.e)));
  $$('#soTable [data-d]').forEach(b=>b.onclick=()=>{const s=Store.get('staffObs',b.dataset.d);confirmDelete(empName(s.employeeId),()=>{Store.remove('staffObs',s.id);drawStaffObs();});});
}

/* =========================================================================
   BOTTLENECK / PROBLEM REGISTER
   =======================================================================*/
function priorityScore(p){
  const impact={Critical:4,Important:3,Improvement:2,Minor:1}[p.severity]||1;
  const freq=Math.min(5, num(p.frequency,1));
  const risk=num(p.opRisk,2);
  return impact*freq*risk;
}
function renderProblems(v){
  v.innerHTML = pagehead('Problem / Bottleneck Register',
    'Priority = Impact × Frequency × Operational Risk (auto-calculated, manual override allowed). Severity uses 🔴 Critical / 🟠 Important / 🟡 Improvement / 🟢 Minor. Cause stays a <b>possible cause</b> until validated.',
    `<button class="btn primary" id="addProb">＋ Problem</button>`)
    + `<div id="probTable"></div>`;
  $('#addProb').onclick=()=>openProbForm();
  drawProblems();
}
function openProbForm(existing){
  const fields=[
    {name:'dateIdentified',label:'Date identified',type:'date',required:true,row:'a'},
    {name:'processId',label:'Process',type:'select',options:procOpts(),row:'a'},
    {name:'problem',label:'Problem (observed)',type:'textarea',required:true},
    {name:'location',label:'Location',type:'text',row:'b'},
    {name:'frequency',label:'Frequency (times observed)',type:'number',value:1,row:'b'},
    {name:'evidence',label:'Evidence',type:'text'},
    {name:'impact',label:'Impact',type:'textarea',rows:2,row:'c'},
    {name:'cause',label:'Possible cause (hypothesis)',type:'textarea',rows:2,row:'c'},
    {name:'severity',label:'Severity',type:'select',options:SEVERITIES.map(s=>s.k),required:true,row:'d'},
    {name:'opRisk',label:'Operational risk (1–3)',type:'number',value:2,step:'1',row:'d',hint:'1 low · 2 med · 3 high'},
    {name:'owner',label:'Owner',type:'select',options:empOpts(),row:'e'},
    {name:'status',label:'Status',type:'select',options:PROB_STATUS,value:'Open',row:'e'},
    {name:'relatedKPI',label:'Related KPI',type:'datalist',options:MANAGEMENT_KPIS,ph:'choose a management KPI or type your own',hint:'Management-requested KPIs are suggested; you can also type a custom one.'},
    {name:'priorityOverride',label:'Priority override (optional)',type:'number',hint:'Leave blank to use the calculated score.'},
  ];
  openForm({title:existing?'Edit problem':'New problem', fields, values:existing||{dateIdentified:todayStr(),frequency:1,opRisk:2,status:'Open'},
    onSave:(vals)=>{ vals.priorityScore = vals.priorityOverride!=null&&vals.priorityOverride!==''? vals.priorityOverride : priorityScore(vals);
      if(existing) Store.update('problems',existing.id,vals); else Store.insert('problems',vals);
      closeModal(); drawProblems(); toast('Problem saved'); }});
}
function drawProblems(){
  const rows=Store.col('problems').slice().sort((a,b)=>(b.priorityScore||0)-(a.priorityScore||0));
  $('#probTable').innerHTML=`<div class="tablewrap"><table><thead><tr><th>ID</th><th>Sev</th><th>Prio</th><th>Process</th><th class="wrap">Problem</th><th>Freq</th><th>Owner</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.length? rows.map(p=>`<tr>
      <td class="faint small">${h(p.id.slice(-5))}</td>
      <td>${sevBadge(p.severity)}</td>
      <td><b>${p.priorityScore??'—'}</b></td>
      <td>${na(procName(p.processId))}</td>
      <td class="wrap">${h(p.problem)}${p.cause?`<div class="small"><span class="etag et-hyp">possible cause</span>${h(p.cause)}</div>`:''}</td>
      <td>${p.frequency??'—'}</td>
      <td class="small">${na(empName(p.owner))}</td>
      <td>${statusBadge(p.status)}</td>
      <td><button class="btn sm" data-e="${p.id}">Edit</button> <button class="btn sm ghost" data-rca="${p.id}">5-Why</button> <button class="btn sm danger" data-d="${p.id}">✕</button></td>
    </tr>`).join('') : emptyRow(9,'No problems logged. Add findings here or convert an observation from the Daily Observation log.')}</tbody></table></div>`;
  $$('#probTable [data-e]').forEach(b=>b.onclick=()=>openProbForm(Store.get('problems',b.dataset.e)));
  $$('#probTable [data-d]').forEach(b=>b.onclick=()=>{const p=Store.get('problems',b.dataset.d);confirmDelete(p.problem.slice(0,40),()=>{Store.remove('problems',p.id);drawProblems();});});
  $$('#probTable [data-rca]').forEach(b=>b.onclick=()=>openRCA(b.dataset.rca));
}
function openRCA(id){
  const p=Store.get('problems',id); const rca=p.rca||{whys:['','','','',''],category:''};
  const cats=['People','Process','Technology','Material','Layout','Management','Capacity'];
  const body=`<p class="muted small">${h(p.problem)}</p>
    <div class="note">Cause stays a <b>possible cause</b> until validated. Do not mark a root cause as confirmed here.</div>
    <div class="field"><label>Fishbone category (possible)</label><select id="rca_cat">${['',...cats].map(c=>`<option ${rca.category===c?'selected':''}>${c}</option>`).join('')}</select></div>
    ${rca.whys.map((w,i)=>`<div class="field"><label>Why #${i+1}</label><input type="text" id="rca_w${i}" value="${h(w)}"></div>`).join('')}`;
  openModal('5-Why analysis', body, `<button class="btn ghost" id="mcancel">Cancel</button><button class="btn primary" id="msave">Save</button>`);
  $('#mcancel').onclick=closeModal;
  $('#msave').onclick=()=>{ const whys=[0,1,2,3,4].map(i=>$('#rca_w'+i).value.trim()); Store.update('problems',id,{rca:{whys,category:$('#rca_cat').value}}); closeModal(); toast('5-Why saved'); };
}

/* =========================================================================
   KPI BASELINE
   =======================================================================*/
function renderKPI(v){
  v.innerHTML = pagehead('KPI Cockpit',
    'The management KPI targets vs your current numbers, with a Red/Amber/Green status for each. Enter a reading per KPI as you measure it; the baseline is your first reading, and status updates as new readings come in.',
    `<button class="btn primary" id="addKPI">＋ KPI data point (baseline)</button>`)
    + `<div id="cockpitBody"></div>`
    + `<h3 style="margin:22px 0 8px;font-size:14px">Baseline data points <span class="sub" style="color:var(--faint);font-weight:400">— detailed metric log</span></h3>`
    + `<div id="kpiBody"></div>`;
  $('#addKPI').onclick=()=>openKPIForm();
  drawCockpit();
  drawKPI();
}
/* readings for one official KPI (stored in kpiRecords, category 'Management KPI') */
function kpiReadings(kpiId){
  return Store.col('kpiRecords').filter(r=>r.kpiId===kpiId)
    .sort((a,b)=>{ const d=(a.date||'').localeCompare(b.date||''); return d || (a.createdAt||'').localeCompare(b.createdAt||''); });
}
function cockpitStatus(k, readings){
  if(!readings.length) return {color:k.def, cur:null};
  const latest=readings[readings.length-1], cur=latest.value;
  let color;
  if(k.kind==='pct'){ color = cur>=k.goal?'green':(cur>=k.goal*0.9?'yellow':'red'); }
  else if(k.kind==='min'){ color = cur>=k.goal?'green':(cur>=k.goal*0.8?'yellow':'red'); }
  else if(k.kind==='zero'){ color = cur===0?'green':'red'; }
  else { // reduce / baseline: compare latest vs baseline (first reading)
    const base=(readings.find(r=>r.baseline)||readings[0]).value;
    if(readings.length===1) color='yellow';               // baseline only
    else if(cur < base) color='green';                    // improving (lower is better)
    else if(cur > base) color='red';                      // worsening
    else color='yellow';
  }
  return {color, cur, unit:latest.unit||k.unit, base:(readings.find(r=>r.baseline)||readings[0]).value};
}
const STATUS_DOT={green:'🟢',yellow:'🟡',red:'🔴'};
function drawCockpit(){
  const box=$('#cockpitBody'); if(!box) return;
  const rows=OFFICIAL_KPIS.map(k=>{ const rd=kpiReadings(k.id); const st=cockpitStatus(k,rd);
    const uTxt = (!st.unit||st.unit==='count')?'':(st.unit==='%'?'%':' '+h(st.unit));
    const curTxt = st.cur==null ? '<span class="na">—</span>'
      : `<b>${st.cur}</b>${uTxt}${k.kind==='reduce'&&st.base!=null&&rd.length>1?` <span class="faint small">(baseline ${st.base})</span>`:''}`;
    const spark = rd.length>1? sparkline(rd.map(r=>r.value)) : '';
    return `<tr>
      <td class="wrap"><b>${h(k.name)}</b></td>
      <td>${h(k.target)}</td>
      <td>${curTxt} ${spark}</td>
      <td style="font-size:16px">${STATUS_DOT[st.color]}</td>
      <td><button class="btn sm" data-kpird="${k.id}">＋ Reading</button>${rd.length?` <span class="faint small">${rd.length}</span>`:''}</td>
    </tr>`;
  }).join('');
  const counts={green:0,yellow:0,red:0}; OFFICIAL_KPIS.forEach(k=>counts[cockpitStatus(k,kpiReadings(k.id)).color]++);
  box.innerHTML=`<div class="card">
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px;font-size:13px">
        <span>🟢 On target: <b>${counts.green}</b></span><span>🟡 Baseline / at risk: <b>${counts.yellow}</b></span><span>🔴 Off target: <b>${counts.red}</b></span>
      </div>
      <div class="tablewrap"><table><thead><tr><th class="wrap">KPI</th><th>Target</th><th>Current</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="hint" style="margin-top:8px">Status: 🟢 on target · 🟡 baseline set / needs attention · 🔴 off target or no data. For “Reduce” KPIs the first reading is the baseline; later readings turn 🟢 if lower, 🔴 if higher.</div>
    </div>`;
  $$('#cockpitBody [data-kpird]').forEach(b=>b.onclick=()=>openKpiReading(OFFICIAL_KPIS.find(k=>k.id===b.dataset.kpird)));
}
function openKpiReading(k){
  const last=kpiReadings(k.id).slice(-1)[0];
  const fields=[
    {name:'date',label:'Date',type:'date',required:true,row:'a'},
    {name:'value',label:`Current value (${k.unit||'value'})`,type:'number',required:true,row:'a'},
    {name:'unit',label:'Unit',type:'text',value:k.unit,row:'b'},
    {name:'baseline',label:'Baseline',type:'checkbox',cbLabel:'This is the baseline (first/reference reading)',value:!last},
    {name:'source',label:'Source / how measured',type:'text',hint:'Keeps the number traceable to evidence.'},
    {name:'note',label:'Note',type:'text'},
  ];
  openForm({title:'Reading · '+k.name+' (target '+k.target+')', fields, values:{date:todayStr(),unit:k.unit,baseline:!last},
    onSave:(vals)=>{ Store.insert('kpiRecords',{...vals, kpiId:k.id, category:'Management KPI', metric:k.name});
      closeModal(); drawCockpit(); drawKPI(); toast('Reading saved'); }});
}
function openKPIForm(existing){
  const metricOptions=[]; Object.entries(KPI_CATALOG).forEach(([cat,ms])=>ms.forEach(m=>metricOptions.push({v:cat+' | '+m,l:cat+' — '+m})));
  const fields=[
    {name:'date',label:'Date',type:'date',required:true,row:'a'},
    {name:'metricKey',label:'Metric',type:'select',options:metricOptions,required:true,row:'a'},
    {name:'value',label:'Value',type:'number',required:true,row:'b'},
    {name:'unit',label:'Unit',type:'text',ph:'e.g. /hour, %, min',row:'b'},
    {name:'source',label:'Source of measurement',type:'text',hint:'How was this measured? Evidence keeps it traceable.'},
    {name:'baseline',label:'Baseline',type:'checkbox',cbLabel:'Mark as baseline value',value:true},
    {name:'note',label:'Note',type:'text'},
  ];
  openForm({title:existing?'Edit KPI':'New KPI data point', fields, values:existing||{date:todayStr(),baseline:true},
    onSave:(vals)=>{ const [category,metric]=vals.metricKey.split(' | '); vals.category=category; vals.metric=metric;
      if(existing) Store.update('kpiRecords',existing.id,vals); else Store.insert('kpiRecords',vals);
      closeModal(); drawKPI(); toast('KPI saved'); }});
}
function drawKPI(){
  const recs=Store.col('kpiRecords'); const box=$('#kpiBody');
  if(!recs.length){ box.innerHTML=`<div class="card"><div class="empty">No KPI data points yet. Add measured values to build the baseline.</div></div>`; return; }
  let html='';
  Object.keys(KPI_CATALOG).forEach(cat=>{
    const inCat=recs.filter(r=>r.category===cat); if(!inCat.length) return;
    const byMetric={}; inCat.forEach(r=>{ (byMetric[r.metric]=byMetric[r.metric]||[]).push(r); });
    html+=`<div class="card" style="margin-bottom:14px"><h3>${cat}</h3><div class="tablewrap"><table>
      <thead><tr><th>Metric</th><th>Baseline (avg)</th><th>Latest</th><th>Points</th><th>Trend</th></tr></thead><tbody>
      ${Object.entries(byMetric).map(([m,arr])=>{
        const sorted=arr.slice().sort((a,b)=>a.date<b.date?-1:1);
        const base=sorted.filter(r=>r.baseline); const avg= base.length? base.reduce((a,r)=>a+r.value,0)/base.length : null;
        const latest=sorted[sorted.length-1]; const unit=latest.unit||'';
        const spark=sorted.map(r=>r.value);
        return `<tr><td><b>${h(m)}</b></td>
          <td>${avg!=null?(Math.round(avg*100)/100)+' '+h(unit):'<span class="na">—</span>'}</td>
          <td>${latest.value} ${h(unit)} <span class="faint small">${h(latest.date)}</span></td>
          <td>${sorted.length}</td>
          <td>${sparkline(spark)}</td></tr>`;
      }).join('')}
      </tbody></table></div></div>`;
  });
  box.innerHTML=html + kpiListCard();
}
function sparkline(vals){
  if(vals.length<2) return '<span class="faint small">single point</span>';
  const min=Math.min(...vals),max=Math.max(...vals),range=max-min||1;
  const bars=vals.slice(-12).map(v=>{ const hgt=6+Math.round((v-min)/range*20); return `<span style="display:inline-block;width:5px;height:${hgt}px;background:var(--accent);margin-right:2px;vertical-align:bottom;border-radius:1px"></span>`; }).join('');
  return `<span title="${vals.join(', ')}">${bars}</span>`;
}
function kpiListCard(){
  const recs=Store.col('kpiRecords').slice(0,20);
  return `<div class="card"><h3>Recent data points</h3><div class="tablewrap"><table><thead><tr><th>Date</th><th>Category</th><th>Metric</th><th>Value</th><th>Baseline</th><th></th></tr></thead>
    <tbody>${recs.map(r=>`<tr><td>${h(r.date)}</td><td>${h(r.category)}</td><td>${h(r.metric)}</td><td><b>${r.value}</b> ${h(r.unit||'')}</td>
      <td>${r.baseline?'<span class="badge b-ok">baseline</span>':'—'}</td>
      <td><button class="btn sm" data-e="${r.id}">Edit</button> <button class="btn sm danger" data-d="${r.id}">✕</button></td></tr>`).join('')}</tbody></table></div></div>`;
}
/* delegated for kpi list */
document.addEventListener('click',e=>{
  const ed=e.target.closest('#kpiBody [data-e]'); if(ed){ openKPIForm(Store.get('kpiRecords',ed.dataset.e)); }
  const dl=e.target.closest('#kpiBody [data-d]'); if(dl){ const r=Store.get('kpiRecords',dl.dataset.d); confirmDelete(r.metric,()=>{Store.remove('kpiRecords',r.id);drawKPI();}); }
});

/* =========================================================================
   VALIDATION MODULE
   =======================================================================*/
function renderValidation(v){
  v.innerHTML = pipelineStrip('Validate') + pagehead('Validation',
    'Compare <b>what people say</b> vs <b>what was observed</b> vs <b>what the data shows</b>. Helps avoid decisions based on opinion alone.',
    `<button class="btn primary" id="addVal">＋ Claim to validate</button>`)
    + `<div id="valBody"></div>`;
  $('#addVal').onclick=()=>openValForm();
  drawValidation();
}
function openValForm(existing){
  const fields=[
    {name:'date',label:'Date',type:'date',required:true,row:'a'},
    {name:'source',label:'Claim source',type:'text',ph:'e.g. Operations, a supervisor',row:'a'},
    {name:'claim',label:'What people say (the claim)',type:'textarea',required:true},
    {name:'observed',label:'What was observed',type:'textarea',rows:2},
    {name:'data',label:'What the data shows',type:'textarea',rows:2},
    {name:'finding',label:'Finding',type:'textarea',rows:2,hint:'A data-based statement, not a conclusion.'},
    {name:'status',label:'Status',type:'select',options:['Needs validation','Partially supported','Validated','Contradicted by data'],value:'Needs validation'},
  ];
  openForm({title:existing?'Edit claim':'New claim', fields, values:existing||{date:todayStr(),status:'Needs validation'},
    onSave:(vals)=>{ if(existing) Store.update('validations',existing.id,vals); else Store.insert('validations',vals); closeModal(); drawValidation(); toast('Saved'); }});
}
function drawValidation(){
  if(!Store.db.validations) Store.db.validations=[];
  const rows=Store.col('validations'); const box=$('#valBody');
  const stCls={'Needs validation':'b-warn','Partially supported':'b-new','Validated':'b-valid','Contradicted by data':'b-crit'};
  if(!rows.length){ box.innerHTML=`<div class="card"><div class="empty">No claims yet. Log what people assert, then test it against observation and data.</div></div>`; return; }
  box.innerHTML=rows.map(x=>`<div class="card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b>${h(x.source||'Claim')}</b><span class="badge ${stCls[x.status]||'b-muted'}">${h(x.status)}</span></div>
    <div style="margin-top:8px;display:grid;gap:8px">
      <div><span class="etag et-hyp">claim</span>${h(x.claim)}</div>
      ${x.observed?`<div><span class="etag et-obs">observed</span>${h(x.observed)}</div>`:''}
      ${x.data?`<div><span class="etag et-data">data</span>${h(x.data)}</div>`:''}
      ${x.finding?`<div class="note"><b>Finding:</b> ${h(x.finding)}</div>`:''}
    </div>
    <div class="btnrow" style="margin-top:8px"><button class="btn sm" data-e="${x.id}">Edit</button><button class="btn sm danger" data-d="${x.id}">Delete</button></div>
  </div>`).join('');
  $$('#valBody [data-e]').forEach(b=>b.onclick=()=>openValForm(Store.get('validations',b.dataset.e)));
  $$('#valBody [data-d]').forEach(b=>b.onclick=()=>{const x=Store.get('validations',b.dataset.d);confirmDelete((x.source||'claim'),()=>{Store.remove('validations',x.id);drawValidation();});});
}

/* =========================================================================
   INSIGHTS & ALERTS (rule-based over local data)
   =======================================================================*/
function computeInsights(){
  const out=[]; const meas=Store.col('measurements'), obs=Store.col('observations'), probs=Store.col('problems');
  // waiting-time concentration
  if(meas.length){
    const tp=meas.reduce((a,m)=>a+m.processingSec,0), tw=meas.reduce((a,m)=>a+m.waitingSec,0);
    const total=tp+tw; if(total>0){ const wp=Math.round(tw/total*100);
      if(wp>=40) out.push({kind:'Waiting-time concentration', level:wp>=60?'crit':'imp',
        text:`${wp}% of observed cycle time was non-processing (waiting) time.`,
        evidence:`${meas.length} measurements · processing ${fmtMin(tp)} vs waiting ${fmtMin(tw)}`, tag:'data'}); }
    // per-process worst waiting
    const agg={}; meas.forEach(m=>{ const k=procName(m.processId)||'—'; agg[k]=agg[k]||{p:0,w:0,n:0}; agg[k].p+=m.processingSec;agg[k].w+=m.waitingSec;agg[k].n++; });
    Object.entries(agg).forEach(([k,o])=>{ const t=o.p+o.w; if(t>0 && o.w>o.p && o.n>=1){ const wp=Math.round(o.w/t*100);
      out.push({kind:'Process waiting exceeds processing', level:'imp', text:`In "${k}", waiting time (${fmtMin(o.w)}) exceeds active processing (${fmtMin(o.p)}) — ${wp}% waiting.`, evidence:`${o.n} measurement(s)`, tag:'data'}); } });
  }
  // repeated problems (same process appears repeatedly in observations)
  const procCount={}; obs.forEach(o=>{ if(o.processId){ procCount[procName(o.processId)]=(procCount[procName(o.processId)]||0)+1; } });
  Object.entries(procCount).forEach(([k,c])=>{ if(c>=4){ const days=new Set(obs.filter(o=>procName(o.processId)===k).map(o=>o.date)).size;
    out.push({kind:'Repeated observation', level:'imp', text:`"${k}" was observed ${c} times across ${days} day(s).`, evidence:`${c} observations`, tag:'data'}); } });
  // error pattern
  const errObs=obs.filter(o=>o.error);
  if(errObs.length>=3){ const byProc={}; errObs.forEach(o=>{const k=procName(o.processId)||'—';byProc[k]=(byProc[k]||0)+1;});
    const top=Object.entries(byProc).sort((a,b)=>b[1]-a[1])[0];
    if(top && top[1]>=3) out.push({kind:'Error pattern', level:'imp', text:`${top[1]} of ${errObs.length} logged errors involve "${top[0]}".`, evidence:`${errObs.length} error observations`, tag:'data'}); }
  // skill concentration / SPOF (only where capability data exists)
  spofRisks().forEach(r=>{
    if(r.n===1) out.push({kind:'Skill concentration', level:'imp', text:`"${r.name}" capability depends primarily on 1 employee (${r.who}).`, evidence:'Staff Capability Matrix', tag:'data'});
    else out.push({kind:'No competent staff', level:'crit', text:`No staff at competent level (≥3) recorded for "${r.name}".`, evidence:'Staff Capability Matrix', tag:'data'});
  });
  // critical open problems
  probs.filter(p=>p.severity==='Critical'&&!['Resolved','Rejected'].includes(p.status)).forEach(p=>{
    out.push({kind:'Critical open problem', level:'crit', text:p.problem, evidence:p.evidence||'see register', tag:'data'}); });
  // overdue unvalidated hypotheses
  obs.filter(o=>o.status==='Under validation').forEach(o=>{ const age=daysBetween(o.date,todayStr()); if(age>=5)
    out.push({kind:'Ageing unvalidated observation', level:'warn', text:`"${(o.what||'').slice(0,60)}" has been under validation for ${age} days.`, evidence:o.evidence||'—', tag:'hyp'}); });
  return out;
}
function renderInsights(v){
  const ins=computeInsights();
  v.innerHTML = pipelineStrip('Diagnose') + pagehead('Insights & Alerts',
    'Patterns detected automatically from your data. Every insight is a <b>data-derived finding</b> and shows its evidence — none is an automatic root-cause conclusion.')
    + (ins.length? `<div class="grid g-2">${ins.map(insightCard).join('')}</div>`
       : `<div class="card"><div class="empty">No patterns detected yet. Log more observations, measurements and capability data — insights appear automatically.</div></div>`)
    + aiQueryCard();
  wireAIQuery();
}
function insightCard(i){
  const lv={crit:'crit',imp:'warn',warn:'warn'}[i.level]||'';
  const dot={crit:'🔴',imp:'🟠',warn:'🟡'}[i.level]||'💡';
  return `<div class="card" style="${i.level==='crit'?'border-color:#5a2a2a':''}">
    <h3>${dot} ${h(i.kind)} <span class="sub"><span class="etag et-${i.tag==='hyp'?'hyp':'data'}">${i.tag==='hyp'?'hypothesis':'data-derived'}</span></span></h3>
    <div>${h(i.text)}</div>
    <div class="hint" style="margin-top:8px">Evidence: ${h(i.evidence)}</div></div>`;
}
/* simple local "AI" query over data */
function aiQueryCard(){
  return `<div class="card" style="margin-top:16px"><h3>💬 Ask about your data <span class="sub">answers from collected data only</span></h3>
    <div class="chips" style="margin-bottom:10px">
      ${['Top 5 bottlenecks this week','Which process has the highest waiting time?','Where are single points of failure?','Which observations still require validation?','Compare processing vs waiting'].map(q=>`<span class="chip" data-q="${h(q)}">${h(q)}</span>`).join('')}
    </div>
    <div class="btnrow"><input type="text" id="aiq" placeholder="Ask a question…" style="flex:1"><button class="btn primary" id="aiAsk">Ask</button></div>
    <div id="aiAns" style="margin-top:12px"></div></div>`;
}
function wireAIQuery(){
  $$('#view [data-q]').forEach(c=>c.onclick=()=>{ $('#aiq').value=c.dataset.q; answerAI(c.dataset.q); });
  $('#aiAsk').onclick=()=>answerAI($('#aiq').value);
  $('#aiq').onkeydown=e=>{ if(e.key==='Enter') answerAI($('#aiq').value); };
}
function answerAI(q){
  q=(q||'').toLowerCase().trim(); if(!q){return;}
  const box=$('#aiAns'); let html='';
  const meas=Store.col('measurements');
  const label=`<span class="etag et-data">data-based finding</span>`;
  if(/bottleneck|top.*problem|worst/.test(q)){
    const ps=Store.col('problems').filter(p=>!['Resolved','Rejected'].includes(p.status)).sort((a,b)=>(b.priorityScore||0)-(a.priorityScore||0)).slice(0,5);
    html = ps.length? `${label} Top ${ps.length} open problems by priority:<ol>${ps.map(p=>`<li>${h(p.problem)} — ${sevBadge(p.severity)} priority ${p.priorityScore}</li>`).join('')}</ol>`
      : 'No problems recorded yet.';
  } else if(/waiting|highest wait|wait time/.test(q)){
    const agg={}; meas.forEach(m=>{const k=procName(m.processId)||'—';agg[k]=agg[k]||{w:0,p:0};agg[k].w+=m.waitingSec;agg[k].p+=m.processingSec;});
    const rows=Object.entries(agg).sort((a,b)=>b[1].w-a[1].w).slice(0,5);
    html = rows.length? `${label} Processes by total observed waiting time:<ol>${rows.map(([k,o])=>`<li>${h(k)} — waiting ${fmtMin(o.w)} (processing ${fmtMin(o.p)})</li>`).join('')}</ol>`
      : 'No measurements yet — run the timer to answer this.';
  } else if(/single point|spof|failure|cross-train|depend/.test(q)){
    const risks=spofRisks().map(r=>`${r.name}: ${r.n===0?'no competent staff':'only '+r.who}`);
    html = risks.length? `${label} Single points of failure (competent = level ≥3):<ul>${risks.map(r=>`<li>${h(r)}</li>`).join('')}</ul>`
      : 'No single points of failure in captured matrix data. Processes without capability data are treated as not yet observed.';
  } else if(/validat|require validation|unvalidated/.test(q)){
    const o=Store.col('observations').filter(x=>x.status==='Under validation');
    html = o.length? `${label} ${o.length} observation(s) under validation:<ul>${o.map(x=>`<li>${h(x.date)} — ${h((x.what||'').slice(0,80))}</li>`).join('')}</ul>` : 'Nothing is currently under validation.';
  } else if(/processing vs waiting|split|compare.*wait/.test(q)){
    const tp=meas.reduce((a,m)=>a+m.processingSec,0),tw=meas.reduce((a,m)=>a+m.waitingSec,0),t=tp+tw;
    html = t? `${label} Across ${meas.length} measurements: processing ${fmtMin(tp)}, waiting ${fmtMin(tw)} — waiting is ${Math.round(tw/t*100)}% of observed cycle time.` : 'No measurements yet.';
  } else {
    html = `<span class="etag et-fact">note</span> This assistant answers from your collected records only. Try one of the suggested questions, or ask about bottlenecks, waiting time, single points of failure, or validation status.`;
  }
  box.innerHTML=`<div class="note">${html}</div>`;
}

/* =========================================================================
   HQ INTERFACE
   =======================================================================*/
function renderHQ(v){
  v.innerHTML = pagehead('HQ Interface Map',
    'For each department: what the warehouse receives, what it sends, the main problem, and what they expect from the Warehouse Lead. Builds the Warehouse ↔ HQ interface map.',
    `<button class="btn primary" id="addHQ">＋ Interaction</button>`)
    + `<div id="hqBody"></div>`;
  $('#addHQ').onclick=()=>openHQForm();
  drawHQ();
}
function openHQForm(existing){
  const fields=[
    {name:'departmentId',label:'Department',type:'select',options:depOpts(),required:true,row:'a'},
    {name:'date',label:'Meeting date',type:'date',row:'a'},
    {name:'receive',label:'What warehouse RECEIVES from them',type:'textarea',rows:2},
    {name:'send',label:'What warehouse SENDS to them',type:'textarea',rows:2},
    {name:'problem',label:'Main problem',type:'textarea',rows:2},
    {name:'expectation',label:'What they expect from the Warehouse Lead',type:'textarea',rows:2},
    {name:'dependencies',label:'Dependencies',type:'text',row:'b'},
    {name:'commIssue',label:'Communication problem',type:'text',row:'b'},
    {name:'ownershipGap',label:'Ownership gap',type:'text'},
    {name:'followup',label:'Follow-up actions',type:'textarea',rows:2},
  ];
  const isEdit = !!(existing && existing.id);   // a prefill object (no id) is a NEW interaction, not an edit
  openForm({title:isEdit?'Edit interaction':'New HQ interaction', fields, values:existing||{date:todayStr()},
    onSave:(vals)=>{ if(isEdit) Store.update('hqInteractions',existing.id,vals); else Store.insert('hqInteractions',vals); closeModal(); drawHQ(); toast('Saved'); }});
}
function hqRecordHTML(r){
  return `<div style="border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
      <b class="small">🗓 ${r.date?h(fmtDateAl(r.date)):'(pa datë)'}</b>
      <span class="btnrow"><button class="btn sm" data-e="${r.id}">Edit</button><button class="btn sm danger" data-d="${r.id}">✕</button></span>
    </div>
    <div style="display:grid;gap:4px;font-size:12.5px;margin-top:6px">
      <div><span class="muted">Merr (receives):</span> ${na(r.receive)}</div>
      <div><span class="muted">Dërgon (sends):</span> ${na(r.send)}</div>
      <div><span class="muted">Problemi kryesor:</span> ${na(r.problem)}</div>
      <div><span class="muted">Presin nga WH Lead:</span> ${na(r.expectation)}</div>
      ${r.dependencies?`<div><span class="muted">Varësi:</span> ${h(r.dependencies)}</div>`:''}
      ${r.ownershipGap?`<div><span class="muted">Ownership gap:</span> ${h(r.ownershipGap)}</div>`:''}
      ${r.followup?`<div><span class="muted">Follow-up:</span> ${h(r.followup)}</div>`:''}
      ${r.commIssue?`<div class="note warn" style="margin:4px 0">Komunikim: ${h(r.commIssue)}</div>`:''}
    </div>
  </div>`;
}
function drawHQ(){
  const box=$('#hqBody'); const deps=Store.col('departments'); const all=Store.col('hqInteractions');
  const byDate=(a,b)=>(a.date||'')<(b.date||'')?1:-1;   // newest first
  const html=deps.map(d=>{
    const recs=all.filter(x=>x.departmentId===d.id).sort(byDate);
    return `<div class="card" style="margin-bottom:12px">
      <h3>🏢 ${h(d.name)} <span class="sub">${recs.length} interaksion(e)</span></h3>
      ${recs.length? recs.map(hqRecordHTML).join('') : `<div class="empty" style="padding:12px">Ende pa kontakt — s'ka të dhëna të regjistruara.</div>`}
      <div class="btnrow" style="margin-top:6px"><button class="btn sm primary" data-add="${d.id}">＋ Log interaction</button></div>
    </div>`;
  }).join('');
  // orphans: interactions whose department was removed — show so nothing is ever hidden
  const orphan=all.filter(r=>!deps.some(d=>d.id===r.departmentId)).sort(byDate);
  const orphanHtml = orphan.length? `<div class="card" style="margin-bottom:12px;border-color:#5a3a1a"><h3>⚠ Departament i hequr / i pacaktuar <span class="sub">${orphan.length}</span></h3>${orphan.map(hqRecordHTML).join('')}<div class="hint">Këto interaksione i takonin një departamenti që u fshi. Editoji për t'i ricaktuar te një departament ekzistues.</div></div>`:'';
  box.innerHTML=html+orphanHtml;
  $$('#hqBody [data-add]').forEach(b=>b.onclick=()=>{ openHQForm({departmentId:b.dataset.add,date:todayStr()}); });
  $$('#hqBody [data-e]').forEach(b=>b.onclick=()=>openHQForm(Store.get('hqInteractions',b.dataset.e)));
  $$('#hqBody [data-d]').forEach(b=>b.onclick=()=>{ const r=Store.get('hqInteractions',b.dataset.d); confirmDelete((r.problem||'interaksion').slice(0,40),()=>{Store.remove('hqInteractions',r.id);drawHQ();toast('Fshirë');}); });
}

/* =========================================================================
   REPORTS
   =======================================================================*/
function renderReports(v){
  v.innerHTML = pipelineStrip('Report') + pagehead('Reports',
    'Generated from your records. Reports keep <b>Observed / Measured / Validated / Assumption / Recommendation</b> distinct, and keep <b>Current State</b> separate from <b>Future State</b>.',
    `<button class="btn" id="printBtn">🖨 Print / PDF</button>`)
    + `<div class="filters"><button class="btn" data-r="daily">Daily report</button><button class="btn" data-r="weekly">Weekly report</button><button class="btn primary" data-r="final">30-Day diagnostic</button></div>`
    + `<div id="reportBody"><div class="empty">Choose a report above.</div></div>`;
  $('#printBtn').onclick=()=>window.print();
  $$('#view [data-r]').forEach(b=>b.onclick=()=>{ if(b.dataset.r==='daily')drawDaily(); else if(b.dataset.r==='weekly')drawWeekly(); else drawFinal(); });
  drawDaily();
}
function reportLegend(){
  return `<div class="flowstrip" style="margin-bottom:10px">
    <span><span class="etag et-obs">observed</span></span><span><span class="etag et-data">measured</span></span>
    <span><span class="etag et-data">validated</span></span><span><span class="etag et-hyp">assumption</span></span>
    <span><span class="etag et-rec">recommendation</span></span></div>`;
}
function drawDaily(){
  const day=todayStr();
  const obs=Store.col('observations').filter(o=>o.date===day);
  const meas=Store.col('measurements').filter(m=>m.date===day);
  const probs=Store.col('problems').filter(p=>p.dateIdentified===day);
  const so=Store.col('staffObs').filter(s=>s.date===day);
  const avgP=meas.length?meas.reduce((a,m)=>a+m.processingSec,0)/meas.length:null;
  const avgW=meas.length?meas.reduce((a,m)=>a+m.waitingSec,0)/meas.length:null;
  const longest=meas.slice().sort((a,b)=>b.waitingSec-a.waitingSec)[0];
  $('#reportBody').innerHTML=`<div class="report">
    <h1 style="margin:0;font-size:20px">Daily Warehouse Observation Report</h1>
    <div class="meta">${h(Store.db.config.warehouseName)} · ${h(day)} · Day ${Math.min(currentDay(),30)}/30 · ${h(Store.db.config.currentUser)}</div>
    ${reportLegend()}
    <h2>Activity</h2><ul>
      <li><span class="etag et-obs">observed</span> Orders observed today: <b>${Store.col('orders').filter(o=>o.date===day).length}</b></li>
      <li><span class="etag et-obs">observed</span> Products/inbound today: <b>${Store.col('products').filter(p=>p.date===day).length}</b></li>
      <li><span class="etag et-obs">observed</span> Observations logged: <b>${obs.length}</b></li>
      <li><span class="etag et-obs">observed</span> Employees observed: <b>${new Set([...so.map(s=>s.employeeId),...obs.flatMap(o=>o.staff||[])]).size}</b></li>
      <li><span class="etag et-data">measured</span> Measurements collected: <b>${meas.length}</b></li></ul>
    <h2>Time</h2><ul>
      <li><span class="etag et-data">measured</span> Avg processing time: <b>${avgP!=null?fmtDur(avgP):'Not yet measured'}</b></li>
      <li><span class="etag et-data">measured</span> Avg waiting time: <b>${avgW!=null?fmtDur(avgW):'Not yet measured'}</b></li>
      <li><span class="etag et-data">measured</span> Longest delay: <b>${longest?fmtDur(longest.waitingSec)+' ('+procName(longest.processId)+')':'—'}</b></li></ul>
    <h2>Problems</h2><ul>
      <li>New problems: <b>${probs.length}</b></li>
      <li>Critical: <b>${probs.filter(p=>p.severity==='Critical').length}</b></li></ul>
    ${obs.length?`<h2>Observations</h2><ul>${obs.map(o=>`<li><span class="etag et-obs">observed</span>${h(o.what)} ${o.cause?`<span class="etag et-hyp">possible cause</span><i>${h(o.cause)}</i>`:''}</li>`).join('')}</ul>`:''}
    <h2>People</h2><ul>${so.length? so.map(s=>`<li>${h(empName(s.employeeId))}: ${h(s.observation)} <span class="faint">(${h(s.attribution)})</span></li>`).join('') : '<li class="na">No staff observations today.</li>'}</ul>
    <h2>Key finding of the day</h2>
    <p>${dailyKeyFinding(meas,obs)}</p>
    <h2>Questions requiring validation</h2>
    <ul>${obs.filter(o=>o.status==='Under validation'||o.cause).map(o=>`<li><span class="etag et-hyp">assumption</span>${h(o.cause||o.what)} — needs validation</li>`).join('')||'<li class="na">None flagged.</li>'}</ul>
  </div>`;
}
function dailyKeyFinding(meas,obs){
  if(meas.length){ const tp=meas.reduce((a,m)=>a+m.processingSec,0),tw=meas.reduce((a,m)=>a+m.waitingSec,0),t=tp+tw;
    if(t>0 && tw>tp) return `<span class="etag et-data">data-based finding</span> Waiting time (${fmtDur(tw)}) exceeded active processing (${fmtDur(tp)}) across today's ${meas.length} measurements — ${Math.round(tw/t*100)}% of observed cycle time was non-processing. This is a data-derived observation, not a confirmed root cause.`; }
  if(obs.length) return `<span class="etag et-obs">observed</span> ${h(obs[0].what)}`;
  return '<span class="na">Not enough data captured today to state a finding.</span>';
}
function drawWeekly(){
  const day=currentDay(); const week=Math.ceil(Math.min(day,30)/7);
  const start=new Date(Store.db.config.startDate); start.setDate(start.getDate()+(week-1)*7);
  const from=start.toISOString().slice(0,10); const endD=new Date(start); endD.setDate(endD.getDate()+6); const to=endD.toISOString().slice(0,10);
  const inRange=(d)=> d>=from && d<=to;
  const obs=Store.col('observations').filter(o=>inRange(o.date));
  const meas=Store.col('measurements').filter(m=>inRange(m.date));
  const probs=Store.col('problems').filter(p=>!['Rejected'].includes(p.status));
  const tp=meas.reduce((a,m)=>a+m.processingSec,0),tw=meas.reduce((a,m)=>a+m.waitingSec,0),t=tp+tw;
  $('#reportBody').innerHTML=`<div class="report">
    <h1 style="margin:0;font-size:20px">Weekly Warehouse Observation Report</h1>
    <div class="meta">Week ${week} · ${h(from)} → ${h(to)} · ${h(Store.db.config.warehouseName)}</div>
    ${reportLegend()}
    <h2>1. Current State</h2><p>${obs.length+meas.length? `<span class="etag et-obs">observed</span> ${obs.length} observations and <span class="etag et-data">measured</span> ${meas.length} measurements captured this week.` : '<span class="na">Limited data captured this week.</span>'}</p>
    ${reportFlowsBlock(inRange)}
    <h2>2. Waiting-time analysis</h2><p>${t>0? `<span class="etag et-data">measured</span> Processing ${fmtDur(tp)} vs waiting ${fmtDur(tw)} — waiting is <b>${Math.round(tw/t*100)}%</b> of observed cycle time.` : '<span class="na">No measurements this week.</span>'}</p>
    <h2>3. Bottlenecks</h2><ul>${probs.slice().sort((a,b)=>(b.priorityScore||0)-(a.priorityScore||0)).slice(0,5).map(p=>`<li>${sevBadge(p.severity)} ${h(p.problem)} — priority ${p.priorityScore}</li>`).join('')||'<li class="na">None.</li>'}</ul>
    <h2>4. Staff capability</h2>${weeklyMatrixSummary()}
    <h2>5. Validated findings</h2><ul>${obs.filter(o=>o.status==='Validated').map(o=>`<li><span class="etag et-data">validated</span>${h(o.what)}</li>`).join('')||'<li class="na">None validated yet.</li>'}</ul>
    <h2>6. Open questions</h2><ul>${obs.filter(o=>o.status==='Under validation').map(o=>`<li><span class="etag et-hyp">assumption</span>${h(o.what)}</li>`).join('')||'<li class="na">None.</li>'}</ul>
    <h2>7. Recommended next observations</h2><ul>${weeklyRecommendations().map(r=>`<li><span class="etag et-rec">recommendation</span>${h(r)}</li>`).join('')}</ul>
  </div>`;
}
function weeklyMatrixSummary(){
  const risks=spofRisks().map(r=>`${r.name}: ${r.n===0?'no competent staff':'single point of failure ('+r.who+')'}`);
  return risks.length? `<ul>${risks.map(r=>`<li><span class="etag et-data">data-derived</span>${h(r)}</li>`).join('')}</ul>` : '<p class="na">No coverage gaps in captured matrix data.</p>';
}
function weeklyRecommendations(){
  const recs=[];
  if(Store.col('measurements').length<5) recs.push('Increase measurement coverage — time more live processes to build a reliable baseline.');
  const uncontacted=Store.col('departments').filter(d=>!Store.col('hqInteractions').some(x=>x.departmentId===d.id));
  if(uncontacted.length) recs.push('Contact HQ departments not yet mapped: '+uncontacted.map(d=>d.name).join(', ')+'.');
  if(Store.col('kpiRecords').length<6) recs.push('Add KPI baseline data points across Productivity, Quality and Speed.');
  if(!recs.length) recs.push('Continue validating open observations before drawing conclusions.');
  return recs;
}
function drawFinal(){
  const s=computeStats();
  const probs=Store.col('problems').slice().sort((a,b)=>(b.priorityScore||0)-(a.priorityScore||0));
  const top5=probs.filter(p=>!['Resolved','Rejected'].includes(p.status)).slice(0,5);
  $('#reportBody').innerHTML=`<div class="report">
    <h1 style="margin:0;font-size:22px">Warehouse 30-Day Diagnostic Report</h1>
    <div class="meta">${h(Store.db.config.warehouseName)} · ${h(Store.db.config.startDate)} → Day ${Math.min(currentDay(),30)} · Prepared by ${h(Store.db.config.currentUser)}</div>
    ${reportLegend()}
    <h2>1. Executive Summary</h2>
    <p>Over the observation period, <b>${s.obs}</b> observations and <b>${s.meas}</b> measurements were captured across <b>${s.procsObserved}</b> processes.
    <b>${s.problems}</b> problems are logged (<b>${s.validProblems}</b> validated, <b>${s.critical}</b> critical open).
    ${s.waitPct!=null?`Waiting time represents <b>${pct(s.waitPct)}</b> of observed cycle time (<span class="etag et-data">measured</span>).`:''}</p>
    <div class="note">This report separates <b>CURRENT STATE</b> (how the warehouse works today) from any <b>FUTURE STATE</b> recommendation.</div>

    <h2>2. Warehouse Current State</h2>${processMapMini('Inbound')}${processMapMini('Outbound')}
    ${reportFlowsBlock()}

    <h2>3. People</h2>${weeklyMatrixSummary()}
    <p class="muted small">Staff observations logged: ${Store.col('staffObs').length}. Capability entries: ${Store.col('staffSkills').length}.</p>

    <h2>4. Performance — KPI Baseline</h2>${finalKPISummary()}

    <h2>5. Waiting-time analysis</h2><p>${s.waitPct!=null? `<span class="etag et-data">measured</span> Across ${s.meas} measurements, waiting is ${pct(s.waitPct)} of observed cycle time. Total processing ${fmtDur(s.totalProc)} vs waiting ${fmtDur(s.totalWait)}.` : '<span class="na">Insufficient measurements.</span>'}</p>

    <h2>9. Bottlenecks (ranked)</h2>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Sev</th><th>Problem</th><th>Priority</th><th>Evidence</th></tr></thead>
    <tbody>${top5.length? top5.map((p,i)=>`<tr><td>${i+1}</td><td>${sevBadge(p.severity)}</td><td class="wrap">${h(p.problem)}</td><td>${p.priorityScore}</td><td class="wrap small">${na(p.evidence)}</td></tr>`).join('') : emptyRow(5,'No validated bottlenecks.')}</tbody></table></div>

    <h2>11. Quick Wins</h2><ul>${Store.col('quickWins').map(q=>`<li>${h(q.action||q.problem)}</li>`).join('')||'<li class="na">None recorded.</li>'}</ul>

    <h2>13. 60-Day Improvement Plan (from validated problems)</h2>
    <div class="note"><span class="etag et-rec">recommendation</span> The items below are proposed <b>FUTURE STATE</b> actions derived from validated problems — kept separate from current-state facts above.</div>
    <div class="tablewrap"><table><thead><tr><th>Priority</th><th>Problem</th><th>Possible cause</th><th>Action</th><th>Baseline→Target</th></tr></thead>
    <tbody>${improvementPlan().map(a=>`<tr><td>${h(a.priority)}</td><td class="wrap">${h(a.problem)}</td><td class="wrap small">${na(a.cause)}</td><td class="wrap"><span class="na">To be defined</span></td><td class="small"><span class="na">baseline first</span></td></tr>`).join('')||emptyRow(5,'Validate problems to populate the plan.')}</tbody></table></div>

    <h2>14. Recommended Future State</h2>
    <p><span class="etag et-rec">recommendation</span> Prioritise reducing waiting time in the processes flagged above, close single-points-of-failure through cross-training, and establish KPI targets once the baseline is trusted. Each recommendation should be validated against evidence before implementation.</p>
  </div>`;
}
function processMapMini(cat){
  const names = cat==='Inbound'?['Receiving','Check-in','Mapping']:['Claim','Picking','Packing/Check-out','Boxing'];
  const rows=names.map(n=>{ const meas=Store.col('measurements').filter(m=>procName(m.processId)===n);
    const avgP=meas.length?meas.reduce((a,m)=>a+m.processingSec,0)/meas.length:null;
    const avgW=meas.length?meas.reduce((a,m)=>a+m.waitingSec,0)/meas.length:null;
    return `<tr><td>${h(n)}</td><td>${avgP!=null?fmtDur(avgP):'<span class="na">Data not yet available</span>'}</td><td style="color:var(--warn)">${avgW!=null?fmtDur(avgW):'—'}</td></tr>`; }).join('');
  return `<h3>${cat} process map (current state)</h3><div class="tablewrap"><table><thead><tr><th>Step</th><th>Avg processing</th><th>Avg waiting</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function finalKPISummary(){
  const recs=Store.col('kpiRecords'); if(!recs.length) return '<p class="na">No KPI baseline captured. Add data points in the KPI module.</p>';
  const byMetric={}; recs.forEach(r=>{(byMetric[r.category+' — '+r.metric]=byMetric[r.category+' — '+r.metric]||[]).push(r);});
  return `<div class="tablewrap"><table><thead><tr><th>Metric</th><th>Baseline (avg)</th><th>Points</th></tr></thead><tbody>${
    Object.entries(byMetric).map(([m,arr])=>{const base=arr.filter(r=>r.baseline);const avg=base.length?base.reduce((a,r)=>a+r.value,0)/base.length:null;
    return `<tr><td>${h(m)}</td><td>${avg!=null?Math.round(avg*100)/100+' '+h(arr[0].unit||''):'<span class="na">—</span>'}</td><td>${arr.length}</td></tr>`;}).join('')}</tbody></table></div>
    <p class="muted small">Baseline only — no targets set during observation phase (Rule 2).</p>`;
}
function improvementPlan(){
  const validated=Store.col('problems').filter(p=>['Validated','In progress'].includes(p.status)||p.severity==='Critical');
  const prio=p=>({Critical:'P1 Critical',Important:'P2 High',Improvement:'P3 Medium',Minor:'P4 Low'}[p.severity]||'P3 Medium');
  return validated.sort((a,b)=>(b.priorityScore||0)-(a.priorityScore||0)).map(p=>({priority:prio(p),problem:p.problem,cause:p.cause}));
}

/* =========================================================================
   GLOBAL SEARCH
   =======================================================================*/
function renderSearch(v){
  v.innerHTML = pagehead('Global Search','Search across observations, problems, measurements, staff, KPI, HQ interactions and orders.','')
    + `<div class="filters"><input type="text" id="gs" placeholder="Type to search everything…" style="min-width:280px" autofocus></div><div id="gsRes"></div>`;
  $('#gs').oninput=e=>doSearch(e.target.value);
  doSearch('');
}
function doSearch(q){
  q=q.toLowerCase().trim(); const res=[];
  if(q){
    Store.col('observations').forEach(o=>{ if([o.what,o.location,o.ref,o.cause,procName(o.processId)].join(' ').toLowerCase().includes(q)) res.push({t:'Observation',m:o.what,sub:o.date+' · '+(procName(o.processId)||''),go:'observations'}); });
    Store.col('problems').forEach(p=>{ if([p.problem,p.cause,p.evidence,procName(p.processId)].join(' ').toLowerCase().includes(q)) res.push({t:'Problem',m:p.problem,sub:p.severity+' · priority '+p.priorityScore,go:'problems'}); });
    Store.col('staffObs').forEach(s=>{ if([s.observation,empName(s.employeeId),s.attribution].join(' ').toLowerCase().includes(q)) res.push({t:'Staff obs',m:s.observation,sub:empName(s.employeeId),go:'staffobs'}); });
    Store.col('kpiRecords').forEach(r=>{ if((r.metric+' '+r.category).toLowerCase().includes(q)) res.push({t:'KPI',m:r.metric+' = '+r.value+' '+(r.unit||''),sub:r.category+' · '+r.date,go:'kpi'}); });
    Store.col('orders').forEach(o=>{ if((o.orderRef||'').toLowerCase().includes(q)) res.push({t:'Order',m:o.orderRef,sub:o.date,go:'orders'}); });
    Store.col('products').forEach(p=>{ if([p.sku,p.desc,p.discrepancy].join(' ').toLowerCase().includes(q)) res.push({t:'Inbound',m:p.sku+' '+(p.desc||''),sub:p.date,go:'inbound'}); });
    Store.col('hqInteractions').forEach(x=>{ if([x.problem,x.receive,x.send].join(' ').toLowerCase().includes(q)) res.push({t:'HQ',m:x.problem||'(interaction)',sub:(Store.get('departments',x.departmentId)||{}).name,go:'hq'}); });
  }
  $('#gsRes').innerHTML = q? (res.length? `<div class="tablewrap"><table><thead><tr><th>Type</th><th class="wrap">Match</th><th>Detail</th><th></th></tr></thead>
    <tbody>${res.slice(0,80).map(r=>`<tr><td><span class="badge b-muted">${h(r.t)}</span></td><td class="wrap">${h(r.m)}</td><td class="muted small">${h(r.sub||'')}</td><td><a class="btn sm" href="#${r.go}">Open</a></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">No matches for “${h(q)}”.</div>`) : `<div class="empty">Start typing to search.</div>`;
}

/* =========================================================================
   CONFIGURATION
   =======================================================================*/
function renderConfig(v){
  const c=Store.db.config;
  v.innerHTML = pagehead('Configuration','Nothing about the warehouse is hard-coded. Configure processes, departments and employees so the system evolves after the first 30 days.','')
    + `<div class="grid g-2">
      <div class="card"><h3>General</h3>
        <div class="field"><label>Warehouse name</label><input type="text" id="c_name" value="${h(c.warehouseName)}"></div>
        <div class="row2"><div class="field"><label>Observation start date</label><input type="date" id="c_start" value="${h(c.startDate)}"></div>
        <div class="field"><label>Current user / role</label><input type="text" id="c_user" value="${h(c.currentUser)}"></div></div>
        <div class="field"><label>Working days (counted toward the 30)</label>
          <div class="chips" id="c_workdays">${['Die','Hën','Mar','Mër','Enj','Pre','Sht'].map((lbl,i)=>`<span class="chip ${workDays().includes(i)?'on':''}" data-wd="${i}">${lbl}</span>`).join('')}</div>
          <div class="hint">Vetëm këto ditë numërohen si "ditë pune" të vëzhgimit. Vikendet e paseleksionuara anashkalohen (30 = ditë pune, jo kalendarike).</div></div>
        <button class="btn primary" id="c_save">Save settings</button>
      </div>
      <div class="card"><h3>Phases <span class="sub">you can be in more than one at a time</span></h3>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:8px"><input type="checkbox" id="ph_auto" style="width:auto;min-height:auto" ${isPhaseAuto()?'checked':''}> <b>Auto</b> — follow the 30-day calendar</label>
        <div id="ph_manual" style="${isPhaseAuto()?'opacity:.5':''}">
        ${PHASES.map(p=>`<label style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--line)">
            <input type="checkbox" class="ph_pick" data-n="${p.n}" style="width:auto;min-height:auto;margin-top:3px" ${currentPhaseNums().includes(p.n)?'checked':''} ${isPhaseAuto()?'disabled':''}>
            <span><b>Phase ${p.n}: ${p.name}</b> <span class="muted small">days ${p.from}–${p.to}</span><div class="hint">${p.focus.join(' · ')}</div></span></label>`).join('')}
        </div>
        <div class="hint" style="margin-top:6px">Tick <b>Auto</b> to follow the calendar, or untick it and choose the phases you are actually in (e.g. Observe <i>and</i> Map &amp; Measure together).</div>
      </div>
      <div class="card"><h3>Processes <span class="sub">${activeProcesses().length} active</span></h3>
        <div class="btnrow" style="margin-bottom:8px"><button class="btn sm primary" id="addProc">＋ Process</button></div>
        <div id="procList"></div></div>
      <div class="card"><h3>Departments <span class="sub">${Store.col('departments').length}</span></h3>
        <div class="btnrow" style="margin-bottom:8px"><button class="btn sm primary" id="addDep">＋ Department</button></div>
        <div id="depList"></div></div>
      <div class="card"><h3>Employees <span class="sub">${Store.col('employees').length}</span></h3>
        <div class="btnrow" style="margin-bottom:8px"><button class="btn sm primary" id="addEmp2">＋ Employee</button></div>
        <div id="empList"></div></div>
    </div>`;
  $$('#c_workdays .chip').forEach(ch=>ch.onclick=()=>ch.classList.toggle('on'));   // multi-select weekdays
  $('#c_save').onclick=()=>{
    const wd=$$('#c_workdays .chip.on').map(x=>+x.dataset.wd).sort();
    Object.assign(c,{warehouseName:$('#c_name').value.trim()||'My Warehouse', startDate:$('#c_start').value, currentUser:$('#c_user').value.trim()||'Warehouse Lead', workDays: wd.length?wd:[1,2,3,4,5]}); Store.persist(); updatePills(); toast('Settings saved'); };
  $('#addProc').onclick=()=>openProcForm();
  $('#addDep').onclick=()=>openDepForm();
  $('#addEmp2').onclick=()=>openEmpForm();
  // phase selection: Auto (calendar) vs manual multi-select
  function savePhases(){
    if($('#ph_auto').checked){ delete c.activePhases; }
    else { const nums=$$('.ph_pick').filter(x=>x.checked).map(x=>+x.dataset.n); c.activePhases = nums.length?nums:[autoPhase().n]; }
    Store.persist(); updatePills();
  }
  $('#ph_auto').onchange=()=>{ const auto=$('#ph_auto').checked;
    if(auto) delete c.activePhases; else c.activePhases = currentPhaseNums().slice();  // seed manual from whatever is current
    Store.persist(); go(); };   // re-render to enable/disable the phase checkboxes
  $$('.ph_pick').forEach(cb=>cb.onchange=savePhases);
  drawConfigLists();
}
function drawConfigLists(){
  const pl=$('#procList'); if(pl){ pl.innerHTML=activeProcesses().map(p=>`<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)"><span class="badge b-muted">${h(p.category)}</span><span style="flex:1">${h(p.name)}</span>
    <select class="small" style="min-height:32px;padding:4px 6px;width:auto" data-ft="${p.id}">${FLOW_TYPES.map(t=>`<option value="${t}" ${(p.flowType||defaultFlowType(p.name))===t?'selected':''}>${t}</option>`).join('')}</select>
    <button class="btn sm danger" data-dp="${p.id}">✕</button></div>`).join('') + `<div class="hint" style="margin-top:6px">Classification: ${flowTypeLegend()}</div>`;
    $$('#procList [data-ft]').forEach(sel=>sel.onchange=()=>{ Store.update('processes',sel.dataset.ft,{flowType:sel.value}); toast('Classification updated'); }); }
  const dl=$('#depList'); if(dl) dl.innerHTML=Store.col('departments').map(d=>`<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)"><span style="flex:1">${h(d.name)}</span><button class="btn sm" data-ded="${d.id}">Edit</button><button class="btn sm danger" data-dd="${d.id}">✕</button></div>`).join('');
  const el=$('#empList'); if(el) el.innerHTML=Store.col('employees').map(e=>`<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)"><span style="flex:1">${h(e.name)} <span class="faint small">${h(e.role||'')}${e.active===false?' · inactive':''}</span></span><button class="btn sm" data-ee="${e.id}">Edit</button><button class="btn sm danger" data-de="${e.id}">✕</button></div>`).join('');
  $$('#procList [data-dp]').forEach(b=>b.onclick=()=>{const p=Store.get('processes',b.dataset.dp);confirmDelete(p.name,()=>{Store.remove('processes',p.id);go();});});
  $$('#depList [data-dd]').forEach(b=>b.onclick=()=>{const d=Store.get('departments',b.dataset.dd);confirmDelete(d.name,()=>{Store.remove('departments',d.id);go();});});
  $$('#depList [data-ded]').forEach(b=>b.onclick=()=>openDepForm(Store.get('departments',b.dataset.ded)));
  $$('#empList [data-de]').forEach(b=>b.onclick=()=>{const e=Store.get('employees',b.dataset.de);confirmDelete(e.name,()=>{Store.remove('employees',e.id);go();});});
  $$('#empList [data-ee]').forEach(b=>b.onclick=()=>openEmpForm(Store.get('employees',b.dataset.ee)));
}
function openProcForm(){
  const fields=[{name:'name',label:'Process name',type:'text',required:true,row:'a'},{name:'category',label:'Category',type:'select',options:['Inbound','Outbound','Other'],required:true,row:'a'},
    {name:'flowType',label:'Flow classification',type:'select',options:FLOW_TYPES,value:'Linked',hint:flowTypeLegend()}];
  openForm({title:'New process',fields,values:{flowType:'Linked'},onSave:(vals)=>{ const max=Math.max(0,...Store.col('processes').map(p=>p.order||0)); Store.insert('processes',{...vals,flowType:vals.flowType||'Linked',order:max+1,active:true}); closeModal(); go(); toast('Process added'); }});
}
function openDepForm(existing){
  const fields=[{name:'name',label:'Department name',type:'text',required:true}];
  openForm({title:existing?'Edit department':'New department',fields,values:existing||{},
    onSave:(vals)=>{ if(existing) Store.update('departments',existing.id,vals); else Store.insert('departments',vals);
      closeModal(); go(); toast('Department saved'); }});
}

/* =========================================================================
   DATA & EXPORT
   =======================================================================*/
function renderData(v){
  const counts=seedCollections.filter(c=>c!=='config').map(c=>[c,Store.col(c).length]);
  v.innerHTML = pagehead('Data & Export','Everything is stored locally in your browser (localStorage). Export to CSV/JSON for backup or sharing. Reports print to PDF from the Reports page.','')
    + `<div class="grid g-2">
      <div class="card"><h3>Export</h3>
        <div class="btnrow"><button class="btn primary" id="exJSON">⬇ Full backup (JSON)</button></div>
        <div class="hint" style="margin:10px 0 6px">Export a table to CSV:</div>
        <div class="btnrow">${['observations','measurements','problems','kpiRecords','orders','products','staffObs','hqInteractions'].map(c=>`<button class="btn sm" data-csv="${c}">${c}</button>`).join('')}</div>
      </div>
      <div class="card"><h3>Import / Restore</h3>
        <div class="field"><label>Merge from JSON backup <span class="sub">(recommended)</span></label><input type="file" id="mergeFile" accept="application/json"></div>
        <div class="hint" style="margin-bottom:10px">Shton vëzhgimet/matjet/punëtorët nga një backup i kaluar <b>pa i fshirë</b> të dhënat aktuale. Ruan të dhënat & cilësimet e WMS-it. Ideale për të inkorporuar grumbullimet e kaluara.</div>
        <div class="field"><label>Restore from JSON backup</label><input type="file" id="impFile" accept="application/json"></div>
        <div class="hint">⚠ This <b>replaces</b> all current data (including WMS — do a Sync afterwards).</div>
      </div>
      <div class="card"><h3>Stored records</h3><div class="tablewrap"><table><tbody>${counts.map(([c,n])=>`<tr><td>${h(c)}</td><td><b>${n}</b></td></tr>`).join('')}</tbody></table></div>
        <div class="hint" style="margin-top:8px">Audit log entries: <b>${Store.col('audit').length}</b></div></div>
      <div class="card"><h3>Audit log <span class="sub">latest 30</span></h3><div class="tablewrap" style="max-height:300px;overflow:auto"><table><thead><tr><th>When</th><th>Action</th><th>Entity</th></tr></thead>
        <tbody>${Store.col('audit').slice(0,30).map(a=>`<tr><td class="small">${h(new Date(a.at).toLocaleString())}</td><td>${h(a.action)}</td><td class="small muted">${h(a.entity)} ${h((a.snapshot||'').slice(0,24))}</td></tr>`).join('')||emptyRow(3,'No changes yet.')}</tbody></table></div></div>
      <div class="card"><h3 style="color:var(--crit)">Danger zone</h3><button class="btn danger" id="resetBtn">Reset all data</button><div class="hint">Wipes local data and reseeds. Cannot be undone — export a backup first.</div></div>
    </div>`;
  $('#exJSON').onclick=()=>downloadFile('warehouse-backup-'+todayStr()+'.json', JSON.stringify(Store.db,null,2),'application/json');
  $$('#view [data-csv]').forEach(b=>b.onclick=()=>exportCSV(b.dataset.csv));
  $('#impFile').onchange=e=>{ const f=e.target.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{ try{ const d=JSON.parse(r.result); Store.db=d; seedCollections.forEach(c=>{if(!Store.db[c])Store.db[c]=[];}); Store.persist(); toast('Data restored'); go(); }catch(err){ toast('Invalid file'); } }; r.readAsText(f); };
  $('#mergeFile').onchange=e=>{ const f=e.target.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{ try{ const d=JSON.parse(r.result); const n=mergeBackupData(d); toast('U bashkuan '+n+' rekorde'); go(); }catch(err){ toast('Invalid file'); } }; r.readAsText(f); };
  $('#resetBtn').onclick=()=>{ openModal('Reset all data','<p class="crit">This wipes all local records and reseeds defaults. Export a backup first. Continue?</p>',
    `<button class="btn ghost" id="mcancel">Cancel</button><button class="btn danger" id="mdo">Reset everything</button>`);
    $('#mcancel').onclick=closeModal; $('#mdo').onclick=()=>{ localStorage.removeItem(DB_KEY); Store.db=null; Store.load(); closeModal(); toast('Reset complete'); location.hash='#dashboard'; go(); }; };
}
/* Merge a past backup into the current DB without wiping current data.
   Adds records (union by id) for manual collections; KEEPS current WMS data & settings
   (they are re-syncable from the agent). Prefers the backup's config (start date, phase). */
function mergeBackupData(backup){
  if(!backup || typeof backup!=='object') throw new Error('bad backup');
  const cur=Store.db;
  const wmsCols=['wmsLogs','wmsStats','wmsShifts','wmsSyncLog','wmsOrders','wmsPrepared','wmsCheckin','wmsFlow'];
  let added=0;
  Object.keys(backup).forEach(k=>{
    if(k==='config' || k==='wms') return;      // handled below
    if(!Array.isArray(backup[k])) return;       // only collections
    if(wmsCols.includes(k)) return;             // keep current WMS data (re-syncable)
    const cur0=cur[k]||(cur[k]=[]);
    const ids=new Set(cur0.map(r=>r&&r.id));
    backup[k].forEach(r=>{ if(r && r.id && !ids.has(r.id)){ cur0.push(r); ids.add(r.id); added++; } });
  });
  // config: take the backup's (correct start date / phase), union migrations, keep current if backup lacks it
  if(backup.config){ cur.config=Object.assign({}, cur.config, backup.config,
    {migrations:Object.assign({}, (cur.config&&cur.config.migrations)||{}, backup.config.migrations||{})}); }
  // WMS agent settings: keep current; adopt backup's only if none set
  if(!cur.wms && backup.wms) cur.wms=backup.wms;
  seedCollections.forEach(c=>{ if(!cur[c]) cur[c]=[]; });
  Store.persist();
  return added;
}
function downloadFile(name,content,type){
  const blob=new Blob([content],{type}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
/* Human-readable export: ID fields become names, *Sec fields become minutes/seconds. */
const EXPORT_NAME_FIELDS={processId:'process', employeeId:'employee', picker:'picker', owner:'owner', departmentId:'department'};
function exportFieldName(k){ if(k in EXPORT_NAME_FIELDS) return EXPORT_NAME_FIELDS[k]; if(/Sec$/.test(k)) return k.replace(/Sec$/,''); return k; }
function exportFieldValue(k,v){
  if(k==='processId') return procName(v)||v||'';
  if(k==='employeeId'||k==='picker'||k==='owner') return empName(v)||(v||'');
  if(k==='departmentId'){ const d=Store.get('departments',v); return d?d.name:(v||''); }
  if(/Sec$/.test(k)) return v==null||v===''?'':fmtDur(v);   // processing / waiting / total in minutes (or sec if <60)
  return v;   // counts like interruptions, rework, orders, lines, units stay as-is
}
function exportCSV(col){
  const rows=Store.col(col); if(!rows.length){ toast('Nothing to export'); return; }
  const tRows=rows.map(r=>{ const o={}; Object.keys(r).forEach(k=>{
    if(k==='operators' && Array.isArray(r[k])){ o.operators=r[k].map(empName).filter(Boolean).join('; '); return; }
    if(typeof r[k]==='object'&&r[k]!==null) return;
    o[exportFieldName(k)]=exportFieldValue(k,r[k]); }); return o; });
  const keys=[...new Set(tRows.flatMap(r=>Object.keys(r)))];
  const esc=v=>{ if(v==null)return''; v=typeof v==='object'?JSON.stringify(v):String(v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const csv=[keys.join(',')].concat(tRows.map(r=>keys.map(k=>esc(r[k])).join(','))).join('\n');
  // Prepend a UTF-8 BOM so Excel reads "ë", "ç" etc. correctly instead of mojibake (Ã«).
  downloadFile(col+'-'+todayStr()+'.csv', '\uFEFF'+csv, 'text/csv;charset=utf-8');
}

/* =========================================================================
   WMS DATA & PERFORMANCE  (import-based; source = GjirafaWMS)
   Discovered endpoints (authorized, read-only):
     GET  /Warehouse/GetDashboardStats  -> {invoiceProductsCheckedIn, invoiceProductsProcessed,
            invoiceProductsToCheckIn, ordersReadyToUnmap, ordersInProcessing}   (LIVE totals)
     POST /Warehouse/ProductLogsData    -> DataTables rows: UpdatedByName(operator), LogType(action),
            OrderId, InsertDateTime, Sku, ProductCode, Row(location), ProductName  (needs date range + token)
   The offline app cannot call WMS directly (CORS + session cookie), so data is IMPORTED as JSON/CSV
   produced by an authorized fetch run inside the logged-in WMS tab. No WMS business logic is assumed:
   LogType values are stored as-is and mapped by the Lead.
   =======================================================================*/
function wmsCfg(){ const c=Store.db.wms || (Store.db.wms={url:'https://wms.gjirafamall.com/',logTypeMap:{}});
  if(c.autoSync===undefined) c.autoSync=true; if(c.interval===undefined) c.interval=30;
  if(c.agentBase===undefined) c.agentBase=''; if(!c.logTypeMap) c.logTypeMap={};
  return c; }
function wmsOnAgent(){ return location.protocol==='http:'||location.protocol==='https:'; }
function wmsAgentBase(){ return (wmsCfg().agentBase||'').replace(/\/+$/,'') || (wmsOnAgent()?location.origin:''); }
/* pull stats + prepared (last N days) from the local agent and import (idempotent) */
async function wmsAgentSync(days, checkinDays){
  const base=wmsAgentBase(); if(!base) return {ok:false,msg:'No agent (open the app via the local agent at http://localhost:8790)'};
  const p2=n=>('0'+n).slice(-2); const dd=d=>p2(d.getDate())+'/'+p2(d.getMonth()+1)+'/'+d.getFullYear();
  const end=new Date(), start=new Date(); start.setDate(start.getDate()-((days||7)-1));
  // check-in pulls are heavier (event-log paging). Fetch only days we don't already have
  // within the window (plus always today, which keeps changing) to avoid re-paging history.
  const cWin=(checkinDays||days||7);
  const cEnd=new Date(); let cStart=new Date();
  (()=>{ const iso=d=>d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
    // a day is "complete" only if it has rows AND those rows carry checkedOut (older rows lack it → refetch to backfill)
    const complete=new Set(); const byDate={};
    Store.col('wmsCheckin').forEach(r=>{ (byDate[r.date]=byDate[r.date]||[]).push(r); });
    Object.keys(byDate).forEach(d=>{ if(byDate[d].some(r=>r.checkedOut!=null)) complete.add(d); });
    let earliestMissing=new Date(); // default = today
    for(let i=0;i<cWin;i++){ const d=new Date(); d.setDate(d.getDate()-i); if(i===0 || !complete.has(iso(d))) earliestMissing=d; }
    cStart=earliestMissing; })();
  const cfg=wmsCfg(); let msg=[];
  try{
    const s=await fetch(base+'/wms/stats').then(r=>r.json());
    if(s&&s.error) throw new Error(s.error);
    wmsImportStats(s,{sourceRef:'agent'}); msg.push('snapshot ✓');
    const pr=await fetch(base+'/wms/prepared?start='+encodeURIComponent(dd(start))+'&end='+encodeURIComponent(dd(end))).then(r=>r.json());
    if(pr&&pr.error) throw new Error(pr.error);
    const res=wmsImportPrepared(pr.rows||[],{dateRange:dd(start)+' - '+dd(end),sourceRef:'agent'});
    msg.push('prepared: '+res.inserted+' new, '+res.updated+' upd, '+res.dups+' dup');
    // check-in is heavier (event-log paging); don't let a hiccup fail the whole sync
    try{
      const ci=await fetch(base+'/wms/checkin?start='+encodeURIComponent(dd(cStart))+'&end='+encodeURIComponent(dd(cEnd))).then(r=>r.json());
      if(ci&&ci.error) throw new Error(ci.error);
      const cres=wmsImportCheckin(ci.rows||[],{dateRange:dd(cStart)+' - '+dd(cEnd),sourceRef:'agent'});
      msg.push('checked-in: '+cres.inserted+' new, '+cres.updated+' upd, '+cres.dups+' dup');
      if(ci.daily) wmsImportFlow(ci.daily,{sourceRef:'agent'});
    }catch(ce){ msg.push('checked-in: skipped ('+String(ce.message||ce)+')'); }
    cfg.lastSuccess=nowISO(); cfg.lastError=''; Store.persist();
    return {ok:true,msg:msg.join(' · ')};
  }catch(e){ cfg.lastError=String(e.message||e); cfg.lastFailed=nowISO(); Store.persist();
    return {ok:false,msg:String(e.message||e)}; }
}
let wmsAutoTimer=null;
function wmsScheduleAuto(){
  if(wmsAutoTimer){ clearInterval(wmsAutoTimer); wmsAutoTimer=null; }
  if(wmsCfg().autoSync && wmsOnAgent()){
    const mins=Math.max(5,wmsCfg().interval||30);
    wmsAutoTimer=setInterval(()=>{ wmsAgentSync(7,1).then(()=>{ if((location.hash||'')==='#wms') renderWMS($('#view')); }); }, mins*60000);
  }
}
function wmsTimeToMin(hhmm){ const p=(hhmm||'0:0').split(':'); return (+p[0])*60+(+(p[1]||0)); }
/* assignShift(timestamp): local shift config; overlap or no match => UNKNOWN (never guessed) */
function wmsAssignShift(iso){
  if(!iso) return 'UNKNOWN';
  const d=new Date(iso); if(isNaN(d)) return 'UNKNOWN';
  const isWeekend=(d.getDay()===0||d.getDay()===6);
  const mins=d.getHours()*60+d.getMinutes();
  const shifts=(Store.col('wmsShifts')||[]).filter(s=>s.active!==false);
  const inShift=s=>{ const a=wmsTimeToMin(s.start),b=wmsTimeToMin(s.end); return b>=a?(mins>=a&&mins<b):(mins>=a||mins<b); };
  let pool=isWeekend?shifts.filter(s=>s.weekend):shifts.filter(s=>!s.weekend);
  let m=pool.filter(inShift);
  if(!m.length && isWeekend) m=shifts.filter(s=>!s.weekend).filter(inShift);
  return m.length===1 ? m[0].name : 'UNKNOWN';
}
function wmsParseDate(v){
  if(v==null||v==='') return '';
  if(typeof v==='string'){
    const ms=v.match(/\/Date\((\d+)/); if(ms) return new Date(+ms[1]).toISOString();
    let d=new Date(v); if(!isNaN(d)) return d.toISOString();
    // DD/MM/YYYY HH:mm(:ss) — Kosovo locale
    const m=v.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})[ T]?(\d{1,2})?:?(\d{2})?:?(\d{2})?/);
    if(m){ const dd=+m[1],mm=+m[2],yy=+m[3],H=+(m[4]||0),Mi=+(m[5]||0),S=+(m[6]||0);
      d=new Date(yy,mm-1,dd,H,Mi,S); if(!isNaN(d)) return d.toISOString(); }
    return '';
  }
  if(typeof v==='number'){ const d=new Date(v); return isNaN(d)?'':d.toISOString(); }
  return '';
}
function wmsNormalizeLog(raw){
  const iso=wmsParseDate(raw.InsertDateTime??raw.insertDateTime??raw.when??raw.Date);
  return {
    uniqueId:(raw.UniqueId??raw.uniqueId??raw.Id??'').toString().trim(),
    logType:(raw.LogType??raw.logType??raw.Status??raw.status??'').toString().trim(),
    operator:(raw.UpdatedByName??raw.operator??raw.User??raw.user??'').toString().trim(),
    orderId:(raw.OrderId??raw.orderId??'').toString().trim(),
    sku:(raw.Sku??raw.sku??'').toString().trim(),
    productCode:(raw.ProductCode??raw.ean??'').toString().trim(),
    productName:(raw.ProductName??'').toString().trim(),
    location:(raw.Row??raw.location??'').toString().trim(),
    insertDateTime:iso, date: iso?iso.slice(0,10):''
  };
}
function wmsRowKey(r){ return ['WMS',r.uniqueId,r.logType,r.orderId,r.sku,r.insertDateTime,r.operator].join('|'); }
function wmsImportLogs(rawRows, meta){
  const t0=Date.now(); meta=meta||{};
  const col=Store.col('wmsLogs');
  const existing=new Set(col.map(wmsRowKey));
  let inserted=0,dups=0,warn=0; const wset=new Set();
  rawRows.forEach(raw=>{
    const n=wmsNormalizeLog(raw);
    if(!n.insertDateTime) wset.add('Unparseable timestamp');
    if(!n.operator) wset.add('Operator missing');
    n.shift = n.insertDateTime? wmsAssignShift(n.insertDateTime):'UNKNOWN';
    if(n.shift==='UNKNOWN' && n.insertDateTime) wset.add('Shift could not be determined');
    const key=wmsRowKey(n);
    if(existing.has(key)){ dups++; return; }
    existing.add(key);
    col.unshift({...n, id:uid('wl'), source:'WMS', sourceRef:meta.sourceRef||'', importedAt:nowISO()});
    inserted++;
  });
  warn=wset.size;
  Store.col('wmsSyncLog').unshift({ id:uid('slog'), at:nowISO(), operation:'ProductLogs import', dateRange:meta.dateRange||'',
    retrieved:rawRows.length, inserted, updated:0, duplicates:dups, warnings:warn, errors:0,
    durationMs:Date.now()-t0, status: warn?'WARNING':'VALID', notes:[...wset].join('; ') });
  wmsCfg().lastSuccess=nowISO();
  Store.persist();
  return {inserted,dups,warn,warnings:[...wset]};
}
/* WMS imports live in shared.js (same code runs in the agent's 21:30 job); these wrappers persist. */
function wmsImportStats(obj, meta){ const rec=WODS.importStats(Store.db,obj,meta); Store.persist(); return rec; }
function wmsOperatorAgg(fromDate,toDate,shiftFilter){
  const logs=Store.col('wmsLogs').filter(l=>{ if(fromDate&&l.date<fromDate)return false; if(toDate&&l.date>toDate)return false; if(shiftFilter&&l.shift!==shiftFilter)return false; return true; });
  const map={};
  logs.forEach(l=>{ const k=l.operator+'|'+l.date+'|'+l.shift;
    const g=map[k]||(map[k]={operator:l.operator||'(unknown)',date:l.date,shift:l.shift,events:0,orders:new Set(),logTypes:{},first:null,last:null});
    g.events++; if(l.orderId)g.orders.add(l.orderId); if(l.logType)g.logTypes[l.logType]=(g.logTypes[l.logType]||0)+1;
    const t=l.insertDateTime; if(t){ if(!g.first||t<g.first)g.first=t; if(!g.last||t>g.last)g.last=t; } });
  return Object.values(map).map(g=>{ const hrs=(g.first&&g.last)?(new Date(g.last)-new Date(g.first))/3600000:0;
    return {operator:g.operator,date:g.date,shift:g.shift,events:g.events,orders:g.orders.size,logTypes:g.logTypes,
      first:g.first,last:g.last,hours:hrs, evPerHour:hrs>0?Math.round(g.events/hrs*10)/10:null, ordPerHour:hrs>0?Math.round(g.orders.size/hrs*10)/10:null}; })
    .sort((a,b)=> a.date<b.date?1:a.date>b.date?-1:(b.events-a.events));
}
function wmsAllLogTypes(){ return [...new Set(Store.col('wmsLogs').map(l=>l.logType).filter(Boolean))].sort(); }
function fmtTime(iso){ if(!iso)return'—'; const d=new Date(iso); return isNaN(d)?'—':d.toTimeString().slice(0,5); }

let wmsTab='dashboard';
function renderWMS(v){
  const cfg=wmsCfg();
  const nLogs=Store.col('wmsLogs').length;
  const nData=nLogs+Store.col('wmsStats').length+Store.col('wmsPrepared').length;
  const onAgent=(typeof wmsOnAgent==='function')&&wmsOnAgent();
  let connBadge, connHint;
  if(onAgent){
    connBadge=`<span class="badge b-ok">🟢 Agjenti i lidhur</span>`
      + `<span class="badge ${cfg.autoSync?'b-ok':'b-muted'}">Auto-sync ${cfg.autoSync?('ON · çdo '+(cfg.interval||30)+' min'):'OFF'}</span>`;
    connHint=(cfg.lastError
      ? `<div class="hint" style="margin-top:6px;color:#f2a">⚠ ${h(cfg.lastError)==='auth_expired'?'Sesioni i WMS ka skaduar (ndodh kur PC-ja rri i fikur / në sleep — serveri e mbyll sesionin). Ngjit cookie-n e re më poshtë; agjenti e provon dhe e ruan vetë.':h(cfg.lastError)}</div>`
      : `<div class="hint" style="margin-top:6px">Të dhënat merren <b>automatikisht</b> nga agjenti lokal (localhost) me sesionin tënd të autorizuar të WMS-it. S'ka hapa manualë.</div>`)
      + `<div class="hint" id="wmsHealthLine" style="margin-top:4px"></div>`
      + `<div id="wmsCookieBox" style="margin-top:8px;${cfg.lastError==='auth_expired'?'':'display:none'}">
           <div class="note" style="margin-bottom:8px"><b>Mënyra pa kopjime — ekstensioni "WMS Agent Link"</b> (instalohet <b>një herë</b>, 30 sekonda):
             <ol style="margin:6px 0 4px 18px;padding:0">
               <li>Chrome → shkruaj <code>chrome://extensions</code> → ndiz <b>Developer mode</b> (djathtas lart).</li>
               <li><b>Load unpacked</b> → zgjidh folderin <code>C:\\Users\\Xhevati\\Desktop\\warehouse-observation-app\\chrome-extension</code>.</li>
               <li>Hap <a href="https://wms.gjirafamall.com" target="_blank" rel="noopener">wms.gjirafamall.com</a> dhe kyçu si zakonisht.</li>
             </ol>
             Nga ai moment, sa herë je i kyçur në WMS në Chrome, ekstensioni ia jep sesionin agjentit vetë (edhe kur skadon dhe rikyçesh). Asgjë nuk del nga ky kompjuter.</div>
           <div class="small muted" style="margin-bottom:4px">Alternativa manuale (vetëm nëse s'do ekstension): Chrome, i kyçur në WMS deri te dashboard-i → F12 → Network → F5 → një kërkesë e re → Request Headers → <code>cookie:</code> → kopjo gjithë vlerën (~3 000+ shkronja, pa <code>OpenIdConnect.nonce</code>) dhe ngjite këtu:</div>
           <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
             <textarea id="wmsCookieIn" rows="3" placeholder="gjs=…; ASP.NET_SessionId=…; .AspNet.Cookies=…" style="flex:1;min-width:260px;font-family:monospace;font-size:11.5px"></textarea>
             <button class="btn primary" id="wmsCookieSave">🔑 Ruaj cookie-n</button>
           </div>
           <div class="hint" id="wmsCookieMsg" style="margin-top:4px"></div>
         </div>
         ${cfg.lastError==='auth_expired'?'':'<button class="btn sm ghost" id="wmsCookieToggle" style="margin-top:6px">🔑 Ndrysho cookie-n e WMS</button>'}`;
    setTimeout(()=>{
      const tg=$('#wmsCookieToggle'); if(tg) tg.onclick=()=>{ const b=$('#wmsCookieBox'); b.style.display=b.style.display==='none'?'':'none'; };
      const save=$('#wmsCookieSave'); if(save) save.onclick=async()=>{
        const val=($('#wmsCookieIn').value||'').trim(); const msg=$('#wmsCookieMsg');
        if(!val){ msg.textContent='Ngjit vlerën e cookie-s së pari.'; return; }
        save.disabled=true; save.textContent='⏳ Po provohet me WMS…';
        try{ const r=await fetch('/wms/cookie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:val})}); const j=await r.json();
          if(!r.ok||j.error) throw new Error(j.error||('HTTP '+r.status));
          $('#wmsCookieIn').value=''; msg.innerHTML='<span style="color:var(--ok)">✓ Cookie e pranuar — WMS u përgjigj. Po sinkronizoj…</span>';
          wmsCfg().lastError=''; Store.persist();
          await wmsAgentSync(7,1); toast('Cookie e re · sync ✓'); renderWMS($('#view'));
        }catch(e){ msg.innerHTML='<span style="color:var(--crit)">✗ '+h(e.message)+'</span>'; save.disabled=false; save.textContent='🔑 Ruaj cookie-n'; }
      };
    },0);
    // agent self-report: does it start with Windows, how often does it renew the session, is the session alive right now
    fetch('/wms/health',{cache:'no-store'}).then(r=>r.json()).then(hh=>{ const el=$('#wmsHealthLine'); if(!el) return;
      el.innerHTML = `${hh.autostart?'<span class="badge b-ok">Niset me Windows ✓</span>':'<span class="badge b-warn">Nuk niset me Windows</span> <span class="muted">→ ekzekuto <b>install-autostart.bat</b></span>'}`
        + ` <span class="badge b-muted">Keep-alive çdo ${h(String(hh.keepAliveMin||'?'))} min</span>`
        + ` <span class="badge ${hh.sessionExpired?'b-crit':'b-ok'}">Sesioni WMS: ${hh.sessionExpired?'i skaduar':'aktiv'}</span>`
        + ` <span class="muted small">Sesioni mbahet gjallë vetëm sa kohë PC-ja është ndezur dhe agjenti punon — vendos <i>Sleep: Never</i> për të mos skaduar natën.</span>`; }).catch(()=>{});
  } else {
    connBadge=`<span class="badge b-muted">Agjenti jo aktiv</span>`;
    connHint=`<div class="hint" style="margin-top:6px">Për sync <b>automatik</b>: nis <b>start-wms-agent.bat</b> dhe hape app-in nga <b>http://localhost:8790/app.html</b>. Ndryshe, përdor <b>import të autorizuar</b> te skeda <b>Import</b>.</div>`;
  }
  const conn=`<div class="card" style="margin-bottom:14px"><div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:13px">
      <b>🔌 WMS Connection</b>
      <span class="muted">URL: <b>${h(cfg.url)}</b></span>
      ${connBadge}
      <span class="muted">Last sync: ${cfg.lastSuccess?h(new Date(cfg.lastSuccess).toLocaleString()):'—'}</span>
      <span class="muted">Rows: <b>${nData}</b></span>
    </div>
    ${connHint}</div>`;
  const tabs=[['dashboard','Dashboard'],['operators','Operators'],['import','Import'],['validation','Validation'],['shifts','Shifts'],['log','Sync Log']];
  v.innerHTML = pagehead('WMS Data & Performance','Marrje, ruajtje, filtrim dhe analizë e të dhënave nga GjirafaWMS — Products Checked In, Orders, dhe performanca për operator/ditë/ndërrim. Të gjurmueshme, pa hamendje.')
    + conn
    + `<div class="filters" id="wmsTabs">${tabs.map(t=>`<button class="btn ${wmsTab===t[0]?'primary':''}" data-wtab="${t[0]}">${t[1]}</button>`).join('')}</div>`
    + `<div id="wmsBody"></div>`;
  $$('#wmsTabs [data-wtab]').forEach(b=>b.onclick=()=>{ wmsTab=b.dataset.wtab; renderWMS(v); });
  const body=$('#wmsBody');
  ({dashboard:wmsDashboard, operators:wmsOperators, import:wmsImport, validation:wmsValidation, shifts:wmsShiftsView, log:wmsLog}[wmsTab]||wmsDashboard)(body);
}

/* "Orders prepared" KPI, as a single Line with Markers chart of the daily total (sum across
   operators) over the last 14 days with data. An earlier version broke this down per operator as a
   100%-stacked chart, but that composition wasn't clear at a glance — reverted to the plain daily
   total, which is what this tile always meant. Pure SVG, no library. */
function niceCeil(v){ if(v<=0) return 10; const mag=Math.pow(10,Math.floor(Math.log10(v))); const norm=v/mag; const step=norm<=1?1:norm<=2?2:norm<=5?5:10; return step*mag; }
function wmsPrepStackedChartHTML(){
  const prep=Store.col('wmsPrepared'); if(!prep.length) return '';
  const byDay={}; prep.forEach(r=>{ byDay[r.date]=(byDay[r.date]||0)+num(r.preparedOrders); });
  const days=Object.keys(byDay).filter(d=>byDay[d]>0).sort().slice(-14);
  if(!days.length) return '';
  const lastDay=days[days.length-1];
  const lastTotal=byDay[lastDay];
  const maxV=niceCeil(Math.max(...days.map(d=>byDay[d])));
  const color='var(--ok)';
  const W=320,H=92,padL=22,padR=3,padT=14,padB=4;
  const x=i=> days.length>1? padL+(W-padL-padR)*(i/(days.length-1)) : (padL+W-padR)/2;
  const y=v=> padT+(H-padT-padB)*(1-v/maxV);
  const pts=days.map((d,i)=>[x(i), y(byDay[d])]);
  const poly=pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
  const area=`${padL.toFixed(1)},${y(0).toFixed(1)} `+poly+` ${x(days.length-1).toFixed(1)},${y(0).toFixed(1)}`;
  const markers=pts.map((p,i)=>{ const d=days[i];
    return `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.4" fill="${color}"><title>${h(fmtDateAl(d))}: ${byDay[d]} porosi</title></circle>`; }).join('');
  const gridSvg=[0,0.25,0.5,0.75,1].map(f=>{ const v=Math.round(maxV*f);
    return `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W-padR}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1" stroke-dasharray="2,3"/>`
      +`<text x="${padL-3}" y="${(y(v)+2).toFixed(1)}" text-anchor="end" font-size="6" fill="var(--faint)">${v}</text>`; }).join('');
  // date ticks along the top — thin them out so labels never overlap in the ~300px-wide plot
  const dateStep=Math.max(1, Math.ceil(days.length/6));
  const dateSvg=days.map((d,i)=>(i%dateStep===0||i===days.length-1)
    ? `<text x="${x(i).toFixed(1)}" y="${(padT-4).toFixed(1)}" text-anchor="middle" font-size="6" fill="var(--faint)">${h(fmtDateAl(d).slice(0,5))}</text>` : '').join('');
  return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0">Porosi të përgatitura <span class="sub">Line with Markers · ${h(fmtDateAl(days[0]))}–${h(fmtDateAl(lastDay))}</span></h3>
        <div style="text-align:right"><div class="val" style="font-size:20px;font-weight:800">${lastTotal}</div><div class="faint" style="font-size:11px">${h(fmtDateAl(lastDay))} · sum across operators</div></div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="width:100%;height:auto;display:block;margin-top:6px">
        <defs><linearGradient id="prepFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".35"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
        ${gridSvg}${dateSvg}
        <polygon points="${area}" fill="url(#prepFill)" stroke="none"/>
        <polyline points="${poly}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        ${markers}
      </svg>
    </div>`;
}
function wmsDashboard(box){
  const logs=Store.col('wmsLogs');
  const snap=Store.col('wmsStats')[0];
  const byDay={}, byOp={}, byOrderOp={}, byShift={};
  logs.forEach(l=>{ byDay[l.date]=(byDay[l.date]||0)+1; byOp[l.operator||'(unknown)']=(byOp[l.operator||'(unknown)']||0)+1; byShift[l.shift]=(byShift[l.shift]||0)+1; });
  // orders by operator (distinct)
  const opOrders={}; logs.forEach(l=>{ if(!l.orderId)return; (opOrders[l.operator||'(unknown)']=opOrders[l.operator||'(unknown)']||new Set()).add(l.orderId); });
  const kc=(val,lbl,foot)=>`<div class="card kpi"><div class="val">${val}</div><div class="lbl">${lbl}</div>${foot?`<div class="foot">${foot}</div>`:''}</div>`;
  const dayRows=Object.entries(byDay).sort((a,b)=>a[0]<b[0]?-1:1).slice(-14);
  const maxDay=Math.max(1,...dayRows.map(r=>r[1]));
  const opRows=Object.entries(byOp).sort((a,b)=>b[1]-a[1]).slice(0,10); const maxOp=Math.max(1,...opRows.map(r=>r[1]));
  const ordRows=Object.entries(opOrders).map(([k,s])=>[k,s.size]).sort((a,b)=>b[1]-a[1]).slice(0,10); const maxOrd=Math.max(1,...ordRows.map(r=>r[1]));
  box.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn" onclick="exportWmsExcel()" title="Eksporto të dhënat e kartave në Excel (.xls, disa fleta)">⬇ Export në Excel</button>
    </div>
    <div class="grid g-kpi" style="margin-bottom:14px">
      ${kc(snap&&snap.ordersReadyToUnmap!=null?snap.ordersReadyToUnmap:'—','Orders Ready To Complete', snap?'live snapshot':'—')}
      ${kc(snap&&snap.invoiceProductsToCheckIn!=null?snap.invoiceProductsToCheckIn:'—','Products To Check In', snap?'live snapshot':'—')}
      ${kc(snap?snap.invoiceProductsCheckedIn:'—','Products Checked In', snap?'live snapshot '+h(new Date(snap.at).toLocaleString()):'import a snapshot')}
      ${kc(snap?snap.invoiceProductsProcessed:'—','Products Processed', snap?'':'—')}
      ${kc(snap?snap.ordersInProcessing:'—','Orders In Processing','')}
      ${Store.col('wmsPrepared').length?'':kc(new Set(logs.map(l=>l.operator).filter(Boolean)).size||'—','Operators (in data)','from logs')}
    </div>`
    + wmsPrepStackedChartHTML()
    + (logs.length? `<div class="grid g-2">
        <div class="card"><h3>Product-log events by day <span class="sub">last 14 days with data</span></h3>${dayRows.length?dayRows.map(([k,c])=>barRow(fmtDateAl(k),c,maxDay,'var(--accent)')).join(''):'<div class="empty">—</div>'}</div>
        <div class="card"><h3>Events by operator <span class="sub">top 10</span></h3>${opRows.map(([k,c])=>barRow(k,c,maxOp,'var(--imp)')).join('')}</div>
        <div class="card"><h3>Orders by operator <span class="sub">distinct OrderId</span></h3>${ordRows.map(([k,c])=>barRow(k,c,maxOrd,'var(--fact)')).join('')}</div>
        <div class="card"><h3>Shift comparison <span class="sub">events</span></h3>${Object.entries(byShift).sort((a,b)=>b[1]-a[1]).map(([k,c])=>barRow(k,c,Math.max(1,...Object.values(byShift)), k==='UNKNOWN'?'var(--faint)':'var(--ok)')).join('')||'<div class="empty">—</div>'}</div>
      </div>`
      : (Store.col('wmsPrepared').length?'':`<div class="card"><div class="empty">Ende s'ka të dhëna WMS. Shko te <b>Import</b> për të sjellë të dhënat (Prepared orders / ProductLogs / snapshot).</div></div>`))
    + wmsPreparedDashboardHTML()
    + wmsSameDayHTML()
    + `<div class="note" style="margin-top:12px"><span class="etag et-data">source: WMS</span> "Orders prepared" vijnë nga <b>/Order/GetPreparedOrders</b> (për operator/ditë). "Events" janë rreshta ProductLogs (opsionale, kërkojnë filtër produkti).</div>`;
  $$('#wmsOpTable [data-sortkey]').forEach(th=>{ th.onclick=()=>{
    const k=th.dataset.sortkey;
    if(wmsOpTableSort.key===k) wmsOpTableSort.dir = wmsOpTableSort.dir==='asc'?'desc':'asc';
    else wmsOpTableSort={key:k, dir:k==='op'?'asc':'desc'};
    wmsDashboard(box);
  }; });
}
let wmsOpTableSort={key:'total', dir:'desc'};   // 'total' = historical default (p+ci+co, desc); set by clicking a column header
function wmsPreparedDashboardHTML(){
  const prep=Store.col('wmsPrepared'); const chk=Store.col('wmsCheckin');
  if(!prep.length && !chk.length) return '';
  // ---- helper: aggregate a metric collection into by-day (newest first) + by-operator (latest day)
  const agg=(rows,valOf)=>{
    const byDay={}; rows.forEach(r=>{ byDay[r.date]=(byDay[r.date]||0)+num(valOf(r)); });
    const days=Object.entries(byDay).sort((a,b)=>a[0]<b[0]?-1:1);
    const lastDay=days[days.length-1]; const lastKey=lastDay?lastDay[0]:null;
    const dayRows=days.slice(-14).reverse();
    const byOpLast={}; rows.forEach(r=>{ if(r.date===lastKey) byOpLast[r.operator]=(byOpLast[r.operator]||0)+num(valOf(r)); });
    const ops=Object.entries(byOpLast).sort((a,b)=>b[1]-a[1]).slice(0,12);
    return {days:dayRows, maxD:Math.max(1,...dayRows.map(r=>r[1])), ops, maxO:Math.max(1,...ops.map(r=>r[1])),
      lastKey, lastTotal:lastDay?lastDay[1]:0, total:rows.reduce((a,r)=>a+num(valOf(r)),0), opCount:Object.keys(byOpLast).length};
  };
  const P=agg(prep, r=>r.preparedOrders);
  const C=agg(chk, r=>r.checkedIn);
  const O=agg(chk, r=>r.checkedOut);
  const col=(title,sub,rows,max,color)=>`<div><h3 style="font-size:12.5px;margin:0 0 6px">${title}${sub?` <span class="sub">${sub}</span>`:''}</h3>${rows.length?rows.map(([k,c])=>barRow(k,c,max,color)).join(''):'<div class="empty" style="font-size:12px">—</div>'}</div>`;
  // ---- combined per-operator table for the latest day (Prepared · Checked In · Checked Out) ----
  const allDates=[...prep.map(r=>r.date),...chk.map(r=>r.date)].filter(Boolean).sort();
  const refDay=allDates[allDates.length-1]||null;
  const pMap={}, ciMap={}, coMap={};
  prep.forEach(r=>{ if(r.date===refDay) pMap[r.operator]=(pMap[r.operator]||0)+num(r.preparedOrders); });
  chk.forEach(r=>{ if(r.date===refDay){ ciMap[r.operator]=(ciMap[r.operator]||0)+num(r.checkedIn); coMap[r.operator]=(coMap[r.operator]||0)+num(r.checkedOut); } });
  const opsAll=[...new Set([...Object.keys(pMap),...Object.keys(ciMap),...Object.keys(coMap)])]
    .map(op=>({op, p:pMap[op]||0, ci:ciMap[op]||0, co:coMap[op]||0}));
  const sortDir=wmsOpTableSort.dir==='asc'?1:-1;
  opsAll.sort((a,b)=>{
    const k=wmsOpTableSort.key;
    if(k==='op') return sortDir*(a.op<b.op?-1:(a.op>b.op?1:0));
    if(k==='p'||k==='ci'||k==='co') return sortDir*(a[k]-b[k]);
    return (b.p+b.ci+b.co)-(a.p+a.ci+a.co);   // default 'total' — historically always descending, no header toggles it
  });
  const tot={p:opsAll.reduce((a,x)=>a+x.p,0), ci:opsAll.reduce((a,x)=>a+x.ci,0), co:opsAll.reduce((a,x)=>a+x.co,0)};
  const cell=(v,color)=>`<td style="text-align:right">${v?`<b style="color:${color}">${v}</b>`:'<span class="muted">0</span>'}</td>`;
  const sortArrow=k=>wmsOpTableSort.key===k?` <span class="sub">${wmsOpTableSort.dir==='asc'?'▲':'▼'}</span>`:'';
  const th=(key,label,align,title)=>`<th data-sortkey="${key}" style="${align?'text-align:right;':''}cursor:pointer;user-select:none" title="${title?h(title)+' — ':''}kliko për të renditur">${label}${sortArrow(key)}</th>`;
  const opTable=`<div style="overflow:auto"><table class="tbl" id="wmsOpTable">
    <thead><tr>${th('op','Operator',false)}${th('p','Prepared <span class="sub">porosi</span>',true,'orders (/Order/GetPreparedOrders)')}${th('ci','Checked In <span class="sub">produkte</span>',true,'products (ProductLogs «Checked in»)')}${th('co','Produkte të përgatitura për Check Out',true,'products (ProductLogs «Check out»)')}</tr></thead>
    <tbody>${opsAll.length?opsAll.map(r=>`<tr><td>${h(r.op)}</td>${cell(r.p,'var(--ok)')}${cell(r.ci,'var(--fact)')}${cell(r.co,'var(--imp)')}</tr>`).join(''):emptyRow(4,'—')}
      <tr style="border-top:2px solid var(--line)"><td><b>Total</b></td><td style="text-align:right"><b>${tot.p}</b></td><td style="text-align:right"><b>${tot.ci}</b></td><td style="text-align:right"><b>${tot.co}</b></td></tr></tbody></table></div>`;
  return `<div class="card" style="margin:14px 0"><h3>By operator — Prepared · Checked In · Checked Out <span class="sub">latest day ${refDay?h(fmtDateAl(refDay)):'—'} · source: /Order/GetPreparedOrders + /Warehouse/ProductLogs</span></h3>
      ${opTable}
      <div class="hint" style="margin:8px 0 14px">Njësi të ndryshme: <b>Prepared</b> = porosi (orders); <b>Checked In / Checked Out</b> = produkte (events). Picking dhe check-out shpesh bëhen nga persona të ndryshëm.</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">
        ${col('Prepared by day', 'porosi', P.days.map(([k,c])=>[fmtDateAl(k),c]), P.maxD, 'var(--ok)')}
        ${col('Checked In by day', 'produkte', C.days.map(([k,c])=>[fmtDateAl(k),c]), C.maxD, 'var(--fact)')}
        ${col('Checked Out by day', 'produkte', O.days.map(([k,c])=>[fmtDateAl(k),c]), O.maxD, 'var(--imp)')}
      </div>
      <div class="hint" style="margin-top:10px">ℹ️ <b>Checked In by day</b> (nga log-u i eventeve, për operator/ditë) mund të ndryshojë pak nga karta <b>Products Checked In</b> lart (numëruesi live i WMS-it, <code>GetDashboardStats</code>). Të dy janë të saktë por masin ndryshe: karta lart = numëruesi zyrtar i WMS-it (i lidhur me faturat, dritare rrotulluese); këtu = evente «Checked in» për ditën kalendarike 00:00–tani. Diferenca vjen nga kufiri i ditës dhe përkufizimi, jo nga një gabim.</div></div>`;
}

let wmsOpFilter={from:'',to:'',shift:''};
function wmsOperators(box){
  const shifts=['',...(Store.col('wmsShifts').map(s=>s.name)),'UNKNOWN'];
  box.innerHTML = `<div class="filters">
      <label class="small muted" style="align-self:center">From <input type="date" id="wof" value="${h(wmsOpFilter.from)}"></label>
      <label class="small muted" style="align-self:center">To <input type="date" id="wot" value="${h(wmsOpFilter.to)}"></label>
      <select id="wosh">${shifts.map(s=>`<option value="${h(s)}" ${wmsOpFilter.shift===s?'selected':''}>${s?h(s):'All shifts'}</option>`).join('')}</select>
      <button class="btn" id="woExport">⬇ Export CSV</button>
    </div><div id="wopTable"></div>`;
  $('#wof').onchange=e=>{wmsOpFilter.from=e.target.value;drawWmsOps();};
  $('#wot').onchange=e=>{wmsOpFilter.to=e.target.value;drawWmsOps();};
  $('#wosh').onchange=e=>{wmsOpFilter.shift=e.target.value;drawWmsOps();};
  $('#woExport').onclick=wmsExportOps;
  drawWmsOps();
}
function drawWmsOps(){
  const rows=wmsOperatorAgg(wmsOpFilter.from,wmsOpFilter.to,wmsOpFilter.shift);
  const box=$('#wopTable'); if(!box) return;
  box.innerHTML = rows.length? `<div class="tablewrap"><table><thead><tr><th>Operator</th><th>Date</th><th>Shift</th><th>Orders</th><th>Products*</th><th>First</th><th>Last</th><th>Hours</th><th>Events/h</th><th></th></tr></thead>
    <tbody>${rows.map((r,i)=>`<tr>
      <td>${h(r.operator)}</td><td class="small">${h(fmtDateAl(r.date))}</td>
      <td>${r.shift==='UNKNOWN'?'<span class="badge b-warn">UNKNOWN</span>':h(r.shift)}</td>
      <td><b>${r.orders}</b></td><td>${r.events}</td>
      <td class="small">${fmtTime(r.first)}</td><td class="small">${fmtTime(r.last)}</td>
      <td class="small">${r.hours?r.hours.toFixed(1):'—'}</td><td>${r.evPerHour??'—'}</td>
      <td><button class="btn sm" data-wop="${i}">Detail</button></td></tr>`).join('')}</tbody></table></div>
      <div class="hint" style="margin-top:6px">*"Products" = numri i ngjarjeve ProductLogs të operatorit (jo domosdo produkte të përfunduara). "Orders" = OrderId të dallueshëm. Events/h = ngjarje ÷ (koha e fundit − e parë) — jo productivity i mirëfilltë pa kohë aktive.</div>`
    : `<div class="card"><div class="empty">S'ka të dhëna për këtë filtër. Importo log-et te skeda Import.</div></div>`;
  $$('#wopTable [data-wop]').forEach(b=>b.onclick=()=>wmsOperatorDetail(rows[+b.dataset.wop]));
}
function wmsOperatorDetail(r){
  const hist=wmsOperatorAgg('','','').filter(x=>x.operator===r.operator).sort((a,b)=>a.date<b.date?1:-1).slice(0,30);
  const lt=Object.entries(r.logTypes||{}).sort((a,b)=>b[1]-a[1]);
  openModal('Operator · '+r.operator,
    `<div style="display:grid;gap:4px;font-size:13px;margin-bottom:10px">
       <div><b>Date:</b> ${h(fmtDateAl(r.date))} · <b>Shift:</b> ${h(r.shift)}</div>
       <div><b>Orders processed:</b> ${r.orders} · <b>Product events:</b> ${r.events}</div>
       <div><b>First:</b> ${fmtTime(r.first)} · <b>Last:</b> ${fmtTime(r.last)} · <b>Hours:</b> ${r.hours?r.hours.toFixed(1):'—'}</div>
       <div><b>Events/hour:</b> ${r.evPerHour??'—'} · <b>Orders/hour:</b> ${r.ordPerHour??'—'}</div>
     </div>
     ${lt.length?`<div class="small"><b>By LogType:</b> ${lt.map(([k,c])=>`<span class="badge b-muted">${h(k)}: ${c}</span>`).join(' ')}</div>`:''}
     <h3 style="font-size:12.5px;margin:12px 0 6px">Daily history</h3>
     <div class="tablewrap"><table><thead><tr><th>Date</th><th>Shift</th><th>Orders</th><th>Events</th><th>Hours</th><th>Ev/h</th></tr></thead>
     <tbody>${hist.map(x=>`<tr><td class="small">${h(fmtDateAl(x.date))}</td><td>${h(x.shift)}</td><td>${x.orders}</td><td>${x.events}</td><td>${x.hours?x.hours.toFixed(1):'—'}</td><td>${x.evPerHour??'—'}</td></tr>`).join('')}</tbody></table></div>`,
    `<button class="btn primary" id="mok">Close</button>`);
  $('#mok').onclick=closeModal;
}
function wmsExportOps(){
  const rows=wmsOperatorAgg(wmsOpFilter.from,wmsOpFilter.to,wmsOpFilter.shift);
  if(!rows.length){ toast('Nothing to export'); return; }
  const keys=['date','shift','operator','orders','events','first','last','hours','evPerHour','ordPerHour'];
  const esc=v=>{ if(v==null)return''; v=String(v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const csv=[keys.join(',')].concat(rows.map(r=>keys.map(k=>esc(k==='hours'?(r.hours?r.hours.toFixed(2):''):r[k])).join(','))).join('\n');
  downloadFile('wms-operator-performance-'+todayStr()+'.csv','﻿'+csv,'text/csv;charset=utf-8');
}

/* decode an uploaded file buffer as UTF-8 / UTF-16 / UTF-32 (WMS exports are often UTF-32/UTF-16) */
function wmsUtf32le(b,off){ let s=''; for(let i=off;i+3<b.length;i+=4){ const cp=b[i]|(b[i+1]<<8)|(b[i+2]<<16)|(b[i+3]*16777216); if(cp>0&&cp<=0x10FFFF) s+=String.fromCodePoint(cp); } return s; }
function wmsDecodeBuffer(buf){
  const b=new Uint8Array(buf);
  if(b.length>=4 && b[0]===0xFF&&b[1]===0xFE&&b[2]===0&&b[3]===0) return wmsUtf32le(b,4);
  if(b.length>=2 && b[0]===0xFF&&b[1]===0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if(b.length>=2 && b[0]===0xFE&&b[1]===0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if(b.length>=3 && b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
  const n=Math.min(400,b.length); let z1=0,z2=0,z3=0;
  for(let i=0;i+3<n;i+=4){ if(b[i+1]===0)z1++; if(b[i+2]===0)z2++; if(b[i+3]===0)z3++; }
  if(z1>2&&z2>2&&z3>2) return wmsUtf32le(b,0);                 // UTF-32LE without BOM
  let even=0,odd=0; for(let i=0;i<n;i++){ if(b[i]===0){ if(i%2) odd++; else even++; } }
  if(odd>n*0.2 && even<n*0.1) return new TextDecoder('utf-16le').decode(b);
  if(even>n*0.2 && odd<n*0.1) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b);
}
/* minimal CSV parser (handles quotes, commas, CRLF) */
function wmsParseCSV(text){
  text=text.replace(/^﻿/,''); const rows=[]; let row=[],cur='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=c; }
    else { if(c==='"') q=true; else if(c===','){ row.push(cur); cur=''; }
      else if(c==='\n'){ row.push(cur); rows.push(row); row=[]; cur=''; }
      else if(c==='\r'){} else cur+=c; } }
  if(cur!==''||row.length){ row.push(cur); rows.push(row); }
  const headers=(rows.shift()||[]).map(h=>h.trim());
  return {headers, rows: rows.filter(r=>r.length && r.some(v=>v!=='')).map(r=>{ const o={}; headers.forEach((h,i)=>o[h]=r[i]!=null?r[i].trim():''); return o; })};
}
const WMS_TARGET_FIELDS=[['operator','Operator (UpdatedByName)'],['logType','Action / LogType / Status'],['orderId','Order Id'],['insertDateTime','Timestamp'],['sku','SKU'],['productCode','EAN / code'],['location','Location']];
function wmsGuessCol(headers,target){
  const h=headers.map(x=>x.toLowerCase());
  const hints={operator:['updatedby','user','operator','employee','punonjes'],logType:['logtype','status','action','veprim'],orderId:['orderid','order','porosi'],insertDateTime:['insertdate','date','time','koha','data','timestamp'],sku:['sku'],productCode:['productcode','ean','barcode','code'],location:['row','location','vend','raft']};
  const hs=hints[target]||[target.toLowerCase()];
  for(const hint of hs){ const i=h.findIndex(x=>x.includes(hint)); if(i>=0) return headers[i]; }
  return '';
}
let wmsCsvData=null;
const WMS_SNIPPET = [
"/* GjirafaWMS export — Console on /Warehouse/ProductLogs (logged in). First type: allow pasting  */",
"(async function(){",
"  var el=document.querySelector('input[name=__RequestVerificationToken]');",
"  if(!el){ alert('Open /Warehouse/ProductLogs first (security token not found on this page).'); return; }",
"  var tok=el.value;",
"  var range=prompt('Date range (DD/MM/YYYY - DD/MM/YYYY):', (function(){var t=new Date(),p=function(n){return ('0'+n).slice(-2);},s=p(t.getDate())+'/'+p(t.getMonth()+1)+'/'+t.getFullYear();return s+' - '+s;})());",
"  if(!range) return;",
"  var cd=['UniqueId','ProductCode','Sku','ProductSerialNumber','VendorName','ProductName','OrderId','LogType','Row','UpdatedByName','InsertDateTime','LastInspectDate'];",
"  function enc(o,pfx,a){a=a||[];pfx=pfx||'';if(Array.isArray(o)){o.forEach(function(v,i){enc(v,pfx+'['+i+']',a);});}else if(o&&typeof o==='object'){Object.keys(o).forEach(function(k){enc(o[k],pfx?pfx+'['+k+']':k,a);});}else{a.push(encodeURIComponent(pfx)+'='+encodeURIComponent(o==null?'':o));}return a;}",
"  function params(start,len){var cols=cd.map(function(d){return {data:d,name:'',searchable:true,orderable:true,search:{value:'',regex:false}};});return {draw:1,start:start,length:len,search:{value:'',regex:false},order:[{column:10,dir:'asc'}],columns:cols,ProductCode:'',Sku:'',ProductSerialNumber:'',VendorId:'',DateRange:range};}",
"  var all=[],start=0,len=1000,total=null;",
"  do{",
"    var body=enc(params(start,len)).join('&')+'&__RequestVerificationToken='+encodeURIComponent(tok);",
"    var r=await fetch('/Warehouse/ProductLogsData',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'},body:body});",
"    if(!r.ok){ alert('WMS returned HTTP '+r.status); return; }",
"    var j=await r.json(); total=j.recordsFiltered||0; all=all.concat(j.data||[]); start+=len;",
"    console.log('fetched',all.length,'/',total);",
"  }while(all.length<total && start<200000);",
"  var stats={}; try{ stats=await (await fetch('/Warehouse/GetDashboardStats',{headers:{'X-Requested-With':'XMLHttpRequest'}})).json(); }catch(e){}",
"  var out={source:'WMS',sourceUrl:location.origin,retrievedAt:new Date().toISOString(),dateRange:range,stats:stats,logs:all};",
"  var blob=new Blob([JSON.stringify(out)],{type:'application/json'});",
"  var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='wms-export-'+range.replace(/[^0-9]/g,'')+'.json'; a.click();",
"  console.log('DONE — '+all.length+' rows downloaded. Import the file into the app.');",
"})();"
].join("\n");

/* Prepared-orders-by-operator export — Console on /Order/Prepared. Type: allow pasting */
const WMS_PREPARED_SNIPPET = [
"(async function(){",
"  var tokEl=document.querySelector('input[name=__RequestVerificationToken]'); var tok=tokEl?tokEl.value:'';",
"  function p2(n){return ('0'+n).slice(-2);}",
"  function today(){var t=new Date();return p2(t.getDate())+'/'+p2(t.getMonth()+1)+'/'+t.getFullYear();}",
"  var range=prompt('Date range (DD/MM/YYYY - DD/MM/YYYY):', today()+' - '+today()); if(!range) return;",
"  var m=range.split('-').map(function(s){return s.trim();}); function pd(s){var a=s.split('/');return new Date(+a[2],+a[1]-1,+a[0]);}",
"  var start=pd(m[0]), end=pd(m[1]||m[0]);",
"  function mdy(d){return p2(d.getMonth()+1)+'/'+p2(d.getDate())+'/'+d.getFullYear();}",
"  function isod(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());}",
"  function enc(o,pfx,a){a=a||[];pfx=pfx||'';if(Array.isArray(o)){o.forEach(function(v,i){enc(v,pfx+'['+i+']',a);});}else if(o&&typeof o==='object'){Object.keys(o).forEach(function(k){enc(o[k],pfx?pfx+'['+k+']':k,a);});}else{a.push(encodeURIComponent(pfx)+'='+encodeURIComponent(o==null?'':o));}return a;}",
"  var rows=[];",
"  for(var d=new Date(start); d<=end; d.setDate(d.getDate()+1)){",
"    var day=mdy(d), iso=isod(d);",
"    var cols=[{data:'Name',name:'',searchable:true,orderable:true,search:{value:'',regex:false}},{data:'PreparedOrders',name:'',searchable:true,orderable:true,search:{value:'',regex:false}}];",
"    var pp={draw:1,start:0,length:1000,search:{value:'',regex:false},order:[{column:1,dir:'desc'}],columns:cols,filters:{startDate:day,endDate:day}};",
"    var body=enc(pp).join('&')+(tok?'&__RequestVerificationToken='+encodeURIComponent(tok):'');",
"    var r=await fetch('/Order/GetPreparedOrders',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'},body:body});",
"    if(!r.ok){ alert('WMS returned HTTP '+r.status+' on '+day); return; }",
"    var j=await r.json(); (j.data||[]).forEach(function(x){ rows.push({date:iso, operator:x.Name, preparedOrders:x.PreparedOrders}); });",
"    console.log(iso, (j.data||[]).length+' operators');",
"  }",
"  var out={source:'WMS',kind:'preparedOrders',sourceUrl:location.origin,retrievedAt:new Date().toISOString(),dateRange:range,rows:rows};",
"  var blob=new Blob([JSON.stringify(out)],{type:'application/json'});",
"  var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='wms-prepared-'+range.replace(/[^0-9]/g,'')+'.json'; a.click();",
"  console.log('DONE — '+rows.length+' operator-day rows. Import into the app.');",
"})();"
].join("\n");

function wmsImport(box){
  const cfg=wmsCfg(); const onAgent=wmsOnAgent();
  box.innerHTML = `
    <div class="card" style="margin-bottom:14px"><h3>0 · Automatic sync (local agent) <span class="sub">recommended</span></h3>
      ${onAgent
        ? `<div class="hint" style="margin-bottom:6px">App-i po shërbehet nga agjenti lokal → mund të bëjë sync vetvetiu (pa Console, pa import manual).</div>
           <div class="filters" style="align-items:center">
             <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wmsAutoChk" ${cfg.autoSync?'checked':''} style="width:auto;min-height:auto"> Auto-sync</label>
             <select id="wmsAutoInt">${[15,30,60].map(m=>`<option value="${m}" ${cfg.interval===m?'selected':''}>every ${m} min</option>`).join('')}</select>
             <button class="btn primary" id="wmsSyncNow">⟳ Sync now</button>
             <span id="wmsSyncMsg" class="small muted"></span>
           </div>
           <div class="hint" style="margin-top:6px">Last success: ${cfg.lastSuccess?h(new Date(cfg.lastSuccess).toLocaleString()):'—'}${cfg.lastError?` · <span style="color:var(--crit)">last error: ${h(cfg.lastError)}</span>`:''}</div>`
        : `<div class="note warn">Po e hap app-in si skedar (file://), ndaj auto-sync s'funksionon. Nis agjentin (<b>start-wms-agent.bat</b>) dhe hap <b>http://localhost:8790/app.html</b>. Pastaj kjo skedë do të tregojë kontrollet e auto-sync.</div>
           <div class="hint" style="margin-top:6px">Konfigurimi një-herësh: kopjo <b>wms-agent.config.example.json</b> → <b>wms-agent.config.json</b> dhe ngjit cookie-n e WMS-it (shih README).</div>`}
    </div>
    <div class="card" style="margin-bottom:14px"><h3>1 · Authorized fetch (run in the WMS tab) <span class="sub">manual fallback</span></h3>
      <div class="hint" style="margin-bottom:6px">Hape <b>${h(wmsCfg().url)}Warehouse/ProductLogs</b> (i loguar) → hap Console (F12) → ngjit këtë skript → jep intervalin e datave. Shkarkon një JSON që e importon këtu. Read-only, pa kredenciale.</div>
      <textarea readonly rows="5" style="font-family:monospace;font-size:11px" id="wmsSnip">${h(WMS_SNIPPET)}</textarea>
      <div class="btnrow" style="margin-top:6px"><button class="btn sm" id="wmsSnipCopy">Copy snippet</button></div>
      <div class="hint" style="margin-top:8px"><b>Operator performance / Orders prepared by operator by day</b> — run this on <b>${h(wmsCfg().url)}Order/Prepared</b> (Console, after "allow pasting"). It loops each day in your range and downloads JSON to import here.</div>
      <textarea readonly rows="5" style="font-family:monospace;font-size:11px" id="wmsPrepSnip">${h(WMS_PREPARED_SNIPPET)}</textarea>
      <div class="btnrow" style="margin-top:6px"><button class="btn sm" id="wmsPrepCopy">Copy prepared-orders snippet</button></div>
    </div>
    <div class="card" style="margin-bottom:14px"><h3>2 · Import into the app</h3>
      <div class="field"><label>Upload JSON export</label><input type="file" id="wmsFile" accept="application/json,.json"></div>
      <div class="field"><label>…or paste JSON here</label><textarea id="wmsPaste" rows="4" placeholder='{"stats":{...},"logs":[...]}  ose  [ {UpdatedByName,LogType,OrderId,InsertDateTime,...}, ... ]'></textarea></div>
      <div class="btnrow"><button class="btn primary" id="wmsDoImport">Import</button><span id="wmsImpMsg" class="small muted"></span></div>
    </div>
    <div class="card" style="margin-bottom:14px"><h3>3 · Import a WMS export (CSV / Excel→CSV) <span class="sub">recommended — native WMS report</span></h3>
      <div class="hint" style="margin-bottom:6px">Eksporto nga WMS (p.sh. <b>Order → Dashboard → Report</b>, ose eksportet e Check-In), ruaje si <b>CSV</b> (nga Excel: Save As → CSV), ngarko këtu dhe harto kolonat. Pa hamendje — ti cakton çdo kolonë.</div>
      <div class="field"><label>Upload CSV</label><input type="file" id="wmsCsvFile" accept=".csv,text/csv"></div>
      <div id="wmsCsvMap"></div></div>
    <div class="card"><h3>LogType mapping <span class="sub">no assumptions</span></h3>
      <div class="hint" style="margin-bottom:6px">Vlerat e LogType siç vijnë nga WMS. Cakto kuptimin që të përdoret te analizat (opsionale).</div>
      <div id="wmsLtMap"></div></div>`;
  if(wmsOnAgent()){
    const chk=$('#wmsAutoChk'), int=$('#wmsAutoInt'), now=$('#wmsSyncNow');
    if(chk) chk.onchange=()=>{ wmsCfg().autoSync=chk.checked; Store.persist(); wmsScheduleAuto(); toast(chk.checked?'Auto-sync ON':'Auto-sync OFF'); };
    if(int) int.onchange=()=>{ wmsCfg().interval=+int.value; Store.persist(); wmsScheduleAuto(); };
    if(now) now.onclick=async()=>{ const m=$('#wmsSyncMsg'); if(m)m.textContent='Syncing…'; const r=await wmsAgentSync(7); if(m)m.textContent=r.msg; toast(r.ok?'Synced':'Sync failed'); if((location.hash||'')==='#wms'){ /* refresh only the import status line */ const c=wmsCfg(); const el=$('#wmsSyncMsg'); if(el&&r.ok) el.textContent=r.msg; } };
  }
  $('#wmsSnipCopy').onclick=()=>{ const t=$('#wmsSnip'); t.select(); try{document.execCommand('copy');}catch(e){} navigator.clipboard&&navigator.clipboard.writeText(WMS_SNIPPET); toast('Snippet copied'); };
  $('#wmsPrepCopy').onclick=()=>{ const t=$('#wmsPrepSnip'); t.select(); try{document.execCommand('copy');}catch(e){} navigator.clipboard&&navigator.clipboard.writeText(WMS_PREPARED_SNIPPET); toast('Prepared-orders snippet copied'); };
  $('#wmsCsvFile').onchange=e=>{ const f=e.target.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{ try{ const text=wmsDecodeBuffer(r.result); wmsCsvData=wmsParseCSV(text); }catch(err){ toast('CSV parse error'); return;} drawWmsCsvMap(); }; r.readAsArrayBuffer(f); };
  drawWmsCsvMap();
  $('#wmsFile').onchange=e=>{ const f=e.target.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{ $('#wmsPaste').value=r.result; toast('File loaded — click Import'); }; r.readAsText(f); };
  $('#wmsDoImport').onclick=()=>{
    const txt=$('#wmsPaste').value.trim(); if(!txt){ toast('Nothing to import'); return; }
    let data; try{ data=JSON.parse(txt); }catch(e){ toast('Invalid JSON'); $('#wmsImpMsg').textContent='Invalid JSON: '+e.message; return; }
    let logs=[], stats=null, dateRange='', srcRef='';
    if(Array.isArray(data)) logs=data;
    else { logs=data.logs||data.data||[]; stats=data.stats||null; dateRange=data.dateRange||''; srcRef=(data.sourceUrl||'')+' @ '+(data.retrievedAt||''); }
    // prepared-orders-by-operator dataset
    const prep = (data&&data.rows) ? data.rows : logs;
    if((data&&data.kind==='preparedOrders') || (prep.length && (prep[0].preparedOrders!=null||prep[0].PreparedOrders!=null) && (prep[0].operator!=null||prep[0].Name!=null))){
      const res=wmsImportPrepared(prep,{dateRange,sourceRef:srcRef});
      $('#wmsImpMsg').textContent='Prepared orders: '+res.inserted+' inserted, '+res.updated+' updated, '+res.dups+' duplicates'; toast('Prepared orders imported'); return;
    }
    let msg=[];
    if(stats && Object.keys(stats).length){ wmsImportStats(stats,{sourceRef:srcRef}); msg.push('snapshot ✓'); }
    if(logs.length){ const res=wmsImportLogs(logs,{dateRange,sourceRef:srcRef}); msg.push(res.inserted+' inserted, '+res.dups+' duplicates'+(res.warn?', '+res.warn+' warnings':'')); }
    else msg.push('0 log rows');
    $('#wmsImpMsg').textContent=msg.join(' · '); toast('Import complete'); drawWmsLtMap();
  };
  drawWmsLtMap();
}
function wmsIsOrdersReport(hs){ const s=hs.map(x=>x.toLowerCase()); return s.includes('orderid') && s.includes('completed') && (s.includes('quantity')||s.includes('filledquantity')); }
function wmsImportOrders(rows, meta){
  meta=meta||{}; const t0=Date.now(); const col=Store.col('wmsOrders');
  const key=r=>['WMS',r.orderId,r.productId,r.productCode].join('|');
  const existing=new Set(col.map(key)); let ins=0,dups=0;
  const num2=x=>{ const n=parseFloat(x); return isNaN(n)?0:n; };
  rows.forEach(r=>{
    const rec={ orderId:(r.OrderId||'').trim(), wmsStatus:(r.WmsStatus||'').trim(), productId:(r.ProductId||'').trim(),
      productCode:(r.ProductCode||'').trim(), productName:(r.ProductName||'').trim(),
      filled:num2(r.FilledQuantity), quantity:num2(r.Quantity), difference:num2(r.Difference),
      store:(r.Store||'').trim(), completed:String(r.Completed||'').toLowerCase()==='true',
      futureShipment:String(r.FutureShipment||'').toLowerCase()==='true', source:'WMS', sourceRef:meta.sourceRef||'', importedAt:nowISO() };
    const k=key(rec); if(existing.has(k)){ dups++; return; } existing.add(k);
    rec.id=uid('wo'); col.unshift(rec); ins++;
  });
  Store.col('wmsSyncLog').unshift({ id:uid('slog'), at:nowISO(), operation:'Orders report import', dateRange:meta.dateRange||'',
    retrieved:rows.length, inserted:ins, updated:0, duplicates:dups, warnings:0, errors:0, durationMs:Date.now()-t0, status:'VALID' });
  wmsCfg().lastSuccess=nowISO(); Store.persist();
  return {inserted:ins,dups};
}
/* Prepared orders by operator (from /Order/GetPreparedOrders) — rows: {date, operator, preparedOrders} */
function wmsImportPrepared(rows, meta){ const r=WODS.importPrepared(Store.db,rows,meta); wmsCfg().lastSuccess=nowISO(); Store.persist(); return r; }
function wmsImportCheckin(rows, meta){ const r=WODS.importCheckin(Store.db,rows,meta); wmsCfg().lastSuccess=nowISO(); Store.persist(); return r; }
function wmsImportFlow(daily, meta){ WODS.importFlow(Store.db,daily,meta); Store.persist(); }
function wmsSameDayHTML(){
  const flow=Store.col('wmsFlow'); if(!flow.length) return '';
  const days=flow.slice().sort((a,b)=>a.date<b.date?1:-1).slice(0,14); // newest first
  const last=days[0];
  const rate=r=>r.checkedIn>0?Math.round(r.checkedOut/r.checkedIn*100):0;
  const maxV=Math.max(1,...days.map(d=>Math.max(num(d.checkedIn),num(d.checkedOut))));
  const bar=(v,color)=>`<div style="flex:1;min-width:0"><div style="height:14px;background:${color};width:${Math.round(num(v)/maxV*100)}%;border-radius:3px;min-width:2px"></div></div>`;
  const row=r=>{
    const rt=rate(r);
    const rc = rt>=90?'var(--ok)' : (rt>=60?'var(--warn)':'var(--crit)');
    return `<tr>
      <td class="small">${h(fmtDateAl(r.date))}</td>
      <td style="text-align:right"><b>${num(r.checkedIn)}</b></td>
      <td style="text-align:right"><b style="color:var(--fact)">${num(r.checkedOut)}</b></td>
      <td style="text-align:right">${num(r.checkedIn)-num(r.checkedOut)}</td>
      <td style="width:38%"><div style="display:flex;gap:4px;align-items:center">${bar(r.checkedIn,'var(--imp)')}${bar(r.checkedOut,'var(--fact)')}</div></td>
      <td style="text-align:right"><span class="badge" style="background:${rc};color:#fff">${rt}%</span></td>
    </tr>`;
  };
  return `<div class="card" style="margin:14px 0"><h3>Same-day flow — Checked In vs Checked Out <span class="sub">products checked in vs checked out the same day · source: /Warehouse/ProductLogs (LogType «Checked in» vs «Check out»)</span></h3>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin-bottom:10px">
      <span>Latest day (${last?h(fmtDateAl(last.date)):'—'}) — Checked In: <b style="color:var(--imp)">${last?num(last.checkedIn):'—'}</b></span>
      <span>Checked Out: <b style="color:var(--fact)">${last?num(last.checkedOut):'—'}</b></span>
      <span>Same-day rate: <b>${last?rate(last):'—'}%</b></span>
    </div>
    <table class="tbl"><thead><tr><th>Day</th><th style="text-align:right">Checked In</th><th style="text-align:right">Checked Out</th><th style="text-align:right">Diff</th><th>In (■) vs Out (■)</th><th style="text-align:right">Out/In</th></tr></thead>
    <tbody>${days.map(row).join('')}</tbody></table>
    <div class="hint" style="margin-top:6px">«Out/In %» = sa produkte u bënë <b>Check out</b> (dërgim) ndaj atyre që u bënë <b>Checked in</b> po atë ditë (vëllim, jo e njëjta porosi). Check-in nuk mbart OrderId, prandaj krahasimi është në nivel produktesh.</div>
  </div>`;
}
/* Excel export (SpreadsheetML 2003 — multi-sheet, no external library, works offline). */
function wmsExcelXml(sheets){
  const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const cell=v=>{ const isNum=(typeof v==='number') || (v!=='' && v!=null && /^-?\d+(\.\d+)?$/.test(String(v)));
    return '<Cell><Data ss:Type="'+(isNum?'Number':'String')+'">'+esc(v)+'</Data></Cell>'; };
  const rowsXml=rows=>rows.map(r=>'<Row>'+r.map(cell).join('')+'</Row>').join('');
  const sheetsXml=sheets.map(s=>'<Worksheet ss:Name="'+esc((s.name||'Sheet').slice(0,31).replace(/[:\\\/?*\[\]]/g,' '))+'"><Table>'+rowsXml(s.rows)+'</Table></Worksheet>').join('');
  return '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'+sheetsXml+'</Workbook>';
}
function exportWmsExcel(){
  const snap=Store.col('wmsStats')[0]||{};
  const prep=Store.col('wmsPrepared'), chk=Store.col('wmsCheckin'), flow=Store.col('wmsFlow');
  const dsort=(a,b)=>a.date<b.date?1:-1; // newest first
  const sheets=[];
  sheets.push({name:'Snapshot', rows:[
    ['Metric','Value','As of'],
    ['Orders Ready To Complete', num(snap.ordersReadyToUnmap), snap.at||''],
    ['Products To Check In', num(snap.invoiceProductsToCheckIn), snap.at||''],
    ['Products Checked In', num(snap.invoiceProductsCheckedIn), snap.at||''],
    ['Products Processed', num(snap.invoiceProductsProcessed), snap.at||''],
    ['Orders In Processing', num(snap.ordersInProcessing), snap.at||''],
  ]});
  const pByDay={}; prep.forEach(r=>pByDay[r.date]=(pByDay[r.date]||0)+num(r.preparedOrders));
  sheets.push({name:'Prepared by day', rows:[['Date','Prepared orders'],...Object.entries(pByDay).sort((a,b)=>a[0]<b[0]?1:-1)]});
  sheets.push({name:'Prepared by operator', rows:[['Date','Operator','Prepared orders'],...prep.slice().sort(dsort).map(r=>[r.date,r.operator,num(r.preparedOrders)])]});
  const cByDay={}; chk.forEach(r=>cByDay[r.date]=(cByDay[r.date]||0)+num(r.checkedIn));
  sheets.push({name:'Checked In by day', rows:[['Date','Products checked in'],...Object.entries(cByDay).sort((a,b)=>a[0]<b[0]?1:-1)]});
  sheets.push({name:'Checked In by operator', rows:[['Date','Operator','Products checked in'],...chk.slice().sort(dsort).map(r=>[r.date,r.operator,num(r.checkedIn)])]});
  const oByDay={}; chk.forEach(r=>oByDay[r.date]=(oByDay[r.date]||0)+num(r.checkedOut));
  sheets.push({name:'Checked Out by day', rows:[['Date','Products checked out'],...Object.entries(oByDay).sort((a,b)=>a[0]<b[0]?1:-1)]});
  sheets.push({name:'Checked Out by operator', rows:[['Date','Operator','Products checked out'],...chk.slice().filter(r=>num(r.checkedOut)>0).sort(dsort).map(r=>[r.date,r.operator,num(r.checkedOut)])]});
  // combined by-operator for latest day (matches the dashboard table)
  (()=>{ const allD=[...prep.map(r=>r.date),...chk.map(r=>r.date)].filter(Boolean).sort(); const ref=allD[allD.length-1]; if(!ref) return;
    const pM={},ciM={},coM={};
    prep.forEach(r=>{ if(r.date===ref) pM[r.operator]=(pM[r.operator]||0)+num(r.preparedOrders); });
    chk.forEach(r=>{ if(r.date===ref){ ciM[r.operator]=(ciM[r.operator]||0)+num(r.checkedIn); coM[r.operator]=(coM[r.operator]||0)+num(r.checkedOut); } });
    const ops=[...new Set([...Object.keys(pM),...Object.keys(ciM),...Object.keys(coM)])].map(op=>[op,pM[op]||0,ciM[op]||0,coM[op]||0]).sort((a,b)=>(b[1]+b[2]+b[3])-(a[1]+a[2]+a[3]));
    sheets.push({name:'By operator ('+ref+')', rows:[['Operator','Prepared (orders)','Checked In (products)','Checked Out (products)'],...ops]}); })();
  sheets.push({name:'Same-day flow', rows:[['Date','Checked In','Check out','Diff (In-Out)','Out/In %'],
    ...flow.slice().sort(dsort).map(r=>[r.date,num(r.checkedIn),num(r.checkedOut),num(r.checkedIn)-num(r.checkedOut), r.checkedIn>0?Math.round(r.checkedOut/r.checkedIn*100):0])]});
  const xml=wmsExcelXml(sheets);
  const blob=new Blob(['﻿'+xml],{type:'application/vnd.ms-excel'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='WMS-dashboard-'+new Date().toISOString().slice(0,10)+'.xls';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(a.href),3000);
  toast('U eksportua në Excel');
}
function wmsOrdersSummaryHTML(){
  const rows=Store.col('wmsOrders'); if(!rows.length) return '';
  const byOrder={}; rows.forEach(r=>{ const o=byOrder[r.orderId]||(byOrder[r.orderId]={compl:false,lines:0}); o.lines++; if(r.completed)o.compl=true; });
  const distinct=Object.keys(byOrder).length;
  const completed=Object.values(byOrder).filter(o=>o.compl).length;
  const shortfall=rows.filter(r=>r.difference>0 || r.filled<r.quantity).length;
  const byStore={}; rows.forEach(r=>{ const s=r.store||'(none)'; byStore[s]=(byStore[s]||0)+1; });
  const stores=Object.entries(byStore).sort((a,b)=>b[1]-a[1]).slice(0,6); const maxS=Math.max(1,...stores.map(x=>x[1]));
  const fillRate= distinct? Math.round(completed/distinct*100):0;
  return `<div class="card" style="margin-top:12px"><h3>Orders report summary <span class="sub">${rows.length} lines · ${distinct} orders</span></h3>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin-bottom:8px">
      <span>Distinct orders: <b>${distinct}</b></span>
      <span>Completed (≥1 line): <b class="ok" style="color:var(--ok)">${completed}</b> (${fillRate}%)</span>
      <span>Not completed: <b>${distinct-completed}</b></span>
      <span>Lines with shortfall: <b style="color:var(--warn)">${shortfall}</b></span>
    </div>
    <div><b class="small">By store:</b></div>${stores.map(([k,c])=>barRow(k,c,maxS,'var(--accent)')).join('')}
    <div class="hint" style="margin-top:6px"><span class="etag et-data">source: WMS</span> Ky raport = backlog + fill-status; s'ka operator/timestamp, ndaj s'jep operator-performance ose orders-by-day.</div></div>`;
}
function drawWmsCsvMap(){
  const box=$('#wmsCsvMap'); if(!box) return;
  if(!wmsCsvData){ box.innerHTML=''; return; }
  const hs=wmsCsvData.headers;
  if(wmsIsOrdersReport(hs)){
    box.innerHTML = `<div class="note"><span class="etag et-data">detected</span> <b>Orders report</b> — ${wmsCsvData.rows.length} lines. Ky format s'ka operator/kohë; importohet si backlog + fill-status.</div>
      <div class="btnrow"><button class="btn primary" id="wmsOrdImport">Import as Orders report</button><span id="wmsOrdMsg" class="small muted"></span></div>
      <div id="wmsOrdSum">${wmsOrdersSummaryHTML()}</div>
      <details style="margin-top:10px"><summary class="small muted">…ose harto si event operatori (nëse ke një eksport tjetër me operator/kohë)</summary><div id="wmsOpMapWrap"></div></details>`;
    $('#wmsOrdImport').onclick=()=>{ const res=wmsImportOrders(wmsCsvData.rows,{sourceRef:'CSV: Orders report'}); $('#wmsOrdMsg').textContent=res.inserted+' inserted, '+res.dups+' duplicates'; $('#wmsOrdSum').innerHTML=wmsOrdersSummaryHTML(); toast('Orders imported'); };
    // still render operator mapping inside the <details> for flexibility
    box.querySelector('#wmsOpMapWrap').innerHTML = wmsCsvMapControls(hs);
    wmsWireCsvOpImport(box);
    return;
  }
  box.innerHTML = wmsCsvMapControls(hs);
  wmsWireCsvOpImport(box);
}
function wmsCsvMapControls(hs){
  const opt=sel=>`<option value="">— none —</option>`+hs.map(h2=>`<option value="${h(h2)}" ${sel===h2?'selected':''}>${h(h2)}</option>`).join('');
  return `<div class="hint" style="margin:6px 0">Detected <b>${wmsCsvData.rows.length}</b> rows, ${hs.length} columns. Map columns:</div>
    <div class="grid g-2">${WMS_TARGET_FIELDS.map(([k,lbl])=>`<div class="field"><label>${lbl}</label><select data-csvmap="${k}">${opt(wmsGuessCol(hs,k))}</select></div>`).join('')}</div>
    <div class="btnrow"><button class="btn primary" id="wmsCsvImport">Import as operator events</button><span id="wmsCsvMsg" class="small muted"></span></div>`;
}
function wmsWireCsvOpImport(box){
  const btn=box.querySelector('#wmsCsvImport'); if(!btn) return;
  btn.onclick=()=>{
    const map={}; box.querySelectorAll('[data-csvmap]').forEach(s=>{ if(s.value) map[s.dataset.csvmap]=s.value; });
    if(!map.operator && !map.insertDateTime){ toast('Map at least Operator or Timestamp'); return; }
    const rows=wmsCsvData.rows.map(r=>({
      UpdatedByName: map.operator? r[map.operator]:'', LogType: map.logType? r[map.logType]:'',
      OrderId: map.orderId? r[map.orderId]:'', InsertDateTime: map.insertDateTime? r[map.insertDateTime]:'',
      Sku: map.sku? r[map.sku]:'', ProductCode: map.productCode? r[map.productCode]:'', Row: map.location? r[map.location]:'',
      UniqueId:(map.sku?r[map.sku]:'')+'|'+(map.insertDateTime?r[map.insertDateTime]:'')+'|'+(map.orderId?r[map.orderId]:'')
    }));
    const res=wmsImportLogs(rows,{dateRange:'CSV import',sourceRef:'CSV upload'});
    const m=box.querySelector('#wmsCsvMsg'); if(m) m.textContent=res.inserted+' inserted, '+res.dups+' duplicates'+(res.warn?', '+res.warn+' warnings':'');
    toast('CSV imported'); drawWmsLtMap();
  };
}
function drawWmsLtMap(){
  const box=$('#wmsLtMap'); if(!box) return;
  const types=wmsAllLogTypes(); const map=wmsCfg().logTypeMap||{};
  const meanings=['','Checked In','Mapped / Put-away','Picked','Checked Out','Completed','Return','Other'];
  box.innerHTML = types.length? `<div class="tablewrap"><table><thead><tr><th>WMS LogType</th><th>Count</th><th>Means</th></tr></thead>
    <tbody>${types.map(t=>{ const c=Store.col('wmsLogs').filter(l=>l.logType===t).length;
      return `<tr><td>${h(t)}</td><td>${c}</td><td><select data-lt="${h(t)}">${meanings.map(m=>`<option value="${h(m)}" ${map[t]===m?'selected':''}>${m||'— unset —'}</option>`).join('')}</select></td></tr>`;}).join('')}</tbody></table></div>`
    : '<div class="empty">S\'ka LogType ende — importo log-e.</div>';
  box.querySelectorAll('[data-lt]').forEach(s=>s.onchange=()=>{ wmsCfg().logTypeMap[s.dataset.lt]=s.value; Store.persist(); toast('Mapping saved'); });
}

function wmsValidation(box){
  const snap=Store.col('wmsStats')[0];
  box.innerHTML = `<div class="card"><h3>Validation · WMS vs Application</h3>
    <div class="hint" style="margin-bottom:8px">Krahaso një numër nga dashboard-i i WMS-it me atë të llogaritur nga app-i. Diferencat s'fshihen — shfaqen si MISMATCH për hetim.</div>
    <div class="row3">
      <div class="field"><label>Metric</label><select id="wvMetric"><option value="preparedDay">Prepared orders (a day, sum)</option><option value="checkedIn">Products Checked In (snapshot)</option><option value="eventsDay">Product-log events (a day)</option><option value="ordersDay">Distinct orders (a day)</option></select></div>
      <div class="field"><label>Date (for day metrics)</label><input type="date" id="wvDate" value="${todayStr()}"></div>
      <div class="field"><label>WMS value (nga dashboard-i)</label><input type="number" id="wvWms" placeholder="${snap?snap.invoiceProductsCheckedIn:'e.g. 842'}"></div>
    </div>
    <button class="btn primary" id="wvRun">Compare</button>
    <div id="wvOut" style="margin-top:12px"></div></div>`;
  $('#wvRun').onclick=()=>{
    const metric=$('#wvMetric').value, d=$('#wvDate').value, wms=$('#wvWms').value===''?null:num($('#wvWms').value);
    let appVal=null, label='';
    if(metric==='preparedDay'){ appVal=Store.col('wmsPrepared').filter(r=>r.date===d).reduce((a,r)=>a+num(r.preparedOrders),0); label='Prepared orders on '+fmtDateAl(d)+' (sum of operators)'; }
    else if(metric==='checkedIn'){ appVal= snap?snap.invoiceProductsCheckedIn:null; label='Products Checked In (latest snapshot)'; }
    else if(metric==='eventsDay'){ appVal=Store.col('wmsLogs').filter(l=>l.date===d).length; label='Product-log events on '+fmtDateAl(d); }
    else { appVal=new Set(Store.col('wmsLogs').filter(l=>l.date===d&&l.orderId).map(l=>l.orderId)).size; label='Distinct orders on '+fmtDateAl(d); }
    const out=$('#wvOut');
    if(wms==null){ out.innerHTML='<div class="note warn">Fut vlerën e WMS-it për të krahasuar.</div>'; return; }
    const diff=(appVal==null)?null:wms-appVal;
    const status = appVal==null?'NO APP DATA': (diff===0?'MATCH':'MISMATCH');
    out.innerHTML=`<div class="report" style="padding:14px 16px">
      <div><b>${h(label)}</b></div>
      <div style="margin-top:6px">WMS: <b>${wms}</b> &nbsp; App: <b>${appVal==null?'—':appVal}</b> &nbsp; Difference: <b style="color:${diff===0?'var(--ok)':'var(--crit)'}">${diff==null?'—':diff}</b></div>
      <div style="margin-top:6px">Status: <span class="badge ${status==='MATCH'?'b-ok':(status==='MISMATCH'?'b-crit':'b-warn')}">${status}</span></div>
      ${status==='MISMATCH'?'<div class="hint" style="margin-top:6px">Diferenca s\'korrigjohet automatikisht. Shkaqe të mundshme: interval i importuar i pjesshëm, snapshot live ndryshe nga dita, ose logjikë e ndryshme numërimi.</div>':''}
    </div>`;
  };
}

function wmsShiftsView(box){
  const rows=Store.col('wmsShifts');
  box.innerHTML = `<div class="card"><h3>Shift Management <span class="sub">used by assignShift()</span></h3>
    <div class="btnrow" style="margin-bottom:8px"><button class="btn sm primary" id="wmsAddShift">＋ Shift</button></div>
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Start</th><th>End</th><th>Weekend</th><th>Active</th><th></th></tr></thead>
    <tbody>${rows.map(s=>`<tr><td><b>${h(s.name)}</b></td><td>${h(s.start)}</td><td>${h(s.end)}</td><td>${s.weekend?'✓':'—'}</td><td>${s.active!==false?'✓':'—'}</td>
      <td><button class="btn sm" data-she="${s.id}">Edit</button> <button class="btn sm danger" data-shd="${s.id}">✕</button></td></tr>`).join('')||emptyRow(6,'No shifts')}</tbody></table></div>
    <div class="hint" style="margin-top:6px">Rregulla e overlap-it: nëse një timestamp bie brenda <b>më shumë se një</b> ndërrimi aktiv (p.sh. N1∩N2 13:00–15:00), shift-i shënohet <b>UNKNOWN</b> — nuk hamendësohet.</div></div>`;
  $('#wmsAddShift').onclick=()=>wmsShiftForm();
  $$('#wmsBody [data-she]').forEach(b=>b.onclick=()=>wmsShiftForm(Store.get('wmsShifts',b.dataset.she)));
  $$('#wmsBody [data-shd]').forEach(b=>b.onclick=()=>{ const s=Store.get('wmsShifts',b.dataset.shd); confirmDelete(s.name,()=>{ Store.remove('wmsShifts',s.id); renderWMS($('#view')); }); });
}
function wmsShiftForm(existing){
  const fields=[
    {name:'name',label:'Shift name',type:'text',required:true,row:'a'},
    {name:'start',label:'Start (HH:MM)',type:'time',required:true,row:'a'},
    {name:'end',label:'End (HH:MM)',type:'time',required:true,row:'a'},
    {name:'weekend',label:'Weekend shift',type:'checkbox',cbLabel:'Applies on Sat/Sun',row:'b'},
    {name:'active',label:'Active',type:'checkbox',cbLabel:'Active',value:true,row:'b'},
  ];
  openForm({title:existing?'Edit shift':'New shift', fields, values:existing||{active:true},
    onSave:(vals)=>{ vals.active=vals.active!==false; if(existing) Store.update('wmsShifts',existing.id,vals); else Store.insert('wmsShifts',vals); closeModal(); renderWMS($('#view')); toast('Shift saved'); }});
}

function wmsLog(box){
  const rows=Store.col('wmsSyncLog').slice(0,50);
  box.innerHTML = `<div class="card"><h3>WMS Sync Log</h3>
    <div class="tablewrap"><table><thead><tr><th>Time</th><th>Operation</th><th>Range</th><th>Retrieved</th><th>Inserted</th><th>Dupes</th><th>Warn</th><th>ms</th><th>Status</th></tr></thead>
    <tbody>${rows.length?rows.map(l=>`<tr><td class="small">${h(new Date(l.at).toLocaleString())}</td><td>${h(l.operation)}</td><td class="small">${h(l.dateRange||'—')}</td>
      <td>${l.retrieved}</td><td>${l.inserted}</td><td>${l.duplicates}</td><td>${l.warnings}</td><td class="small">${l.durationMs}</td>
      <td><span class="badge ${l.status==='VALID'?'b-ok':(l.status==='WARNING'?'b-warn':'b-crit')}">${h(l.status)}</span></td></tr>`).join(''):emptyRow(9,'No syncs yet')}</tbody></table></div></div>`;
}

/* =========================================================================
   BOOT
   =======================================================================*/
async function boot(){
  Store.load();
  if(!Store.db.validations) Store.db.validations=[];
  // Shared copy first: on the agent, adopt/merge the machine-wide database BEFORE anything (incl. the
  // boot WMS sync) persists — otherwise a stale tab could overwrite newer data with its own.
  if(Store.onAgent()){ await Store.pullFromServer({initial:true}); Store.startPolling(); }
  // If opened as a local file (file://) but the agent is running, show a clear link to the
  // correct localhost app — that origin has the live WMS sync and is the canonical instance.
  if(location.protocol==='file:'){
    try{ fetch('http://localhost:8790/wms/health',{cache:'no-store'}).then(r=>{ if(r&&r.ok){
      const b=document.createElement('div');
      b.style.cssText='position:sticky;top:0;z-index:9999;background:#123527;color:#7fe3b6;padding:10px 16px;font-size:14px;text-align:center;border-bottom:1px solid #1e4a34';
      b.innerHTML='🟢 Agjenti është aktiv. Ky është versioni <b>file://</b> (pa sync). Për të dhëna live, hape këtu: <a href="http://localhost:8790/app.html" style="color:#b6f0d3;font-weight:700">http://localhost:8790/app.html</a>';
      document.body.insertBefore(b, document.body.firstChild);
    }}).catch(()=>{}); }catch(e){}
  }
  buildNav();
  $('#hamburger').onclick=()=>{ $('#sidebar').classList.toggle('open'); $('#scrim').classList.toggle('on'); };
  $('#scrim').onclick=closeSidebar;
  window.addEventListener('hashchange',go);
  go();
  // WMS auto-sync: whenever the app is served by the local agent, sync now + on schedule.
  // Boot sync always runs on the agent (so it "just works"); the toggle only gates the recurring timer.
  try{ if(wmsOnAgent() && wmsCfg().autoSync!==false){ wmsAgentSync(7).then(()=>{ if((location.hash||'')==='#wms') renderWMS($('#view')); }); wmsScheduleAuto(); } }catch(e){}
}
/* =========================================================================
   RAPORTET — archive of the agent's daily (21:30) and weekly (Friday 21:35)
   narrative reports, plus live previews and manual (re)generation.
   =======================================================================*/
let rapTab='weekly', rapOpen=null;   // rapOpen = {kind:'daily'|'weekly', key}
function renderRaportet(v){
  const onAgent=Store.onAgent();
  const wcfg=Store.db.wms||{};
  const dayT=wcfg.dailyReportTime||'21:30', wkT=wcfg.weeklyReportTime||'21:35';
  v.innerHTML = pagehead('Raportet',
    `Raporte narrative të gjeneruara automatikisht nga agjenti: <b>ditore</b> çdo ditë pas orës ${h(dayT)} (mbyllja e turnit) dhe <b>javore</b> çdo të premte pas orës ${h(wkT)}. Bazohen në shifrat WMS dhe në ditar; ruajnë ndarjen fakt–hipotezë.`,
    `<button class="btn" id="rapPrint">🖨 Print / PDF</button>`)
    + `<div class="filters" id="rapTabs"><button class="btn ${rapTab==='weekly'?'primary':''}" data-t="weekly">Javore</button><button class="btn ${rapTab==='daily'?'primary':''}" data-t="daily">Ditore</button></div>`
    + `<div id="rapBody"></div>`;
  $('#rapPrint').onclick=()=>window.print();
  $$('#rapTabs [data-t]').forEach(b=>b.onclick=()=>{ rapTab=b.dataset.t; rapOpen=null; renderRaportet(v); });
  (rapTab==='weekly'?rapWeekly:rapDaily)($('#rapBody'), onAgent);
}
function rapMeta(r){ const g=new Date(r.generatedAt); return `${g.toLocaleDateString()} ${g.toTimeString().slice(0,5)}${r.scheduled?' · automatik':' · manual'}`; }
function rapStat(label,val,cls){ return val==null||val===''?'':`<span class="badge ${cls||'b-muted'}" style="margin-right:4px">${h(label)}: ${h(String(val))}</span>`; }
async function rapRun(url, btn, after){
  if(!btn) return; const old=btn.textContent; btn.disabled=true; btn.textContent='⏳ Po gjenerohet… (sync WMS, mund të zgjasë deri 2 min)';
  try{ const r=await fetch(url,{method:'POST'}); const j=await r.json(); if(!r.ok||j.error) throw new Error(j.error||('HTTP '+r.status));
    await Store.pullFromServer(); toast('Raporti u arkivua'+(j.synced?' · WMS sync ✓':'')); after&&after(j); }
  catch(e){ toast('Gjenerimi dështoi: '+e.message); btn.disabled=false; btn.textContent=old; }
}
function rapWeekly(box, onAgent){
  const reps=Store.col('weeklyReports').slice().sort((a,b)=>a.weekStart<b.weekStart?1:-1);
  const cur=WODS.weekBounds(todayStr());
  const wkNo=ws=>WODS.weekNumber(Store.db,ws);
  const dateVal=(rapOpen&&rapOpen.kind==='weekly'&&rapOpen.key)||cur.start;
  box.innerHTML=`<div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <b>Java aktuale:</b> <span class="badge b-muted">Java ${h(String(wkNo(cur.start)))} · ${h(fmtDateAl(cur.start))} – ${h(fmtDateAl(cur.end))}</span>
        <button class="btn sm" id="rapWeekLive">👁 Shiko live</button>
        ${onAgent?`<span style="margin-left:auto;display:flex;gap:6px;align-items:center"><span class="small muted">Gjenero për javën e datës</span><input type="date" id="rapWeekDate" value="${h(dateVal)}" style="width:auto;min-height:34px"><button class="btn sm primary" id="rapWeekRun">⚙ Gjenero / rigjenero</button></span>`:`<span class="hint" style="margin:0 0 0 auto">Gjenerimi bëhet nga agjenti (hape app-in te http://localhost:8790).</span>`}
      </div>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Java</th><th>Periudha</th><th>Gjeneruar</th><th class="wrap">Shifra kyçe</th><th></th></tr></thead>
      <tbody>${reps.length?reps.map(r=>`<tr>
        <td><b>Java ${h(String(r.weekNo!=null?r.weekNo:wkNo(r.weekStart)))}</b></td>
        <td>${h(fmtDateAl(r.weekStart))} – ${h(fmtDateAl(r.weekEnd))}</td>
        <td class="small">${h(rapMeta(r))}</td>
        <td class="wrap">${r.stats?rapStat('Porosi',r.stats.prepTotal)+rapStat('Mes./ditë pune',r.stats.avgWork)+rapStat('Out/In',r.stats.outRate!=null?r.stats.outRate+'%':null,r.stats.outRate!=null&&r.stats.outRate<75?'b-warn':'b-ok')+rapStat('Vëzhgime',r.stats.obs)+rapStat('Kritike',r.stats.critical,r.stats.critical?'b-crit':'b-muted')+rapStat('Matje',r.stats.meas):''}</td>
        <td><button class="btn sm ${rapOpen&&rapOpen.kind==='weekly'&&rapOpen.key===r.weekStart?'primary':''}" data-open="${h(r.weekStart)}">Shiko</button> ${onAgent?`<a class="btn sm ghost" href="/reports/weekly-${h(r.weekStart)}.html" target="_blank" rel="noopener" title="Hap si faqe të veçantë për print/dërgim">↗</a>`:''}</td>
      </tr>`).join(''):emptyRow(5,'Ende s\'ka raporte javore të arkivuara. Gjenero një me butonin lart — agjenti sinkronizon shifrat WMS të javës dhe e përpilon.')}</tbody></table></div>
    <div id="rapView" style="margin-top:14px"></div>`;
  const view=$('#rapView');
  const show=(html,label)=>{ view.innerHTML=`<div class="meta muted small" style="margin-bottom:6px">${label}</div>`+html; view.scrollIntoView({behavior:'smooth',block:'start'}); };
  $$('#rapBody [data-open]').forEach(b=>b.onclick=()=>{ rapOpen={kind:'weekly',key:b.dataset.open}; const r=reps.find(x=>x.weekStart===b.dataset.open); rapWeekly(box,onAgent); if(r) $('#rapView').innerHTML=`<div class="meta muted small" style="margin-bottom:6px">Raport i arkivuar · ${h(rapMeta(r))}</div>`+r.html; });
  $('#rapWeekLive').onclick=()=>{ const n=WODS.buildWeeklyNarrative(Store.db, todayStr()); show(n.empty?'<div class="empty">S\'ka të dhëna për këtë javë.</div>':n.html, 'Pamje live nga të dhënat aktuale (jo e arkivuar)'); };
  const run=$('#rapWeekRun'); if(run) run.onclick=()=>{ const d=$('#rapWeekDate').value||todayStr(); rapRun('/report/week?date='+encodeURIComponent(d), run, ()=>{ rapOpen={kind:'weekly',key:WODS.weekBounds(d).start}; renderRaportet($('#view')); const r=Store.col('weeklyReports').find(x=>x.weekStart===rapOpen.key); if(r&&$('#rapView')) $('#rapView').innerHTML=`<div class="meta muted small" style="margin-bottom:6px">Raport i arkivuar · ${h(rapMeta(r))}</div>`+r.html; }); };
  if(rapOpen&&rapOpen.kind==='weekly'){ const r=reps.find(x=>x.weekStart===rapOpen.key); if(r) view.innerHTML=`<div class="meta muted small" style="margin-bottom:6px">Raport i arkivuar · ${h(rapMeta(r))}</div>`+r.html; }
}
function rapDaily(box, onAgent){
  const reps=Store.col('dailyReports').slice().sort((a,b)=>a.date<b.date?1:-1);
  const dateVal=(rapOpen&&rapOpen.kind==='daily'&&rapOpen.key)||todayStr();
  box.innerHTML=`<div class="card" style="margin-bottom:12px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <b>Dita:</b> <input type="date" id="rapDayDate" value="${h(dateVal)}" style="width:auto;min-height:34px">
        <button class="btn sm" id="rapDayLive">👁 Shiko live</button>
        ${onAgent?`<button class="btn sm primary" id="rapDayRun" style="margin-left:auto">⚙ Gjenero / rigjenero për këtë datë</button>`:''}
      </div>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Data</th><th>Gjeneruar</th><th class="wrap">Shifra kyçe</th><th></th></tr></thead>
      <tbody>${reps.length?reps.map(r=>`<tr>
        <td><b>${h(fmtDateAl(r.date))}</b></td>
        <td class="small">${h(rapMeta(r))}</td>
        <td class="wrap">${r.stats?rapStat('Porosi',r.stats.prep)+rapStat('Out/In',r.stats.outRate!=null?r.stats.outRate+'%':null,r.stats.outRate!=null&&r.stats.outRate<75?'b-warn':'b-ok')+rapStat('Vëzhgime',r.stats.obs)+rapStat('Auto',r.stats.auto)+rapStat('Kritike',r.stats.critical,r.stats.critical?'b-crit':'b-muted')+rapStat('Presin validim',r.stats.pending):''}</td>
        <td><button class="btn sm ${rapOpen&&rapOpen.kind==='daily'&&rapOpen.key===r.date?'primary':''}" data-open="${h(r.date)}">Shiko</button> ${onAgent?`<a class="btn sm ghost" href="/reports/daily-${h(r.date)}.html" target="_blank" rel="noopener" title="Hap si faqe të veçantë për print/dërgim">↗</a>`:''}</td>
      </tr>`).join(''):emptyRow(4,'Ende s\'ka raporte ditore të arkivuara. Gjenerohen vetë çdo mbrëmje; ose gjenero një me butonin lart.')}</tbody></table></div>
    <div id="rapView" style="margin-top:14px"></div>`;
  const view=$('#rapView');
  const showRep=r=>{ view.innerHTML=`<div class="meta muted small" style="margin-bottom:6px">Raport i arkivuar · ${h(rapMeta(r))}</div>`+r.html; };
  $$('#rapBody [data-open]').forEach(b=>b.onclick=()=>{ rapOpen={kind:'daily',key:b.dataset.open}; rapDaily(box,onAgent); const r=Store.col('dailyReports').find(x=>x.date===b.dataset.open); if(r) showRep(r); $('#rapView').scrollIntoView({behavior:'smooth',block:'start'}); });
  $('#rapDayLive').onclick=()=>{ const d=$('#rapDayDate').value||todayStr(); const n=WODS.buildDailyNarrative(Store.db,d); view.innerHTML=`<div class="meta muted small" style="margin-bottom:6px">Pamje live për ${h(fmtDateAl(d))} nga të dhënat aktuale (jo e arkivuar)</div>`+(n.empty?'<div class="empty">S\'ka të dhëna për këtë datë.</div>':n.html); };
  const run=$('#rapDayRun'); if(run) run.onclick=()=>{ const d=$('#rapDayDate').value||todayStr(); const skipAuto=Store.col('observations').some(o=>o.date===d&&!o.auto&&/WMS/i.test(o.source||''));
    rapRun('/report/run?date='+encodeURIComponent(d)+(skipAuto?'&auto=0':''), run, ()=>{ rapOpen={kind:'daily',key:d}; renderRaportet($('#view')); const r=Store.col('dailyReports').find(x=>x.date===d); if(r&&$('#rapView')) $('#rapView').innerHTML=`<div class="meta muted small" style="margin-bottom:6px">Raport i arkivuar · ${h(rapMeta(r))}</div>`+r.html; }); };
  if(rapOpen&&rapOpen.kind==='daily'){ const r=reps.find(x=>x.date===rapOpen.key); if(r) showRep(r); }
}
document.addEventListener('DOMContentLoaded',boot);
