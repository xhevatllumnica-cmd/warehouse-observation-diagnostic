# WMS Data & Performance — Integration Documentation

Module inside the Warehouse Observation/Diagnostic app (`app.js`, route **WMS Data & Performance**).
Source system: **GjirafaWMS** — https://wms.gjirafamall.com/

## 1. Architecture (why import-based)
The app is an **offline single-page app** (opened from `app.html`, data in `localStorage`). A browser page
at `file://` (or any other origin) **cannot call the WMS directly** because:
- **CORS** blocks cross-origin XHR/fetch to `wms.gjirafamall.com`;
- it does **not** carry the user's WMS **session cookie**.

A file-only offline app therefore cannot self-fetch. **Automatic sync IS available** via a small
**local agent** (`wms-agent.js`, Node, no dependencies) that runs on the user's PC, serves the app at
`http://localhost:8790`, and proxies authorized reads from WMS using the user's session cookie
(kept only in the local, git-ignored `wms-agent.config.json`). The app, served from that origin, then
syncs on a schedule with no manual steps. A **manual console-snippet + import** path also exists as a fallback.

### Automatic sync — one-time setup
1. Get your WMS **cookie**: in Chrome on wms.gjirafamall.com (logged in) → F12 → Network → click any
   request → Request Headers → copy the whole **`cookie:`** value.
2. Copy `wms-agent.config.example.json` → `wms-agent.config.json`; paste the cookie into `"cookie"`.
3. Run **`start-wms-agent.bat`** (or `node wms-agent.js`).
4. Open **http://localhost:8790/app.html** → WMS Data & Performance → Import → turn **Auto-sync ON**
   (every 15/30/60 min) or click **Sync now**.
- The agent fetches `/Warehouse/GetDashboardStats` (live totals), `/Order/GetPreparedOrders`
  (orders prepared per operator, last 7 days), and `/Warehouse/ProductLogsData`
  (**products checked in** per operator/day, LogType «Checked in», paged), handling the antiforgery token automatically.
- Agent routes: `/wms/stats`, `/wms/prepared?start&end`, `/wms/checkin?start&end`, `/wms/health`.
- Check-in backfill is **incremental**: on open, only days missing from `wmsCheckin` (plus always today)
  are pulled; the 30-min timer refreshes only today. This avoids re-paging the event log every sync.
- **Auto-renewal (keep-alive):** the agent reads every `Set-Cookie` from WMS responses, updates its jar,
  writes it back to `wms-agent.config.json`, and pings `/Warehouse/GetDashboardStats` every 20 min.
  Because WMS uses **sliding-expiration** cookie auth, this renews the session automatically as long as
  the agent keeps running — so you rarely (if ever) need to re-paste the cookie. No auth is bypassed;
  this is exactly how a browser keeps its own session alive. (A true OIDC refresh-token flow isn't used:
  the WMS MVC endpoints authenticate by session cookie, not bearer token, and re-doing the login would
  require client credentials we don't hold — out of scope by the project's security rules.)
- If WMS still ends the login (absolute expiry / password change), the sync shows **auth_expired** —
  repeat step 1–2 with a fresh cookie.
- **Excel export:** WMS Data & Performance → Dashboard → **⬇ Export në Excel** downloads a multi-sheet
  `.xls` (Snapshot, Prepared by day/operator, Checked In by day/operator, Same-day flow) — offline, no library.
- The cookie stays only on your machine; the agent binds to 127.0.0.1 and `wms-agent.config.json` is git-ignored.

```
WMS (authorized session)  →  console snippet (same-origin fetch)  →  JSON file
      →  App Import (parse → validate → dedup → shift-assign)  →  localStorage  →  Analytics / Dashboard
```

## 2. Authentication
- WMS uses an ASP.NET **session cookie** (the user logs in normally in Chrome). 
- The app stores **no credentials**, no password, no session token. Nothing is committed to source.
- The console snippet reuses the already-authenticated session in the WMS tab (no login, no bypass).

## 3. Discovered endpoints (authorized, read-only)
| Endpoint | Method | Returns | Notes |
|---|---|---|---|
| `/Warehouse/GetDashboardStats` | GET | `{invoiceProductsCheckedIn, invoiceProductsProcessed, invoiceProductsToCheckIn, ordersReadyToUnmap, ordersInProcessing}` | **Live totals** (snapshot), not history/per-operator. Home page polls it. Light. |
| `/Warehouse/ProductLogsData` | POST | DataTables rows (see fields below) | **Corrected 2026-09-17:** with `filters[StartDate]`/`filters[EndDate]` (MM/DD/YYYY) + `filters[StoreId]=0` it **does** return the full day's event log (no product filter needed; no antiforgery token needed). Each row = one status event with `LogType`, `UpdatedByName`, `InsertDateTime`. **This is the check-in-by-operator/day source** (filter `LogType === "Checked in"`). ⚠ `length` > ~3000 makes the server **HTTP 500** on busy days → the agent pages in chunks of 2000. |
| `/Order/RowProductsData` | POST | current per-product state | Filters `filters[StatusIds]` (status enum) + `filters[RowId]`. Shows **current** status per product, not a historical event log (status=2 «Checked in» is usually ~0 because products move on quickly), so it is **not** used for daily check-in throughput. Status enum incl. Check in=1, Checked in=2, …, CheckInByPartner=41. |
| `/Order` (Order Dashboard) → `POST /Order/_GetStoreOrders` | POST | current orders to process (Id, Date, Tags) | Not "completed by day". Date format DD-MM-YYYY. |
| `/Order/GenerateReport` | POST | order **report export** (pick stores, includeInvoices, includeAllOrders) | The WMS's own export — **recommended import source** (Excel/CSV → app). |
| `/Warehouse/GetStores`, `/Warehouse/GetWarehousesByCompanyId` | GET | filter lookups | — |

