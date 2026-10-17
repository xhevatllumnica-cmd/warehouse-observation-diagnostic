/* Sorting for every table in the app (also /tabela and /postat): click a column header to sort, click again to reverse.
   Works on the rendered table, so no page has to do anything: the column type is detected from its cells — numbers (with
   units such as "168.5 ditë", "2 / 4", "1,234 €", "45%"), dates ("20.04 23:47", "22.10.2025", "2026-10-06"), times ("13:00")
   or text. Numbers and dates start with the largest / newest, text with A→Z. Empty cells ("—") always go last; a total row
   ("Gjithsej", "Total") stays at the bottom; a detail row (one cell spanning the row) moves with the row above it.
   The sort is remembered while the page is open, and applied again when a page redraws the same table (auto refresh).
   A table opts out with class "nosort"; a cell can give its own sort value with data-sort; a row with class "ts-section"
   starts a section, and each section is sorted on its own under its heading row. */
(function(){
  if(window.__tableSort) return; window.__tableSort=true;
  const css=document.createElement('style');
  css.textContent='th.ts-th{cursor:pointer;user-select:none;white-space:nowrap}th.ts-th:hover{color:var(--accent,#115b92)}'
    +'.ts-ind{display:inline-block;margin-left:4px;font-size:.8em;opacity:.35}th.ts-on .ts-ind{opacity:1;color:var(--accent,#115b92)}'
    +'@media print{.ts-ind{display:none}}';
  document.head.appendChild(css);

  const EMPTY=/^(—|–|-|n\/a|null|undefined|)$/i, TOTAL=/^(gjithsej|total|totali|∑|shuma)\b/i;
  const remembered=new Map();   // table key → {col, dir}
  const seen=new WeakSet();     // rows already in their sorted place

  function headerRow(t){ if(t.tHead && t.tHead.rows.length) return t.tHead.rows[t.tHead.rows.length-1];
    const b=t.tBodies[0], r=b&&b.rows[0]; return r && r.cells.length && [...r.cells].every(c=>c.tagName==='TH')? r : null; }
  function bodyRows(t, hr){ const rows=[]; [...t.tBodies].forEach(b=>[...b.rows].forEach(r=>{ if(r!==hr) rows.push(r); })); return rows; }
  function sortable(t){
    if(t.classList.contains('nosort') || t.closest('.nosort')) return false;
    const hr=headerRow(t); if(!hr || hr.cells.length<2) return false;
    if([...hr.cells].some(c=>c.colSpan>1)) return false;   // grouped headers: column positions are not plain
    const rows=bodyRows(t,hr); if(rows.length<2) return false;
    return !rows.some(r=>[...r.cells].some(c=>c.rowSpan>1));   // merged rows cannot be moved one by one
  }
  const keyOf=t=>{ const hr=headerRow(t); return location.pathname+location.hash.split('?')[0]+'|'+[...hr.cells].map(c=>c.dataset.tsLabel||c.textContent.trim()).join('|'); };

  // ---- values
  // durations in mixed units ("50 min", "45 h", "2.5 ditë", "1h 20m") → minutes, so they compare across units
  const UNIT={s:1/60, sek:1/60, m:1, min:1, minuta:1, h:60, orë:60, ore:60, d:1440, ditë:1440, dite:1440, javë:10080, jave:10080};
  const DUR=/(\d+(?:[.,]\d+)?)\s*(minuta|min|sek|orë|ore|ditë|dite|javë|jave|h|d|m|s)(?![A-Za-zÀ-ÿ])/gi;
  function num(s){
    const parts=[...String(s).matchAll(DUR)];
    if(parts.length) return parts.reduce((a,p)=>a+parseFloat(p[1].replace(',','.'))*UNIT[p[2].toLowerCase()],0);
    const m=String(s).replace(/\u00a0|\u202f/g,' ').match(/-?\d[\d\s.,']*/); if(!m) return null;
    let x=m[0].replace(/[\s']/g,'').replace(/[.,]$/,'');
    const dots=(x.match(/\./g)||[]).length, commas=(x.match(/,/g)||[]).length;
    if(dots && commas){ const dec=x.lastIndexOf('.')>x.lastIndexOf(',')? '.' : ','; x=x.split(dec===','?'.':',').join(''); if(dec===',') x=x.replace(',','.'); }
    else if(commas){ x= commas>1 || /,\d{3}$/.test(x)? x.replace(/,/g,'') : x.replace(',','.'); }
    else if(dots>1) x=x.replace(/\./g,'');
    const v=parseFloat(x); return isNaN(v)? null : v;
  }
  function date(s){
    s=String(s).trim(); let m;
    if((m=s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/))) return Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0));
    if((m=s.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\.?(?:,?\s+(\d{1,2}):(\d{2}))?(?:\s|$)/)) && (m[3]||m[4])){
      const d=+m[1], mo=+m[2]; if(d<1||d>31||mo<1||mo>12) return null;
      let y=m[3]? +m[3] : new Date().getFullYear(); if(y<100) y+=2000;
      // a date without a year after today belongs to last year (e.g. "20.04 23:47" read in October is this year; "20.12" in January is last year)
      let v=Date.UTC(y,mo-1,d,+(m[4]||0),+(m[5]||0)); if(!m[3] && v>Date.now()+86400000*31) v=Date.UTC(y-1,mo-1,d,+(m[4]||0),+(m[5]||0));
      return v; }
    return null;
  }
  const time=s=>{ const m=String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|–|-|$)/); return m? +m[1]*60+ +m[2] + (+(m[3]||0))/60 : null; };
  const cellText=c=> c? (c.dataset.sort!=null? c.dataset.sort : c.textContent.replace(/\s+/g,' ').trim()) : '';

  function columnType(vals){
    const filled=vals.filter(v=>!EMPTY.test(v)); if(!filled.length) return 'text';
    const share=f=>filled.filter(v=>f(v)!=null).length/filled.length;
    if(share(date)>=0.6) return 'date';
    if(share(time)>=0.6) return 'time';
    // a number column: most cells start with a number (units after it are fine); names with a number inside stay text
    if(filled.filter(v=>/^[-+−]?[€$]?\s?\d/.test(v.replace('−','-')) && num(v)!=null).length/filled.length>=0.6) return 'num';
    return 'text';
  }

  function apply(t, col, dir){
    const hr=headerRow(t); if(!hr || col>=hr.cells.length) return;
    const rows=bodyRows(t,hr), width=hr.cells.length;
    // groups: a main row + the detail rows after it (one cell over the whole width); totals stay at the bottom
    const groups=[], totals=[];
    const wide=r=>r.cells.length===1 && r.cells[0].colSpan>1 && r.cells[0].colSpan>=width-1;
    // note rows at the end of the table (one cell over the whole width, nothing sortable after them) stay at the bottom
    let tail=rows.length; while(tail>0 && (wide(rows[tail-1]) || TOTAL.test(cellText(rows[tail-1].cells[0])))) tail--;
    rows.forEach((r,ri)=>{ const detail=wide(r) && !r.classList.contains('ts-section');
      if(ri>=tail) totals.push(r);
      else if(detail && groups.length) groups[groups.length-1].rows.push(r);
      else if(TOTAL.test(cellText(r.cells[0]))) totals.push(r);
      else groups.push({rows:[r], i:groups.length, v:cellText(r.cells[col])}); });
    groups.forEach(g=>{ g.sec=0; }); { let sec=0; groups.forEach(g=>{ if(g.rows[0].classList.contains('ts-section')){ sec++; g.head=true; } g.sec=sec; }); }
    const type=columnType(groups.filter(g=>!g.head).map(g=>g.v)), f= type==='date'? date : type==='time'? time : type==='num'? num : null;
    groups.forEach(g=>{ g.e=EMPTY.test(g.v); g.k= f? f(g.v) : g.v.toLowerCase(); if(f && g.k==null) g.e=true; });
    const sign= dir==='asc'? 1 : -1;
    groups.sort((a,b)=> a.sec!==b.sec? a.sec-b.sec : a.head!==b.head? (a.head?-1:1) : a.e!==b.e? (a.e?1:-1) : a.e? a.i-b.i
      : (f? (a.k-b.k)*sign : a.k.localeCompare(b.k,'sq',{numeric:true})*sign) || a.i-b.i);
    const body=rows[0].parentNode;   // every moved row goes to the first body, in the new order
    groups.forEach(g=>g.rows.forEach(r=>body.appendChild(r))); totals.forEach(r=>body.appendChild(r));
    [...hr.cells].forEach((c,i)=>{ const ind=c.querySelector('.ts-ind'); c.classList.toggle('ts-on', i===col); if(ind) ind.textContent= i===col? (dir==='asc'?'▲':'▼') : '↕'; });
    t.dataset.tsCol=col; t.dataset.tsDir=dir; rows.forEach(r=>seen.add(r));
  }

  function prepare(t){
    if(t.dataset.tsReady || !sortable(t)) return;
    t.dataset.tsReady='1';
    const hr=headerRow(t);
    [...hr.cells].forEach(c=>{ if(c.querySelector('.ts-ind')) return; c.dataset.tsLabel=c.textContent.trim(); c.classList.add('ts-th');
      if(!c.title) c.title='Kliko për renditje'; const s=document.createElement('span'); s.className='ts-ind'; s.textContent='↕'; c.appendChild(s); });
    const saved=remembered.get(keyOf(t)); if(saved) apply(t, saved.col, saved.dir);
  }

  document.addEventListener('click', e=>{
    const th=e.target.closest && e.target.closest('th.ts-th'); if(!th) return;
    if(e.target.closest('button,a,input,select,textarea,label,summary')) return;   // controls inside a header keep their own job
    const t=th.closest('table'), hr=headerRow(t); if(!hr || th.parentNode!==hr) return;
    const col=[...hr.cells].indexOf(th);
    const same=String(t.dataset.tsCol)===String(col);
    let dir;
    if(same) dir= t.dataset.tsDir==='asc'? 'desc' : 'asc';
    else{ const rows=bodyRows(t,hr).map(r=>cellText(r.cells[col])); dir= columnType(rows)==='text'? 'asc' : 'desc'; }
    apply(t, col, dir); remembered.set(keyOf(t), {col, dir});
  });

  // tables appear and are redrawn all the time (pages, refresh): prepare them as they come
  let queued=false;
  const scan=()=>{ queued=false;
    document.querySelectorAll('table[data-ts-ready]').forEach(t=>{ const hr=headerRow(t);
      if(!hr || !hr.querySelector('.ts-ind')){ delete t.dataset.tsReady; return; }   // header redrawn → prepare again
      if(t.dataset.tsCol!=null && bodyRows(t,hr).some(r=>!seen.has(r))) apply(t, +t.dataset.tsCol, t.dataset.tsDir); });   // rows redrawn → sort again
    document.querySelectorAll('table:not([data-ts-ready])').forEach(prepare); };
  new MutationObserver(()=>{ if(!queued){ queued=true; requestAnimationFrame(scan); } }).observe(document.documentElement, {childList:true, subtree:true});
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
