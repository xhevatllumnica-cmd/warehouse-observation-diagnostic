# WMS queries — "Statistikat e WH"

Every WMS-derived statistic of the module is defined in `wms-stats.js` (agent side). This file documents each
one: purpose, definition, scope and limits. Phase 2 SQL queries (Gjirafa50 MCP connector) will be added here.

## Phase 1 source: WMS ProductLogs (live)

Read by the agent through the WMS web session (`/Warehouse/ProductLogsData`, all rows per calendar day, de-duplicated
by the WMS row `Id` — see `fetchDayProductLogs` in `wms-agent.js`). Equivalent SQL, for cross-checks:

```sql
SELECT ... FROM ProductLogs pl WITH (NOLOCK)
WHERE pl.InsertDateTime >= @dayStart AND pl.InsertDateTime < @dayEnd
```

**Scope.** Verified 2026-09-28 against SQL (orders joined to `Orders.WarehouseId = 1`): checked-out orders per day
match — 493 = 493 (22.09), 533 = 533 (23.09), 587 / 586 (24.09), 726 / 725 (25.09), 547 / 544 (26.09). Reported as
**Depo Prishtinë (WH 1)**.

**Limits.**
- The web rows carry `PlatformId = 0` on every row → no GjirafaMall / Gjirafa50 split, and orders are keyed on
  `OrderId` alone (rare cross-platform collisions). Platform filter comes in phase 2.
- WMS appends backdated events to a day for ~3 days; days younger than that are always re-read, older days are
  cached (memory + `stats-day-cache.json`).
- Timestamps are server local time (Kosovo).

### Statistics

| Id | Statistic | Definition | Notes |
|---|---|---|---|
| 5.1a | Checked-out orders per day | distinct `OrderId` with a `LogTypeId` 4 or 18 event that day | WMS's own check-out definition (`PerformanceOperationTypes`) |
| 5.1b | Checked-out units per day | count of `LogTypeId` 4/18 rows | one row = one physical unit |
| 5.1c | Orders per workday (KPI) | mean of 5.1a over complete Mon–Fri days in the period (today excluded) | compared with the previous period of equal length |
| 5.1d | Throughput by hour | 5.1a by hour of the order's first check-out that day, and units by hour, averaged per day | |
| 5.1e | Heatmap hour × weekday | 5.1a counts summed over the period per weekday × hour | |
| 5.3a | Check-in → map | minutes from a unit's check-in (2) to its first map (7), median and p90 | same physical unit (`ProductItemUniqueIdentifierId`) |
| 5.3b | Units not yet mapped | units checked in during the period with no map (7) and no outbound step (3, 4, 9, 18, 27) since; aged <2h / 2–8h / 8–24h / >24h | units that went straight to an order are not counted as waiting |
| 5.4a | Operations per worker | check-in (2), map (7), check-out (4/18) by `UpdatedByName`, warehouse staff roster only | roster: Flow (2h) → Stafi i depos; two accounts of one person merged |
| 5.4b | Weighted ops / active day | (1.0 × check-out + 0.8 × check-in + 0.6 × map) ÷ days with activity | weights from `PerformanceOperationTypes` |
| 5.4c | Bands | above > mean × 1.25, below < mean × 0.75, spike > mean + 2 SD, declining ≤ −15 % vs previous period | from `PerformanceSettings` |
| 5.4d | Productivity by hour | team weighted ops per hour, averaged per day | |

**Periods.** The last 7 / 14 / 30 days ending today, compared with the previous period of equal length; or one
chosen day (`?date=YYYY-MM-DD`), compared with the day before — a single day counts as itself even on a weekend
or while still in progress. For a period that ends before today, up to 14 later days are also read so 5.3a/5.3b
see mappings and shipments that happened after the period (otherwise a Saturday's check-ins, mapped on Monday,
would look unmapped).

**Shift filter.** Keeps events inside the shift's hours on the shift's kind of day (workday vs weekend), shifts from
WMS Data & Performance → Shifts. N1 07–15 and N2 13–21 overlap, so 13:00–15:00 counts in both.

## Phase 2 (pending): SQL through the Gjirafa50 MCP connector

Same-day shipping (cut-off in module settings, default 17:30), daily carryover, backlog by `WmsStatusId` and age,
order → first check-out (median / p90), orders created by hour and platform, PickSession, cost per order
(`WarehouseActionPayments`), inbound (`Supplies`), stock accuracy (`Inspects`, `InspectMissingProducts`,
`StockDifferences`), stations (`PickSession.StationId` only — `ProductLogs` has no station), shipments on time.
Needs an OAuth client for the agent registered on `login.gjirafa.com` (device code + `offline_access`).
