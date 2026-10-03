# Problem / Bottleneck Register

The "Bottleneck Register" module (Diagnose menu) identifies, quantifies and tracks warehouse problems and bottlenecks until they are closed with a measured effect.

## How a number gets into the register

1. **Queries** (`queries.sql`): blocks D1–D13 (plus D1o), each a single read-only `SELECT` on the WMS database with a `/*bn:Dx*/` marker.
   - Parameters are literals followed by their name in a comment, e.g. `35/*nd*/` or `'17:30'/*co*/`, so the file runs as it is.
   - The agent writes `queries.run.sql` with the values from **Settings**.
2. **Run**: the scheduled task `wms-pulse-refresh` runs them through the WMS connector at **07, 13 and 18** (and you can ask Claude for a run on request).
   - The app has no direct SQL connection and no credentials.
3. **Snapshot** (`adapter.js`): the agent finds the results in the Claude Code transcripts and stores them in `snapshots/<id>.json`.
   - Each block is stored with the run time, **the exact SQL that ran**, the scope (warehouse, platform, period, cut-off) and the result row.
   - Without the connector, results can be imported as JSON/CSV with the same schema (tab "Të dhënat & query-t").
4. **Detectors** (`detectors.js`): snapshot + thresholds → metrics, **candidates** and the system **constraint**.
   - "Current" = the last 7 full days.
   - "Baseline" = the 4 weeks before that.
   - Today is never counted, because it is incomplete.
5. **Register**: a candidate becomes a problem only through *Prano* or *Shkrij*. *Hidh poshtë* requires a reason, and the candidate returns only if its value worsens by ≥ 20%.
   - Each evidence item keeps its snapshot, so the card's "query ↗" link shows the SQL, the period and the scope that produced the number.

**Reproduction:** run the same SQL from the snapshot (read-only) on the WMS database. With the same parameters it gives the same numbers for the same period. Data from today changes until the day ends.

## Problem age limit (30 calendar days)

Only WMS events from **the last 30 calendar days** become candidates. This is the `ma` parameter, "Mosha maksimale e problemit", in Settings.

- Lists of open items include only items from the last 30 days: units waiting for mapping, Started supplies, international shipments without an arrival, orders without a check-out, inspections, zones with missing items, and units on overloaded rows (mapped in the last 30 days).
- Older backlog is only counted, and appears as a note in "Të dhënat & query-t". It never becomes a problem: e.g. 1,076 supplies Started for more than 30 days, sources stopped since 2022/2024/2025.
- General rule: a candidate whose evidence period ended before the limit is dropped and noted.
- The 4-week baseline (days 8–35) is still used **only as a reference** for comparison.
- Problems already accepted into the register are not affected by the limit; they follow their own status.

## Rules the queries follow

The automated check passes for all blocks: 14 blocks and 20 references to ProductLogs.

- `SELECT` only, no CTEs (derived tables instead), `TOP` instead of `LIMIT`.
- Results are aggregated on the server, one row per block (lists as `FOR JSON`).
- `ProductLogs`: always `WITH (NOLOCK)` plus a filter on `InsertDateTime`.
- Users are joined on `Users.UserId` (never `Users.Id`).
- Orders are joined on `(OrderId, PlatformId)`.
  - **Documented exception:** LogType 3 rows, `ProductCheckIns` and `OrderRowMapping` have no platform (`PlatformId = 0` or no column). For those, the order is matched on `(unit, OrderId)`.
  - This is safe only because **no OrderId exists on both platforms**. D7 checks this on every run (`dupIds`); if it is ever > 0, D7 raises a severity-5 data candidate.
- `Orders.CreatedOnUtc` is converted to local time **per row** with `AT TIME ZONE 'Central European Standard Time'`, which handles daylight saving time correctly. `InsertDateTime` is already local time.
- Never read: `Country.ApiValue`, `ExternalPlatformTokens`, `Settings.Value`, hashes, `DeliveryLogs`.
- LogTypeId values:
  - 2, 7 and 4/18 are confirmed.
  - 3, 6, 9 and 27 are inferred, and labelled **E PAKONFIRMUAR** (unconfirmed).
  - All others are shown as numbers only.
