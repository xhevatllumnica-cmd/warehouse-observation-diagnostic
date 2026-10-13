/* ============================================================================
   Kërko produkt (the warehouse lead, 13.10.2026) — product / order search over the WMS and the Delivery Platform,
   through the agent's own sessions. READ-ONLY: only list reads the web pages themselves make; nothing is written.
   What phase 0 found (13.10.2026, tested on product 6297001571002 and orders 1277109 / 1316779):
     · WMS /Warehouse/ProductLogsData takes exact filters ProductCode (EAN) / Sku / ProductItemUniqueIdentifier (unit) /
       ProductSerialNumber over a range of dates: 365 days in ONE request (253 rows, ~0.5 s). Its text search is ignored,
       a partial SKU finds nothing → exact codes only.
     · WMS /Order/OrderProductsByOrderId (POST orderId) → the order's units (name, code, SKU, unit, status).
     · No WMS read searches by product NAME → a local index of names, built from the day logs the agent already reads
       (+ a slow back-fill of the last 30 days): data/product-index.json (product names / codes only).
     · Delivery Platform: no search by order in the scanned / delivery lists (their orderIds field is empty) → an order's
       POD scan is found in the POD scans of its check-out day and the next days (cached by the agent), its courier and
       delivery status in that day's POD delivery items (a refusal shows there; the refusals list ignores its OrderId filter).
   Customer data (names, phones, addresses …) never leaves the agent: the POD readers already keep only order, platform,
   courier, status and dates.
   ==========================================================================*/
'use strict';
const fs=require('fs'), path=require('path');