**Corrected assumption:** the initial hypothesis "ProductLogs = operator activity feed" was **disproven by testing** (0 rows with date-only). Bulk per-day / per-operator data must come from the WMS's **native report exports** (e.g. Order → Dashboard → Report) or a dedicated report page yet to be identified. The date format for DataTables `DateRange` is **DD/MM/YYYY** (daterangepicker).

**ProductLogsData row fields** (DataTables `columns[].data`):
`UpdatedByName` (operator), `LogType` (action/status), `OrderId`, `InsertDateTime` (timestamp),
`Sku`, `ProductCode` (EAN), `Row` (location), `ProductName`, `VendorName`, `ProductSerialNumber`, `UniqueId`.

Not yet reverse-engineered (to avoid loading the production system): the enumerated **LogType values**,
the "Completed Orders – Last 30 Days" chart source, and the `/Order`, `/Shipments/Dashboard`,
`/Product/ReturnsDashboard`, `/Warehouse/Users` pages.

## 4. Data mapping (no assumptions)
Each ProductLogs row = one product-level **event** of a given `LogType`, performed by `UpdatedByName`
at `InsertDateTime`, for `OrderId`. The app stores these as-is:
- operator = `UpdatedByName`
- action/status = `LogType` (kept verbatim; the Lead maps meaning in **LogType mapping**)
- order = `OrderId`, product = `Sku`/`ProductCode`, location = `Row`, time = `InsertDateTime`

Explicitly **not assumed**: that 1 order = 1 product, 1 event = 1 order, check-in = receiving,
checkout = completed, or that a timestamp = active working time. Operators vs orders are kept distinct
(a single order may have events from several operators; both `OrderId` and `UpdatedByName` are retained).

## 5. Timestamp parsing
`wmsParseDate()` accepts ISO, `/Date(ms)/`, and `DD/MM/YYYY HH:mm:ss` (Kosovo locale). Unparseable
timestamps are **not invented** — the row is imported with an empty date and flagged as a WARNING.

## 6. Shift assignment (overlap-safe)
`assignShift(timestamp)` uses the local **Shift Management** config (default N1 07:00–15:00,
N2 13:00–21:00, Weekend 09:00–18:00). Rule:
- Weekend timestamps prefer weekend shifts; weekdays use non-weekend shifts.
- If the time falls inside **exactly one** active shift → that shift.
- If it falls inside **more than one** (e.g. N1∩N2 13:00–15:00) or **none** → **`UNKNOWN`** (never guessed).
WMS provides no per-operator shift field, so local config is authoritative; UNKNOWN is surfaced, not hidden.

## 7. Idempotent import (dedup)
Unique key per event: `WMS | UniqueId | LogType | OrderId | Sku | InsertDateTime | UpdatedByName`.
Re-importing the same data inserts 0 rows and counts duplicates. Every import writes a **Sync Log** entry
(retrieved / inserted / duplicates / warnings / duration / status VALID·WARNING·ERROR).

## 8. Database changes (localStorage collections, additive)
- `wmsLogs` — normalized product-log events (fields in §4 + `date`, `shift`, `source`, `sourceRef`, `importedAt`).
- `wmsStats` — dashboard snapshots (the GetDashboardStats fields + `at`, `date`, `source`).
- `wmsShifts` — shift config `{name,start,end,weekend,active}`.
- `wmsSyncLog` — import/sync history.
- `db.wms` — `{url, autoSync:false, lastSuccess, lastFailed, logTypeMap}`.
No existing collections modified; seeded once via the `wmsInit` migration.

## 9. Analytics
- **Operator Performance**: grouped by operator × date × shift → distinct **Orders**, product **events**,
  first/last activity, hours (last−first), events/hour. Labeled *Processed* (not "productivity") because
  active working time is unknown.
- **Dashboard**: live snapshot cards + charts (events by day, events/orders by operator, shift comparison).
- **Validation report**: WMS value (entered from the WMS dashboard) vs app-computed value → MATCH/MISMATCH
  with the difference shown; differences are never hidden or auto-corrected.

## 10. Import flow (how to use) — two paths
**Recommended: native WMS export → CSV import (reliable, traceable, no scraping)**
1. In WMS, open the report you use (e.g. **Order → Dashboard → Report**, or a Check-In export).
2. Download it; if Excel, Save As **CSV**.
3. App → **WMS Data & Performance → Import → 3 · Import a WMS export** → upload the CSV → **map columns**
   (Operator / Action / Order / Timestamp / SKU / EAN / Location — auto-guessed) → **Import CSV rows**.

**Alternative: authorized console fetch → JSON import** (only for endpoints that return bulk data;
ProductLogsData does not without a product filter, so this is limited today):
1. Log in to WMS, open a page with a bulk DataTables endpoint.
2. App → Import → copy the snippet → Console (type `allow pasting` first) → run → JSON downloads → import.

Both paths: snapshot (GetDashboardStats) + rows are stored, **deduped**, shift-assigned. Then review
**Operators / Dashboard / Validation**.

## 11. Known limitations
- No automatic/scheduled sync from the offline app (see §1).
- ProductLogsData must be queried with a **tight date range** (large ranges time out on the server).
- LogType meanings are user-mapped, not inferred.
- Operator "hours" = span between first and last event, not measured active time.