- WmsStatusId is shown as a number. Only 23/25/26/37 have a hint, because the final statuses are unconfirmed.

## Detectors

| | Metric | Current definition |
|---|---|---|
| D1 | Carryover | Orders **ready in the warehouse by the cut-off** (created, or with the last unit reserved, LogType 3) that leave the next day or later, plus orders that are complete and still not out (D1o). Orders waiting for the seller are shown separately and are not counted. |
| D2 | Order → first check-out | Median, p90 and p95, per week, day of week and hour of creation. |
| D3 | Flow per hour | Heatmap of phase × hour. Capacity demonstrated (p90 per hour). Utilisation 09–17. WIP. The highest utilisation = the constraint (a hypothesis). |
| D4 | Mapping | Units with status 2/6 by age. Check-in → map time (median, p90). |
| D5 | Picking | PickSession sessions. Interval between scans compared with the WMS standard (CheckIn 33.2 s, Map 18.6 s, Picking 79.7 s, CheckoutShipping 86.1 s). |
| D6 | Productivity | Weighted ops = 1.0×co + 0.8×ci + 0.6×map per active day. Bands. Drop ≥ 15%. Gaps > 15 min after the break. **Team level first** (starvation, equipment, location); people shown as initials + the last 3 digits of the WMS id. |
| D7 | Data quality | Temp accounts, scans with no user, check-out with PlatformId 0, unconfirmed LogTypes, OrderId on both platforms, orders with scan 27 but no 4/18. |
| D8 | Inbound | Supplies still "Started" by age. Opening → first check-in. |
| D9 | Inventory accuracy | When each source last received a row (a stopped source is reported as such). Missing items in the last full inspection. |
| D10 | Space / location | Parked orders (if still recorded). Overloaded rows (× median). Zones with the most missing items. |
| D11 | Transport | **Local** (`Shipments.SupplierType` 10, e.g. Beki — last week against the 4 before) and **international** (SupplierType 20: Poland, Czechia, Romania, Hungary… — last 30 days against the 90 before) kept apart: stops arriving after the expected date (compared by date), per carrier, with pickup → arrival days. Plus: international stops with no recorded arrival more than 2 days after the expected date (with the number of linked invoices), and the data gaps — pallet count (0 since August 2026) and transport price (e.g. CargoPartner – Apcom). 10 = local / 20 = international is inferred from the origin names (UNCONFIRMED). |
| D12 | Order age | By WmsStatusId (0–4 h, 4–8 h, 8–24 h, 1–3 days, > 3 days), split by whether the order has been checked out. |
| D13 | Cost per order | Σ Cost (already `CalculatedPrice × Quantity`) ÷ orders checked out in the same window. Compared only within the same PricingVersionId. |

## Priority and closing

- **Priority:**
  - RPN = Ashpërsia × Shpeshtësia × Zbulueshmëria (each 1–5).
  - P1 / P2 / P3 by the thresholds in Settings (64 / 27).
  - The **Siguri** category is always P1.
- **Status flow:** I hapur → Në analizë → Në veprim (requires an owner) → Në verifikim → I mbyllur / I rihapur.
- **Closing:**
  - "I mbyllur" is allowed only when the problem's metric has stayed on target for **≥ 14 days** after the action started (2 consecutive weeks for weekly metrics).
  - It must be measured with the same query, from the snapshots.
  - Single-value metrics (e.g. units waiting) keep a day-by-day history in `metric-history.json`.
- **Backward compatibility:** each record also keeps the earlier fields (`problem`, `severity`, `priorityScore`, `status`, `processId`, `cause`, `evidence`, `impact`), so the Dashboard, reports, Validation and Search keep working.

## Local files (git-ignored)

`snapshots/`, `queries.run.sql` and `metric-history.json` contain operational data and staff initials, so they stay on this computer only.