module.exports=function makeProductSearch(d){
  const IDX_FILE=path.join(d.appDir,'data','product-index.json');
  let idx={v:1, days:{}, p:{}}; try{ const j=JSON.parse(fs.readFileSync(IDX_FILE,'utf8')); if(j && j.p) idx=j; }catch(e){}
  let idxDirty=false;
  const nk=s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  const OUT_TYPES=['Checked out','Check out','ProductScanned for checkout','Driver','Ready for delivery'];
  const IN_TYPES=['Checked in','Map product','Mapped product'];
  const loc=ms=>{ const t=new Date(ms); return t.getFullYear()+'-'+d.p2(t.getMonth()+1)+'-'+d.p2(t.getDate())+' '+d.p2(t.getHours())+':'+d.p2(t.getMinutes()); };
  const person=raw=>{ const r=String(raw||'').replace(/\s+/g,' ').trim(); return d.STAFF_ALIASES[d.normName(r)]||r; };

  /* ---- the name index: product name → code / SKU, from every day log the agent reads ---- */
  function indexRows(iso, rows){
    let n=0; (rows||[]).forEach(x=>{ const name=String(x.ProductName||'').replace(/\s+/g,' ').trim(), code=String(x.ProductCode||'').trim(), sku=String(x.Sku||'').trim();
      if(!name || (!code && !sku)) return; const k=code+'|'+sku, o=idx.p[k];
      if(!o){ idx.p[k]={n:name, c:code, s:sku, t:iso}; n++; } else if(iso>o.t){ o.t=iso; o.n=name; } });
    if(iso) idx.days[iso]=1; idxDirty=true; return n;
  }
  setInterval(()=>{ if(!idxDirty) return; idxDirty=false; try{ fs.mkdirSync(path.dirname(IDX_FILE),{recursive:true}); fs.writeFileSync(IDX_FILE, JSON.stringify(idx)); }catch(e){} }, 60000);
  // back-fill: the last 30 days, one day every 2 minutes, without keeping the rows in memory
  let backfillBusy=false;
  setInterval(async()=>{ if(backfillBusy) return; const today=d.isoToday();
    for(let i=1;i<=30;i++){ const iso=d.isoAddDays(today,-i); if(idx.days[iso]) continue;
      backfillBusy=true; try{ const dl=await d.fetchDayProductLogs(d.isoToMdy(iso), {noCache:true}); if(!dl.error) indexRows(iso, dl.rows); }catch(e){} finally{ backfillBusy=false; } return; } }, 120000);
  function byName(q){
    const toks=nk(q).split(' ').filter(t=>t.length>=2); if(!toks.length) return [];
    return Object.values(idx.p).filter(o=>{ const n=nk(o.n); return toks.every(t=>n.includes(t)); })
      .sort((a,b)=> (b.t||'').localeCompare(a.t||'') || a.n.localeCompare(b.n)).slice(0,40).map(o=>({name:o.n, code:o.c, sku:o.s, lastSeen:o.t}));
  }

  /* ---- WMS: the product log by an exact code, over the last 365 days ---- */
  async function plog(filter){
    const today=d.isoToday(), from=d.isoAddDays(today,-364), rows=[], seen=new Set();
    for(let start=0, guard=0; guard<5; guard++){
      const body=d.enc({draw:1,start,length:2000,search:{value:'',regex:false},order:[{column:10,dir:'desc'}],columns:d.PLOG_COLS,
        filters:Object.assign({StartDate:d.isoToMdy(from),EndDate:d.isoToMdy(today),StoreId:0,ProductCode:'',Sku:'',ProductItemUniqueIdentifier:'',ProductSerialNumber:''}, filter)}).join('&');
      const r=await d.wmsFetch('/Warehouse/ProductLogsData',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body});
      if(d.looksLoggedOut(r)) return {error:'auth_expired'};
      let j; try{ j=JSON.parse(r.body); }catch(e){ return {error:'bad_response'}; }
      const data=j.data||[]; data.forEach(x=>{ const k=x.Id!=null? x.Id : JSON.stringify(x); if(!seen.has(k)){ seen.add(k); rows.push(x); } });
      const total=Number(j.recordsFiltered)||0; start+=data.length; if(!data.length || start>=total) return {rows, total, complete:rows.length>=total};
    }
    return {rows, total:rows.length, complete:false};
  }
  // rows of one product (or unit) → the product card: units with their last event, history, orders
  function productCards(rows){
    const byP={};
    rows.forEach(x=>{ const t=d.parseWmsDate(x.InsertDateTime); if(t==null) return; const key=(x.ProductCode||'')+'|'+(x.Sku||'');
      const p=byP[key]||(byP[key]={code:x.ProductCode||'', sku:x.Sku||'', name:String(x.ProductName||'').trim(), vendor:String(x.VendorName||'').trim(), ev:[]});
      p.ev.push({t, type:x.LogType||('#'+x.LogTypeId), row:String(x.Row||'').trim().replace(/^-+$/,'') /* "---" = no row */, order:Number(x.OrderId)||0, pid:Number(x.PlatformId)||0, by:person(x.UpdatedByName), uid:String(x.ProductItemUniqueIdentifierId||'').trim(), serial:String(x.ProductSerialNumber||'').trim()}); });
    return Object.values(byP).map(p=>{ p.ev.sort((a,b)=>b.t-a.t);
      const units={}; p.ev.forEach(e=>{ if(!e.uid) return; const u=units[e.uid]||(units[e.uid]={uid:e.uid, serial:e.serial, ev:[]}); u.ev.push(e); });
      const U=Object.values(units).map(u=>{ const last=u.ev[0], row=(u.ev.find(e=>e.row)||{}).row||'', out=OUT_TYPES.includes(last.type);
        const coEv=u.ev.find(e=>e.order && OUT_TYPES.includes(e.type));
        return {uid:u.uid, serial:u.serial, status: out? 'out' : IN_TYPES.includes(last.type)? 'in' : 'other', lastType:last.type, lastAt:loc(last.t), row: out? '' : row,
          order: coEv? coEv.order : 0, pid: coEv? coEv.pid : 0, outAt: coEv? loc(coEv.t) : null, by:last.by}; })
        .sort((a,b)=>(b.lastAt||'').localeCompare(a.lastAt||''));
      const orders=[], seenO=new Set(); p.ev.forEach(e=>{ if(e.order && OUT_TYPES.includes(e.type) && !seenO.has(e.order+'|'+e.pid)){ seenO.add(e.order+'|'+e.pid); orders.push({order:e.order, pid:e.pid, date:loc(e.t).slice(0,10), at:loc(e.t)}); } });
      return {code:p.code, sku:p.sku, name:p.name, vendor:p.vendor, events:p.ev.length,
        counts:{units:U.length, in:U.filter(u=>u.status==='in').length, out:U.filter(u=>u.status==='out').length, other:U.filter(u=>u.status==='other').length},
        units:U.slice(0,200), orders:orders.slice(0,40),
        history:p.ev.slice(0,80).map(e=>({at:loc(e.t), type:e.type, row:e.row, order:e.order||null, by:e.by, uid:e.uid}))}; });
  }
  async function orderProducts(orderId){
    const r=await d.wmsFetch('/Order/OrderProductsByOrderId',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'},body:'orderId='+encodeURIComponent(orderId)});
    if(d.looksLoggedOut(r)) return {error:'auth_expired'};
    let j; try{ j=JSON.parse(r.body); }catch(e){ return {error:'bad_response'}; }
    const arr=Array.isArray(j)? j : [];
    return {items:arr.map(x=>({name:String(x.ProductName||'').trim(), code:x.ProductCode||'', sku:x.Sku||'', uid:x.ProductItemUniqueIdentifier||'', serial:x.ProductSerialNumber||'', status:x.Status||'', statusId:x.StatusId, row:x.RowShortName||'', platformId:x.PlatformId||null}))};
  }

  /* ---- the search: q → order / exact codes / names ---- */
  const cache={};
  async function search(qRaw){
    const q=String(qRaw||'').trim().replace(/\s+/g,' ');
    if(q.length<2 || q.length>80) return {error:'Shkruaj të paktën 2 shenja (deri në 80).'};
    const ck=q.toLowerCase(); if(cache[ck] && Date.now()-cache[ck].at<60000) return cache[ck].v;
    const out={q, at:new Date().toISOString(), products:[], order:null, names:[]};
    const plain=/^[A-Za-z0-9._\-\/]+$/.test(q);
    if(/^\d{5,9}$/.test(q)){ const o=await orderProducts(q); if(o.error) return o;
      if(o.items.length){ out.order={orderId:Number(q), items:o.items, checkout:null};
        // the order's own check-out events, from the product log of each of its product codes (usually 1–3 codes)
        const ev=[]; for(const code of [...new Set(o.items.map(i=>i.code).filter(Boolean))].slice(0,6)){ const r=await plog({ProductCode:code}); if(r.error) return r;
          r.rows.forEach(x=>{ if(String(x.OrderId)===q){ const t=d.parseWmsDate(x.InsertDateTime); if(t!=null) ev.push({t, type:x.LogType, by:person(x.UpdatedByName), uid:String(x.ProductItemUniqueIdentifierId||''), pid:Number(x.PlatformId)||0}); } }); }
        ev.sort((a,b)=>a.t-b.t); const co=ev.filter(e=>OUT_TYPES.includes(e.type));
        if(co.length) out.order.checkout={first:loc(co[0].t), last:loc(co[co.length-1].t), by:[...new Set(co.map(e=>e.by).filter(Boolean))], pid:co[0].pid, date:loc(co[0].t).slice(0,10)};
        out.order.events=ev.slice(-40).reverse().map(e=>({at:loc(e.t), type:e.type, by:e.by, uid:e.uid})); } }
    if(plain){
      const found=[], by={};
      for(const [label, f] of [['code',{ProductCode:q}], ['sku',{Sku:q}], ['unit',{ProductItemUniqueIdentifier:q}], ['serial',{ProductSerialNumber:q}]]){
        const r=await plog(f); if(r.error) return r; if(r.rows.length){ by[label]=r.rows.length; found.push(...r.rows); if(label!=='serial') break; } }
      if(found.length){ out.matchedBy=Object.keys(by); out.products=productCards(found); out.complete=true; }
    }
    if(!out.products.length && !out.order && /[A-Za-zëçËÇ]/.test(q)) out.names=byName(q);
    out.index={products:Object.keys(idx.p).length, days:Object.keys(idx.days).length};
    cache[ck]={at:Date.now(), v:out}; return out;
  }

  /* ---- Delivery Platform for one order (check-out date known): POD scan, courier, delivery status, refusal ---- */
  async function orderDp(orderId, pid, fromIso){
    const oid=Number(orderId); if(!oid) return {error:'order'};
    const today=d.isoToday(), start= /^\d{4}-\d{2}-\d{2}$/.test(fromIso||'')? fromIso : d.isoAddDays(today,-6), res={orderId:oid, scan:null, delivery:null, searchedDays:[]};
    for(let i=0;i<5;i++){ const iso=d.isoAddDays(start,i); if(iso>today) break; res.searchedDays.push(iso);
      const s=await d.fetchPodScans(iso); if(s.error) return {error:s.error};
      const hit=(s.rows||[]).filter(r=>Number(r.oid)===oid && (!pid || !r.pid || Number(r.pid)===Number(pid))).sort((a,b)=>a.t-b.t)[0];
      if(hit){ res.scan={at:loc(hit.t), by:person(hit.scanner)};
        const day=await d.fetchPodDay(iso); if(!day.error){ const it=(day.items||[]).find(x=>Number(x.orderId)===oid && (!pid || !x.platformId || Number(x.platformId)===Number(pid)));
          if(it) res.delivery={post:String(it.driverName||''), status:it.deliveryItemStatus!=null? String(it.deliveryItemStatus) : null, orderStatus:it.orderStatus!=null? String(it.orderStatus) : null,
            delivered:it.deliveredDate||null, refused: it.processStatusRefused!=null? it.processStatusRefused : null, packages:it.packagesTotal!=null? it.packagesTotal : it.packages, city:it.city||null}; }
        break; } }
    // (the refusals list has an OrderId filter, but the platform ignores it — tested 13.10.2026: 10 984 rows either way —
    // so a refusal is read from the delivery status above: "refuzuar" / processStatusRefused)
    return res;
  }
  return {search, orderDp, indexRows, byName, indexInfo:()=>({products:Object.keys(idx.p).length, days:Object.keys(idx.days).sort()})};
};
