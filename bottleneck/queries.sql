-- Problem / Bottleneck Register — WmsDataAdapter queries (detectors D1–D13), Gjirafa WMS (SQL Server, read-only).
-- Each block "-- @Dx …" is ONE SELECT that starts with the marker /*bn:Dx*/ and returns one row (lists as FOR JSON).
-- Parameters are literals followed by their name in a comment, e.g. 35/*nd*/ or '17:30'/*co*/: the file runs as it is
-- (defaults below) and bottleneck/adapter.js writes bottleneck/queries.run.sql with the values from the module's Settings.
--   wh  warehouse (1 = Prishtinë)        pf  platform (0 = both, 1 = GjirafaMall, 2 = Gjirafa50)
--   nd  days of history (35 = last 7 days + a 4-week baseline)   nd7  nd + 7 (look-back for orders checked out late)
--   co  cut-off (no inbound after it)     mh  hours before a checked-in unit counts as waiting for mapping
--   sh  hours before a started supply counts as stuck               gm  minutes of inactivity that count as a gap
--   ma  maximum age of a problem in calendar days (30): lists of open items (units, supplies, shipments, orders,
--       inspections, errors) only include events of the last ma days; older backlog is counted apart, never listed
-- Rules (gjirafa-wms-data-analyst): no CTEs; ProductLogs always filtered on InsertDateTime and read WITH (NOLOCK);
-- users joined on Users.UserId; orders on (OrderId, PlatformId). Exception, documented: LogType 3 rows and
-- ProductCheckIns carry PlatformId 0, so a reserved unit is matched to its order on (unit, OrderId) — safe only because
-- no OrderId exists on both platforms (checked on every run in D7.dupIds). Orders.CreatedOnUtc is UTC: converted per
-- row with AT TIME ZONE 'Central European Standard Time' (DST-correct); InsertDateTime is already local.
-- Never selected: Country.ApiValue, ExternalPlatformTokens, Settings.Value, hashes; DeliveryLogs not used.
-- LogTypeId: 2 check-in, 7 map, 4/18 check-out (confirmed); 3, 6, 9, 27 inferred; others shown as numbers.

-- @D1 carryover — orders READY in the warehouse by the cut-off (created, or the last unit reserved for it = LogType 3,
--    matched per unit) and first checked out (4/18) on a later day. Per ready day × platform × creation hour.
SELECT /*bn:D1*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CONVERT(varchar(10),rd,23) d, pf, ch h, COUNT(*) rb, SUM(CASE WHEN cod=rd THEN 1 ELSE 0 END) same, SUM(CASE WHEN cod>rd THEN 1 ELSE 0 END) carry,
    SUM(CASE WHEN cod>rd AND xd=1 THEN 1 ELSE 0 END) carryXd
  FROM (SELECT CAST(r AS date) rd, pf, ch, CAST(c1 AS date) cod, xd FROM (
     SELECT k.PlatformId pf, k.c1, DATEPART(hour,t.cr) ch, CASE WHEN a.l3 IS NOT NULL THEN 1 ELSE 0 END xd, CASE WHEN a.l3>t.cr THEN a.l3 ELSE t.cr END r
     FROM (SELECT OrderId, PlatformId, MIN(InsertDateTime) c1 FROM ProductLogs WITH (NOLOCK)
           WHERE LogTypeId IN (4,18) AND OrderId>0 AND PlatformId IN (1,2) AND InsertDateTime>=DATEADD(day,-42/*nd7*/,CAST(GETDATE() AS date)) GROUP BY OrderId, PlatformId) k
     JOIN Orders o ON o.OrderId=k.OrderId AND o.PlatformId=k.PlatformId AND o.WarehouseId=1/*wh*/ AND (0/*pf*/=0 OR o.PlatformId=0/*pf*/)
     CROSS APPLY (SELECT CAST(o.CreatedOnUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Central European Standard Time' AS datetime) cr) t
     LEFT JOIN (SELECT k2.OrderId, k2.PlatformId, MAX(x3.InsertDateTime) l3 FROM
          (SELECT DISTINCT OrderId, PlatformId, ProductItemUniqueIdentifierId uid FROM ProductLogs WITH (NOLOCK)
           WHERE LogTypeId IN (4,18) AND OrderId>0 AND PlatformId IN (1,2) AND InsertDateTime>=DATEADD(day,-42/*nd7*/,CAST(GETDATE() AS date))) k2
          JOIN ProductLogs x3 WITH (NOLOCK) ON x3.ProductItemUniqueIdentifierId=k2.uid AND x3.LogTypeId=3 AND x3.OrderId=k2.OrderId AND x3.InsertDateTime>=DATEADD(day,-120,GETDATE())
          GROUP BY k2.OrderId, k2.PlatformId) a ON a.OrderId=k.OrderId AND a.PlatformId=k.PlatformId) x
   WHERE c1>=r AND CAST(r AS time)<=CAST('17:30'/*co*/ AS time) AND r>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND r<CAST(GETDATE() AS date)) y
  GROUP BY rd, pf, ch ORDER BY rd, pf, ch FOR JSON PATH) cell

-- @D1o carryover still open — orders with units reserved (ProductCheckIns status 3) and no check-out yet. Complete = all
--    ordered units reserved (OrderDetails, available since 17.08); ready ≤ cut-off on an earlier day = open carryover.
--    Partial = still waiting for units (local seller / inbound) — shown apart, not counted as warehouse carryover.
SELECT /*bn:D1o*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CONVERT(varchar(10),CAST(r AS date),23) d, pf, SUM(CASE WHEN cmp=1 AND CAST(r AS time)<=CAST('17:30'/*co*/ AS time) THEN 1 ELSE 0 END) openReady,
    SUM(CASE WHEN cmp=1 AND CAST(r AS time)>CAST('17:30'/*co*/ AS time) THEN 1 ELSE 0 END) afterCo, SUM(CASE WHEN cmp=0 THEN 1 ELSE 0 END) partial, COUNT(*) n
  FROM (SELECT o.PlatformId pf, CASE WHEN w.l>t.cr THEN w.l ELSE t.cr END r, CASE WHEN dq.q IS NOT NULL AND w.u>=dq.q THEN 1 ELSE 0 END cmp
     FROM (SELECT c.OrderId, COUNT(*) u, MAX(lp.t3) l FROM ProductCheckIns c
           OUTER APPLY (SELECT TOP 1 x.InsertDateTime t3 FROM ProductLogs x WITH (NOLOCK) WHERE x.ProductItemUniqueIdentifierId=c.ProductItemUniqueIdentifier AND x.LogTypeId=3 AND x.OrderId=c.OrderId AND x.InsertDateTime>=DATEADD(day,-120,GETDATE()) ORDER BY x.Id DESC) lp
           WHERE c.WarehouseId=1/*wh*/ AND c.StatusId=3 AND c.OrderId>0 GROUP BY c.OrderId) w
     CROSS APPLY (SELECT TOP 1 o0.PlatformId, o0.CreatedOnUtc FROM Orders o0 WHERE o0.OrderId=w.OrderId AND o0.WarehouseId=1/*wh*/ ORDER BY o0.CreatedOnUtc DESC) o
     CROSS APPLY (SELECT CAST(o.CreatedOnUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Central European Standard Time' AS datetime) cr) t
     OUTER APPLY (SELECT SUM(d.Quantity) q FROM OrderDetails d WHERE d.OrderId=w.OrderId AND d.PlatformId=o.PlatformId) dq
     WHERE (0/*pf*/=0 OR o.PlatformId=0/*pf*/)
       AND NOT EXISTS (SELECT 1 FROM ProductLogs y WITH (NOLOCK) WHERE y.OrderId=w.OrderId AND y.PlatformId=o.PlatformId AND y.LogTypeId IN (4,18) AND y.InsertDateTime>=DATEADD(day,-120,GETDATE()))) z
  WHERE r>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND r<CAST(GETDATE() AS date)
  GROUP BY CAST(r AS date), pf ORDER BY 1,2 FOR JSON PATH) openDaily

-- @D2 lead time order → first check-out (4/18), hours, orders checked out in the window: per ISO week (trend/baseline),
--    per weekday of creation and per hour of creation — n, median, p90, p95 (long tail: never the mean alone).
SELECT /*bn:D2*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT wk, MIN(CONVERT(varchar(10),cd,23)) d1, COUNT(*) n, ROUND(MAX(p50),2) p50, ROUND(MAX(p90),2) p90, ROUND(MAX(p95),2) p95 FROM (
    SELECT DATEPART(iso_week,c1) wk, CAST(c1 AS date) cd,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY DATEPART(iso_week,c1)) p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY DATEPART(iso_week,c1)) p90,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY DATEPART(iso_week,c1)) p95
    FROM (SELECT k.c1, DATEDIFF(minute,t.cr,k.c1)/60.0 h FROM
       (SELECT OrderId, PlatformId, MIN(InsertDateTime) c1 FROM ProductLogs WITH (NOLOCK) WHERE LogTypeId IN (4,18) AND OrderId>0 AND PlatformId IN (1,2)
          AND InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND InsertDateTime<CAST(GETDATE() AS date) GROUP BY OrderId, PlatformId) k
       JOIN Orders o ON o.OrderId=k.OrderId AND o.PlatformId=k.PlatformId AND o.WarehouseId=1/*wh*/ AND (0/*pf*/=0 OR o.PlatformId=0/*pf*/)
       CROSS APPLY (SELECT CAST(o.CreatedOnUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Central European Standard Time' AS datetime) cr) t) b WHERE h>=0) x
  GROUP BY wk ORDER BY MIN(cd) FOR JSON PATH) week,
 (SELECT dw, COUNT(*) n, ROUND(MAX(p50),2) p50, ROUND(MAX(p90),2) p90, ROUND(MAX(p95),2) p95 FROM (
    SELECT (DATEPART(weekday,cr)+@@DATEFIRST-2)%7+1 dw,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY (DATEPART(weekday,cr)+@@DATEFIRST-2)%7) p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY (DATEPART(weekday,cr)+@@DATEFIRST-2)%7) p90,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY (DATEPART(weekday,cr)+@@DATEFIRST-2)%7) p95
    FROM (SELECT t.cr, DATEDIFF(minute,t.cr,k.c1)/60.0 h FROM
       (SELECT OrderId, PlatformId, MIN(InsertDateTime) c1 FROM ProductLogs WITH (NOLOCK) WHERE LogTypeId IN (4,18) AND OrderId>0 AND PlatformId IN (1,2)
          AND InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND InsertDateTime<CAST(GETDATE() AS date) GROUP BY OrderId, PlatformId) k
       JOIN Orders o ON o.OrderId=k.OrderId AND o.PlatformId=k.PlatformId AND o.WarehouseId=1/*wh*/ AND (0/*pf*/=0 OR o.PlatformId=0/*pf*/)
       CROSS APPLY (SELECT CAST(o.CreatedOnUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Central European Standard Time' AS datetime) cr) t) b WHERE h>=0) x
  GROUP BY dw ORDER BY dw FOR JSON PATH) dow,
 (SELECT hr, COUNT(*) n, ROUND(MAX(p50),2) p50, ROUND(MAX(p90),2) p90, ROUND(MAX(p95),2) p95 FROM (
    SELECT DATEPART(hour,cr) hr,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY DATEPART(hour,cr)) p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY DATEPART(hour,cr)) p90,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY DATEPART(hour,cr)) p95
    FROM (SELECT t.cr, DATEDIFF(minute,t.cr,k.c1)/60.0 h FROM
       (SELECT OrderId, PlatformId, MIN(InsertDateTime) c1 FROM ProductLogs WITH (NOLOCK) WHERE LogTypeId IN (4,18) AND OrderId>0 AND PlatformId IN (1,2)
          AND InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND InsertDateTime<CAST(GETDATE() AS date) GROUP BY OrderId, PlatformId) k
       JOIN Orders o ON o.OrderId=k.OrderId AND o.PlatformId=k.PlatformId AND o.WarehouseId=1/*wh*/ AND (0/*pf*/=0 OR o.PlatformId=0/*pf*/)
       CROSS APPLY (SELECT CAST(o.CreatedOnUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Central European Standard Time' AS datetime) cr) t) b WHERE h>=0) x
  GROUP BY hr ORDER BY hr FOR JSON PATH) hour

-- @D3 flow per hour (Theory of Constraints): per day × hour — orders created (in), orders picked (PickSessionOrder),
--    orders checked out (distinct (OrderId, PlatformId) with 4/18), units checked in (2), units mapped (7), and the
--    distinct warehouse-01 staff accounts per process in that hour.
SELECT /*bn:D3*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CONVERT(varchar(10),d,23) d, h, SUM(cr) cr, SUM(pk) pk, SUM(co) co, SUM(ci) ci, SUM(mp) mp, SUM(coOps) coOps, SUM(ciOps) ciOps, SUM(mpOps) mpOps FROM (
    SELECT CAST(t.cr AS date) d, DATEPART(hour,t.cr) h, COUNT(*) cr, 0 pk, 0 co, 0 ci, 0 mp, 0 coOps, 0 ciOps, 0 mpOps
      FROM Orders o CROSS APPLY (SELECT CAST(o.CreatedOnUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Central European Standard Time' AS datetime) cr) t
      WHERE o.WarehouseId=1/*wh*/ AND (0/*pf*/=0 OR o.PlatformId=0/*pf*/) AND o.CreatedOnUtc>=DATEADD(day,-36/*nd+1*/,CAST(GETUTCDATE() AS date))
      GROUP BY CAST(t.cr AS date), DATEPART(hour,t.cr)
    UNION ALL
    SELECT CAST(so.InsertDateTime AS date), DATEPART(hour,so.InsertDateTime), 0, COUNT(DISTINCT CONCAT(so.OrderId,'-',so.Platform)), 0, 0, 0, 0, 0, 0
      FROM PickSessionOrder so JOIN Orders o ON o.OrderId=so.OrderId AND o.PlatformId=so.Platform AND o.WarehouseId=1/*wh*/ AND (0/*pf*/=0 OR o.PlatformId=0/*pf*/)
      WHERE so.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) GROUP BY CAST(so.InsertDateTime AS date), DATEPART(hour,so.InsertDateTime)
    UNION ALL
    SELECT CAST(pl.InsertDateTime AS date), DATEPART(hour,pl.InsertDateTime), 0, 0, COUNT(DISTINCT CONCAT(pl.OrderId,'-',pl.PlatformId)), 0, 0, COUNT(DISTINCT pl.UpdateBy), 0, 0
      FROM ProductLogs pl WITH (NOLOCK) JOIN Orders o ON o.OrderId=pl.OrderId AND o.PlatformId=pl.PlatformId AND o.WarehouseId=1/*wh*/ AND (0/*pf*/=0 OR o.PlatformId=0/*pf*/)
      WHERE pl.LogTypeId IN (4,18) AND pl.OrderId>0 AND pl.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) GROUP BY CAST(pl.InsertDateTime AS date), DATEPART(hour,pl.InsertDateTime)
    UNION ALL
    SELECT CAST(pl.InsertDateTime AS date), DATEPART(hour,pl.InsertDateTime), 0, 0, 0, SUM(CASE WHEN pl.LogTypeId=2 THEN 1 ELSE 0 END), SUM(CASE WHEN pl.LogTypeId=7 THEN 1 ELSE 0 END),
        0, COUNT(DISTINCT CASE WHEN pl.LogTypeId=2 THEN pl.UpdateBy END), COUNT(DISTINCT CASE WHEN pl.LogTypeId=7 THEN pl.UpdateBy END)
      FROM ProductLogs pl WITH (NOLOCK) JOIN Users u ON u.UserId=pl.UpdateBy
      WHERE pl.LogTypeId IN (2,7) AND pl.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND u.UserWarehouseId=1/*wh*/ AND u.UserId>0
        AND (u.Username LIKE '%@gjirafa.com' OR u.Username NOT LIKE '%@%')
      GROUP BY CAST(pl.InsertDateTime AS date), DATEPART(hour,pl.InsertDateTime)) a
  WHERE d>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date))
  GROUP BY d, h ORDER BY d, h FOR JSON PATH) cell

-- @D4 units waiting for mapping — warehouse-01 units now in status 2 (checked in) or 6 (inferred: before mapping) by age
--    since their last log; and the check-in → first map time (2→7) per day: n, median, p90 (minutes).
SELECT /*bn:D4*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT c.StatusId s, SUM(CASE WHEN a<240 THEN 1 ELSE 0 END) b0_4, SUM(CASE WHEN a>=240 AND a<480 THEN 1 ELSE 0 END) b4_8,
    SUM(CASE WHEN a>=480 AND a<1440 THEN 1 ELSE 0 END) b8_24, SUM(CASE WHEN a>=1440 AND a<4320 THEN 1 ELSE 0 END) b1_3d, SUM(CASE WHEN a>=4320 THEN 1 ELSE 0 END) b3d,
    SUM(CASE WHEN a>=4/*mh*/*60 THEN 1 ELSE 0 END) overX, COUNT(*) n
  FROM ProductCheckIns c CROSS APPLY (SELECT DATEDIFF(minute, ISNULL(c.UpdateDateTime,c.InsertDateTime), GETDATE()) a) t
  WHERE c.WarehouseId=1/*wh*/ AND c.StatusId IN (2,6) AND c.InsertDateTime>=DATEADD(day,-30/*ma*/,GETDATE()) GROUP BY c.StatusId FOR JSON PATH) waiting,
 (SELECT COUNT(*) FROM ProductCheckIns c WHERE c.WarehouseId=1/*wh*/ AND c.StatusId IN (2,6) AND c.InsertDateTime>=DATEADD(day,-365,GETDATE()) AND c.InsertDateTime<DATEADD(day,-30/*ma*/,GETDATE())) older,
 (SELECT TOP 15 c.ProductCode pc, c.StatusId s, c.SupplyUniqueId sup, DATEDIFF(minute, ISNULL(c.UpdateDateTime,c.InsertDateTime), GETDATE()) a FROM ProductCheckIns c
  WHERE c.WarehouseId=1/*wh*/ AND c.StatusId IN (2,6) AND c.InsertDateTime>=DATEADD(day,-30/*ma*/,GETDATE()) ORDER BY ISNULL(c.UpdateDateTime,c.InsertDateTime) FOR JSON PATH) oldest,
 (SELECT CONVERT(varchar(10),d,23) d, COUNT(*) n, MAX(p50) p50, MAX(p90) p90 FROM (
    SELECT CAST(f2 AS date) d, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m) OVER (PARTITION BY CAST(f2 AS date)) p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY m) OVER (PARTITION BY CAST(f2 AS date)) p90 FROM (
      SELECT MIN(CASE WHEN pl.LogTypeId=2 THEN pl.InsertDateTime END) f2, DATEDIFF(minute, MIN(CASE WHEN pl.LogTypeId=2 THEN pl.InsertDateTime END), MIN(CASE WHEN pl.LogTypeId=7 THEN pl.InsertDateTime END)) m
      FROM ProductLogs pl WITH (NOLOCK) JOIN ProductCheckIns c ON c.ProductItemUniqueIdentifier=pl.ProductItemUniqueIdentifierId AND c.WarehouseId=1/*wh*/
      WHERE pl.LogTypeId IN (2,7) AND pl.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) GROUP BY pl.ProductItemUniqueIdentifierId) x
    WHERE f2 IS NOT NULL AND m>=0) y GROUP BY d ORDER BY d FOR JSON PATH) dwell

-- @D5 picking & cycle times — PickSession (since 10.08.2026): sessions per day, duration, orders and items per session;
--    and the actual seconds per action from consecutive scans of the same account (gap 3 s – 10 min), per action type,
--    to compare with the WMS standard times (CheckIn 33.2 s, Map 18.6 s, Picking 79.7 s, CheckoutShipping 86.1 s).
SELECT /*bn:D5*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CONVERT(varchar(10),CAST(ps.InsertDateTime AS date),23) d, COUNT(*) s, SUM(CASE WHEN ps.Status=2 THEN 1 ELSE 0 END) done,
    AVG(CASE WHEN ps.Status=2 THEN DATEDIFF(second, ps.InsertDateTime, ps.UpdateDateTime) END) avgSec, SUM(ISNULL(o.n,0)) ord, SUM(ISNULL(i.sc,0)) sc, SUM(ISNULL(i.rq,0)) rq
  FROM PickSession ps JOIN Stations st ON st.Id=ps.StationId AND st.Name<>'test' AND st.WarehouseId=1/*wh*/
    LEFT JOIN (SELECT PickSessionId, COUNT(*) n FROM PickSessionOrder GROUP BY PickSessionId) o ON o.PickSessionId=ps.Id
    LEFT JOIN (SELECT PickSessionId, SUM(ScannedQuantity) sc, SUM(RequiredQuantity) rq FROM PickSessionItem GROUP BY PickSessionId) i ON i.PickSessionId=ps.Id
  WHERE ps.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) GROUP BY CAST(ps.InsertDateTime AS date) ORDER BY 1 FOR JSON PATH) sessions,
 (SELECT t, wk, COUNT(*) n, MAX(p50) p50, MAX(p90) p90 FROM (
    SELECT t, DATEPART(iso_week,ts) wk, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY g) OVER (PARTITION BY t, DATEPART(iso_week,ts)) p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY g) OVER (PARTITION BY t, DATEPART(iso_week,ts)) p90 FROM (
      SELECT t, ts, DATEDIFF(second, LAG(ts) OVER (PARTITION BY ub, t ORDER BY ts), ts) g FROM (
        SELECT pl.UpdateBy ub, CASE WHEN pl.LogTypeId IN (4,18) THEN 4 ELSE pl.LogTypeId END t, pl.InsertDateTime ts
        FROM ProductLogs pl WITH (NOLOCK) JOIN Users u ON u.UserId=pl.UpdateBy
        WHERE pl.LogTypeId IN (2,7,4,18) AND pl.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND u.UserWarehouseId=1/*wh*/ AND u.UserId>0
          AND (u.Username LIKE '%@gjirafa.com' OR u.Username NOT LIKE '%@%')) a) b
    WHERE g BETWEEN 3 AND 600) c GROUP BY t, wk ORDER BY t, wk FOR JSON PATH) cycle,
 (SELECT Code c, AverageTimeSeconds s FROM WarehouseActions FOR JSON PATH) std

-- @D6 productivity per warehouse-01 staff account and day — check-in/map/check-out units, weighted ops
--    (1.0×co + 0.8×ci + 0.6×map), first/last scan, active clock hours, gaps longer than gm minutes between consecutive
--    scans (count, minutes). Shown in the app as initials + last 3 digits of UserId; temp (shared) accounts flagged;
--    Active=0 flagged but kept (history must not disappear).
SELECT /*bn:D6*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT LEFT(ISNULL(u.FirstName,'?'),1)+'.'+LEFT(ISNULL(u.LastName,'?'),1)+'.' i, RIGHT(CAST(u.UserId AS varchar(12)),3) id,
    CASE WHEN u.Username LIKE 'temp%' THEN 1 ELSE 0 END tmp, CAST(u.Active AS int) act, CONVERT(varchar(10),x.d,23) d,
    x.ci, x.mp, x.co, ROUND(x.co*1.0+x.ci*0.8+x.mp*0.6,1) w, CONVERT(varchar(5),x.f,108) f, CONVERT(varchar(5),x.l,108) l, x.hrs, x.gaps, x.gapMin
  FROM (SELECT ub, d, SUM(CASE WHEN t=2 THEN 1 ELSE 0 END) ci, SUM(CASE WHEN t=7 THEN 1 ELSE 0 END) mp, SUM(CASE WHEN t=4 THEN 1 ELSE 0 END) co,
          MIN(ts) f, MAX(ts) l, COUNT(DISTINCT DATEPART(hour,ts)) hrs,
          SUM(CASE WHEN g>15/*gm*/*60 THEN 1 ELSE 0 END) gaps, SUM(CASE WHEN g>15/*gm*/*60 THEN g ELSE 0 END)/60 gapMin
        FROM (SELECT pl.UpdateBy ub, CAST(pl.InsertDateTime AS date) d, pl.InsertDateTime ts, CASE WHEN pl.LogTypeId IN (4,18) THEN 4 ELSE pl.LogTypeId END t,
                DATEDIFF(second, LAG(pl.InsertDateTime) OVER (PARTITION BY pl.UpdateBy, CAST(pl.InsertDateTime AS date) ORDER BY pl.InsertDateTime), pl.InsertDateTime) g
              FROM ProductLogs pl WITH (NOLOCK) WHERE pl.LogTypeId IN (2,7,4,18) AND pl.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date))) a
        GROUP BY ub, d) x
  JOIN Users u ON u.UserId=x.ub
  WHERE u.UserWarehouseId=1/*wh*/ AND u.UserId>0 AND (u.Username LIKE '%@gjirafa.com' OR u.Username NOT LIKE '%@%') AND x.ci+x.mp+x.co>=20
  ORDER BY u.UserId, x.d FOR JSON PATH) cell

-- @D7 data quality — shared (temp) accounts' share of scans, check-outs with PlatformId 0, scans without a known user,
--    log types outside the confirmed/inferred list (numbers only), OrderIds present on both platforms (must be 0 for
--    the per-unit matching above), and orders checked out with 27 but never with 4/18.
SELECT /*bn:D7*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CONVERT(varchar(10),CAST(pl.InsertDateTime AS date),23) d, COUNT(*) n,
    SUM(CASE WHEN u.Username LIKE 'temp%' THEN 1 ELSE 0 END) tmp, SUM(CASE WHEN u.UserId IS NULL THEN 1 ELSE 0 END) noUser,
    SUM(CASE WHEN pl.LogTypeId IN (4,18) AND pl.PlatformId=0 THEN 1 ELSE 0 END) co0, SUM(CASE WHEN pl.LogTypeId IN (4,18) THEN 1 ELSE 0 END) co
  FROM ProductLogs pl WITH (NOLOCK) LEFT JOIN Users u ON u.UserId=pl.UpdateBy
  WHERE pl.LogTypeId IN (2,7,4,18) AND pl.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date))
  GROUP BY CAST(pl.InsertDateTime AS date) ORDER BY 1 FOR JSON PATH) daily,
 (SELECT LogTypeId t, COUNT(*) n FROM ProductLogs WITH (NOLOCK) WHERE InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) GROUP BY LogTypeId ORDER BY n DESC FOR JSON PATH) types,
 (SELECT COUNT(*) FROM (SELECT OrderId FROM Orders WHERE CreatedOnUtc>=DATEADD(day,-120,GETUTCDATE()) GROUP BY OrderId HAVING COUNT(DISTINCT PlatformId)>1) q) dupIds,
 (SELECT COUNT(*) FROM (SELECT OrderId, PlatformId FROM ProductLogs WITH (NOLOCK) WHERE LogTypeId IN (27,4,18) AND OrderId>0 AND InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date))
    GROUP BY OrderId, PlatformId HAVING SUM(CASE WHEN LogTypeId IN (4,18) THEN 1 ELSE 0 END)=0) q) only27,
 (SELECT LEFT(ISNULL(u.FirstName,'?'),1)+'.'+LEFT(ISNULL(u.LastName,'?'),1)+'.' i, RIGHT(CAST(u.UserId AS varchar(12)),3) id, COUNT(*) n, COUNT(DISTINCT CAST(pl.InsertDateTime AS date)) days
  FROM ProductLogs pl WITH (NOLOCK) JOIN Users u ON u.UserId=pl.UpdateBy
  WHERE pl.LogTypeId IN (2,7,4,18) AND pl.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND u.Username LIKE 'temp%'
  GROUP BY u.UserId, u.FirstName, u.LastName FOR JSON PATH) shared

-- @D8 inbound — supplies of the warehouse still "Started" (status 1) by age, the oldest ones, and per day the delay from
--    opening the supply to its first checked-in unit (median, p90 minutes).
SELECT /*bn:D8*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT SUM(CASE WHEN a<1440 THEN 1 ELSE 0 END) lt24, SUM(CASE WHEN a>=1440 AND a<4320 THEN 1 ELSE 0 END) d1_3, SUM(CASE WHEN a>=4320 AND a<10080 THEN 1 ELSE 0 END) d3_7,
    SUM(CASE WHEN a>=10080 AND a<30/*ma*/*1440 THEN 1 ELSE 0 END) d7_30, SUM(CASE WHEN a>=30/*ma*/*1440 THEN 1 ELSE 0 END) gt30, SUM(CASE WHEN a>=24/*sh*/*60 AND a<30/*ma*/*1440 THEN 1 ELSE 0 END) stuck30, COUNT(*) n
  FROM (SELECT DATEDIFF(minute, s.InsertDateTime, GETDATE()) a FROM Supplies s WHERE s.WarehouseId=1/*wh*/ AND s.SupplyStatusId=1) x FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) started,
 (SELECT TOP 15 s.SupplyUniqueName id, CONVERT(varchar(16),s.InsertDateTime,120) at, CAST(s.IsFastLane AS int) fl,
    (SELECT COUNT(*) FROM ProductCheckIns c WHERE c.SupplyUniqueId=s.SupplyUniqueName) u
  FROM Supplies s WHERE s.WarehouseId=1/*wh*/ AND s.SupplyStatusId=1 AND s.InsertDateTime>=DATEADD(day,-30/*ma*/,GETDATE()) AND s.InsertDateTime<DATEADD(hour,-24/*sh*/,GETDATE())
  ORDER BY s.InsertDateTime FOR JSON PATH) oldest,
 (SELECT CONVERT(varchar(10),d,23) d, COUNT(*) n, MAX(p50) p50, MAX(p90) p90 FROM (
    SELECT CAST(s.InsertDateTime AS date) d,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DATEDIFF(minute,s.InsertDateTime,f.f)) OVER (PARTITION BY CAST(s.InsertDateTime AS date)) p50,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY DATEDIFF(minute,s.InsertDateTime,f.f)) OVER (PARTITION BY CAST(s.InsertDateTime AS date)) p90
    FROM Supplies s JOIN (SELECT SupplyUniqueId, MIN(InsertDateTime) f FROM ProductCheckIns WHERE WarehouseId=1/*wh*/ AND InsertDateTime>=DATEADD(day,-36/*nd+1*/,CAST(GETDATE() AS date)) GROUP BY SupplyUniqueId) f
      ON f.SupplyUniqueId=s.SupplyUniqueName
    WHERE s.WarehouseId=1/*wh*/ AND s.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND f.f>=s.InsertDateTime) x GROUP BY d ORDER BY d FOR JSON PATH) delay

-- @D9 inventory accuracy (sdLast / nfLast / imLast = when each source last received a row: a stopped source is reported as such) — per week: stock differences created / still open, products not found (NotFoundProducts)
--    created / still unfixed; recent closed inspections (scanned vs missing); product codes and rows that repeat.
SELECT /*bn:D9*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CONVERT(varchar(16),MAX(InsertDateTime),120) FROM StockDifferences) sdLast, (SELECT CONVERT(varchar(16),MAX(InsertDateTime),120) FROM NotFoundProducts) nfLast,
 (SELECT CONVERT(varchar(16),MAX(InsertDateTime),120) FROM InspectMissingProducts WHERE InsertDateTime>=DATEADD(day,-400,GETDATE())) imLast,
 (SELECT DATEPART(iso_week,InsertDateTime) wk, MIN(CONVERT(varchar(10),InsertDateTime,23)) d1, COUNT(*) n, SUM(CASE WHEN Resolved=0 THEN 1 ELSE 0 END) open_
  FROM StockDifferences WHERE InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) GROUP BY DATEPART(iso_week,InsertDateTime) ORDER BY MIN(InsertDateTime) FOR JSON PATH) sd,
 (SELECT DATEPART(iso_week,nf.InsertDateTime) wk, MIN(CONVERT(varchar(10),nf.InsertDateTime,23)) d1, COUNT(*) n, SUM(CASE WHEN nf.FixedBy IS NULL THEN 1 ELSE 0 END) open_
  FROM NotFoundProducts nf JOIN Rows r ON r.Id=nf.RowId JOIN Shelves sh ON sh.Id=r.ShelfId JOIN Sections se ON se.Id=sh.SectionId AND se.WarehouseId=1/*wh*/
  WHERE nf.InsertDateTime>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) GROUP BY DATEPART(iso_week,nf.InsertDateTime) ORDER BY MIN(nf.InsertDateTime) FOR JSON PATH) nf,
 (SELECT TOP 8 i.Id id, i.InspectName nm, CONVERT(varchar(10),i.ClosedDate,23) cd, (SELECT COUNT(*) FROM InspectedProducts p WHERE p.InspectId=i.Id) sc,
    (SELECT COUNT(*) FROM InspectMissingProducts m WHERE m.InspectId=i.Id AND m.InsertDateTime>=DATEADD(day,-400,GETDATE())) ms
  FROM Inspects i WHERE i.WarehouseId=1/*wh*/ AND i.Closed=1 AND i.ClosedDate>=DATEADD(day,-30/*ma*/,GETDATE()) ORDER BY i.ClosedDate DESC FOR JSON PATH) insp,
 (SELECT TOP 15 ProductCode c, COUNT(*) n, MAX(ABS(WarehouseStock-QuickbooksStock)) mx FROM StockDifferences
  WHERE InsertDateTime>=DATEADD(day,-30/*ma*/,CAST(GETDATE() AS date)) GROUP BY ProductCode HAVING COUNT(*)>=3 ORDER BY COUNT(*) DESC FOR JSON PATH) sdRepeat,
 (SELECT TOP 15 r.RowUniqueName row_, se.SectionName sec, COUNT(*) n FROM NotFoundProducts nf JOIN Rows r ON r.Id=nf.RowId JOIN Shelves sh ON sh.Id=r.ShelfId
    JOIN Sections se ON se.Id=sh.SectionId AND se.WarehouseId=1/*wh*/
  WHERE nf.InsertDateTime>=DATEADD(day,-30/*ma*/,GETDATE()) GROUP BY r.RowUniqueName, se.SectionName HAVING COUNT(*)>=2 ORDER BY COUNT(*) DESC FOR JSON PATH) nfRepeat

-- @D10 space / locations (ormLast = last row written to OrderRowMapping; parking is not tracked when it is old). Rows: only
--    units put on the shelf within the last ma days (UpdateDateTime), so old stock does not count as a new overload. — orders parked on a row (OrderRowMapping, no PlatformId: matched on OrderId, unique per the
--    D7 check) that have no check-out after parking, by age; the fullest rows (units on shelf, status 7) against the
--    median; sections by not-found / missing-in-inspection count (last nd days).
SELECT /*bn:D10*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CONVERT(varchar(16),MAX(InsertDateTime),120) FROM OrderRowMapping) ormLast,
 (SELECT SUM(CASE WHEN a<1440 THEN 1 ELSE 0 END) lt24, SUM(CASE WHEN a>=1440 AND a<4320 THEN 1 ELSE 0 END) d1_3, SUM(CASE WHEN a>=4320 AND a<10080 THEN 1 ELSE 0 END) d3_7,
    SUM(CASE WHEN a>=10080 THEN 1 ELSE 0 END) gt7, COUNT(*) n FROM (
    SELECT DATEDIFF(minute, m.InsertDateTime, GETDATE()) a FROM OrderRowMapping m
    JOIN Rows r ON r.Id=m.RowId JOIN Shelves sh ON sh.Id=r.ShelfId JOIN Sections se ON se.Id=sh.SectionId AND se.WarehouseId=1/*wh*/
    WHERE m.InsertDateTime>=DATEADD(day,-30/*ma*/,GETDATE())
      AND NOT EXISTS (SELECT 1 FROM ProductLogs y WITH (NOLOCK) WHERE y.OrderId=m.OrderId AND y.LogTypeId IN (4,18) AND y.InsertDateTime>=m.InsertDateTime)) x FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) parked,
 (SELECT TOP 15 r.RowUniqueName row_, se.SectionName sec, COUNT(*) n FROM ProductCheckIns c JOIN Rows r ON r.Id=c.RowId JOIN Shelves sh ON sh.Id=r.ShelfId
    JOIN Sections se ON se.Id=sh.SectionId AND se.WarehouseId=1/*wh*/
  WHERE c.WarehouseId=1/*wh*/ AND c.StatusId=7 AND c.UpdateDateTime>=DATEADD(day,-30/*ma*/,GETDATE()) GROUP BY r.RowUniqueName, se.SectionName ORDER BY COUNT(*) DESC FOR JSON PATH) fullRows,
 (SELECT MAX(p50) FROM (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY n) OVER () p50 FROM (
    SELECT COUNT(*) n FROM ProductCheckIns c WHERE c.WarehouseId=1/*wh*/ AND c.StatusId=7 AND c.RowId>0 AND c.UpdateDateTime>=DATEADD(day,-30/*ma*/,GETDATE()) GROUP BY c.RowId) a) b) rowMedian,
 (SELECT TOP 15 se.SectionName sec, SUM(nf) nf, SUM(ms) ms FROM (
    SELECT sh.SectionId sid, 1 nf, 0 ms FROM NotFoundProducts nf JOIN Rows r ON r.Id=nf.RowId JOIN Shelves sh ON sh.Id=r.ShelfId WHERE nf.InsertDateTime>=DATEADD(day,-30/*ma*/,CAST(GETDATE() AS date))
    UNION ALL
    SELECT sh.SectionId, 0, 1 FROM InspectMissingProducts m JOIN Rows r ON r.Id=m.RowId JOIN Shelves sh ON sh.Id=r.ShelfId WHERE m.InsertDateTime>=DATEADD(day,-30/*ma*/,CAST(GETDATE() AS date))) x
  JOIN Sections se ON se.Id=x.sid AND se.WarehouseId=1/*wh*/ GROUP BY se.SectionName ORDER BY SUM(nf)+SUM(ms) DESC FOR JSON PATH) errSections

-- @D11 transport — inbound shipment stops to the warehouse, split LOCAL (Shipments.SupplierType 10, e.g. Beki) and
--    INTERNATIONAL (SupplierType 20: Poland, Czechia, Romania, Hungary … via Vokshi, MIKMIK, GoShipping, Apcom …).
--    Late = actual arrival DATE after the estimated date. week: per type and ISO week of estimated arrival (window nd);
--    intl30/intlPrev: international stops due in the last 30 days and the 90 days before (more n than a week);
--    carrier: per type and carrier (window nd, plus pickup → arrival days); openIntl: international stops with no
--    recorded arrival more than 2 days after the estimated date (estimated within the last ma days; older: olderOpenIntl); dataIntl: per month of pickup, how many
--    international stops have a pallet count and a price recorded (SupplierType meanings: 10 local, 20 international —
--    inferred from origin names, not documented).
SELECT /*bn:D11*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CASE WHEN s.SupplierType=20 THEN 'intl' ELSE 'local' END t, DATEPART(iso_week,d.EstimatedArrivalDate) wk, MIN(CONVERT(varchar(10),d.EstimatedArrivalDate,23)) d1, COUNT(*) n,
    SUM(CASE WHEN d.ActualArrivalDate IS NOT NULL AND CAST(d.ActualArrivalDate AS date)>CAST(d.EstimatedArrivalDate AS date) THEN 1 ELSE 0 END) late,
    SUM(CASE WHEN d.ActualArrivalDate IS NULL AND CAST(d.EstimatedArrivalDate AS date)<CAST(GETDATE() AS date) THEN 1 ELSE 0 END) missing
  FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId
  WHERE d.WarehouseId=1/*wh*/ AND d.EstimatedArrivalDate>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND d.EstimatedArrivalDate<CAST(GETDATE() AS date)
  GROUP BY CASE WHEN s.SupplierType=20 THEN 'intl' ELSE 'local' END, DATEPART(iso_week,d.EstimatedArrivalDate) ORDER BY 1, MIN(d.EstimatedArrivalDate) FOR JSON PATH) week,
 (SELECT COUNT(*) n, SUM(CASE WHEN d.ActualArrivalDate IS NOT NULL AND CAST(d.ActualArrivalDate AS date)>CAST(d.EstimatedArrivalDate AS date) THEN 1 ELSE 0 END) late,
    SUM(CASE WHEN d.ActualArrivalDate IS NOT NULL THEN 1 ELSE 0 END) arr, ROUND(AVG(CASE WHEN d.ActualArrivalDate IS NOT NULL THEN 1.0*DATEDIFF(day,d.EstimatedArrivalDate,d.ActualArrivalDate) END),2) delayDays
  FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId AND s.SupplierType=20
  WHERE d.WarehouseId=1/*wh*/ AND d.EstimatedArrivalDate>=DATEADD(day,-30,CAST(GETDATE() AS date)) AND d.EstimatedArrivalDate<CAST(GETDATE() AS date) FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) intl30,
 (SELECT COUNT(*) n, SUM(CASE WHEN d.ActualArrivalDate IS NOT NULL AND CAST(d.ActualArrivalDate AS date)>CAST(d.EstimatedArrivalDate AS date) THEN 1 ELSE 0 END) late,
    SUM(CASE WHEN d.ActualArrivalDate IS NOT NULL THEN 1 ELSE 0 END) arr
  FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId AND s.SupplierType=20
  WHERE d.WarehouseId=1/*wh*/ AND d.EstimatedArrivalDate>=DATEADD(day,-120,CAST(GETDATE() AS date)) AND d.EstimatedArrivalDate<DATEADD(day,-30,CAST(GETDATE() AS date)) FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) intlPrev,
 (SELECT CASE WHEN s.SupplierType=20 THEN 'intl' ELSE 'local' END t, ca.Name nm, COUNT(*) n,
    SUM(CASE WHEN d.ActualArrivalDate IS NOT NULL AND CAST(d.ActualArrivalDate AS date)>CAST(d.EstimatedArrivalDate AS date) THEN 1 ELSE 0 END) late,
    SUM(CASE WHEN d.ActualArrivalDate IS NULL THEN 1 ELSE 0 END) missing,
    ROUND(AVG(CASE WHEN d.ActualArrivalDate IS NOT NULL THEN 1.0*DATEDIFF(day,d.EstimatedArrivalDate,d.ActualArrivalDate) END),2) delayDays,
    ROUND(AVG(CASE WHEN d.ActualArrivalDate IS NOT NULL AND s.PickupDateTime IS NOT NULL THEN DATEDIFF(hour,s.PickupDateTime,d.ActualArrivalDate)/24.0 END),1) transitDays
  FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId JOIN Carriers ca ON ca.Id=s.CarrierId
  WHERE d.WarehouseId=1/*wh*/ AND d.EstimatedArrivalDate>=DATEADD(day,-35/*nd*/,CAST(GETDATE() AS date)) AND d.EstimatedArrivalDate<CAST(GETDATE() AS date)
  GROUP BY CASE WHEN s.SupplierType=20 THEN 'intl' ELSE 'local' END, ca.Name ORDER BY 1, COUNT(*) DESC FOR JSON PATH) carrier,
 (SELECT TOP 50 s.Id id, d.Id did, ca.Name car, LEFT(s.OriginWarehouseName,40) o, d.Status st, CONVERT(varchar(10),s.PickupDateTime,23) pick, CONVERT(varchar(10),d.EstimatedArrivalDate,23) eta,
    DATEDIFF(day,d.EstimatedArrivalDate,GETDATE()) daysOver, (SELECT COUNT(*) FROM Invoices i WHERE i.ShipmentDestinationId=d.Id) inv
  FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId AND s.SupplierType=20 JOIN Carriers ca ON ca.Id=s.CarrierId
  WHERE d.WarehouseId=1/*wh*/ AND d.ActualArrivalDate IS NULL AND d.EstimatedArrivalDate<DATEADD(day,-2,CAST(GETDATE() AS date)) AND d.EstimatedArrivalDate>=DATEADD(day,-30/*ma*/,GETDATE())
  ORDER BY d.EstimatedArrivalDate FOR JSON PATH) openIntl,
 (SELECT COUNT(*) FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId AND s.SupplierType=20
  WHERE d.WarehouseId=1/*wh*/ AND d.ActualArrivalDate IS NULL AND d.EstimatedArrivalDate>=DATEADD(day,-365,GETDATE()) AND d.EstimatedArrivalDate<DATEADD(day,-30/*ma*/,GETDATE())) olderOpenIntl,
 (SELECT CONVERT(varchar(7),s.PickupDateTime,126) m, COUNT(*) n, SUM(CASE WHEN ISNULL(d.PalletCount,0)>0 THEN 1 ELSE 0 END) withPal, SUM(CASE WHEN ISNULL(d.Price,0)>0 THEN 1 ELSE 0 END) withPrice,
    (SELECT ca2.Name c, COUNT(*) n FROM ShipmentDestinations d2 JOIN Shipments s2 ON s2.Id=d2.ShipmentId AND s2.SupplierType=20 JOIN Carriers ca2 ON ca2.Id=s2.CarrierId
     WHERE d2.WarehouseId=1/*wh*/ AND ISNULL(d2.Price,0)=0 AND CONVERT(varchar(7),s2.PickupDateTime,126)=CONVERT(varchar(7),s.PickupDateTime,126) GROUP BY ca2.Name FOR JSON PATH) noPrice
  FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId AND s.SupplierType=20
  WHERE d.WarehouseId=1/*wh*/ AND s.PickupDateTime>=DATEADD(month,-6,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1))
  GROUP BY CONVERT(varchar(7),s.PickupDateTime,126) ORDER BY 1 FOR JSON PATH) dataIntl

-- @D12 order age by current WmsStatusId (warehouse, orders created in the last ma days) — buckets 0–4 h, 4–8 h, 8–24 h, 1–3 d, > 3 d, split by
--    whether the order already has a check-out (4/18). Status meanings are unconfirmed (hints only): shown as numbers.
SELECT /*bn:D12*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT s, pf, co, SUM(CASE WHEN a<240 THEN 1 ELSE 0 END) b0_4, SUM(CASE WHEN a>=240 AND a<480 THEN 1 ELSE 0 END) b4_8, SUM(CASE WHEN a>=480 AND a<1440 THEN 1 ELSE 0 END) b8_24,
    SUM(CASE WHEN a>=1440 AND a<4320 THEN 1 ELSE 0 END) b1_3d, SUM(CASE WHEN a>=4320 THEN 1 ELSE 0 END) b3d, COUNT(*) n FROM (
    SELECT o.WmsStatusId s, o.PlatformId pf, DATEDIFF(minute, o.CreatedOnUtc, GETUTCDATE()) a,
      CASE WHEN EXISTS (SELECT 1 FROM ProductLogs y WITH (NOLOCK) WHERE y.OrderId=o.OrderId AND y.PlatformId=o.PlatformId AND y.LogTypeId IN (4,18) AND y.InsertDateTime>=DATEADD(day,-62,GETDATE())) THEN 1 ELSE 0 END co
    FROM Orders o WHERE o.WarehouseId=1/*wh*/ AND (0/*pf*/=0 OR o.PlatformId=0/*pf*/) AND o.CreatedOnUtc>=DATEADD(day,-30/*ma*/,GETUTCDATE())) x
  GROUP BY s, pf, co ORDER BY s, pf, co FOR JSON PATH) age,
 (SELECT WmsStatusId s, MIN(ShippingAttribute) a FROM OrderStatusMapping WHERE ShippingAttribute IS NOT NULL GROUP BY WmsStatusId FOR JSON PATH) hints

-- @D13 cost per order — piece-rate cost (WarehouseActionPayments.Cost is already CalculatedPrice × Quantity: never
--    multiplied again) per closed salary period and pricing version of the warehouse, with the orders checked out
--    (distinct (OrderId, PlatformId), 4/18) between the first and last action paid under that version.
SELECT /*bn:D13*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT p.SalaryPeriodId per, p.PricingVersionId v, ROUND(SUM(p.Cost),2) cost, SUM(p.Quantity) q, CONVERT(varchar(16),MIN(p.OccurredAt),120) f, CONVERT(varchar(16),MAX(p.OccurredAt),120) l,
    (SELECT COUNT(*) FROM (SELECT pl.OrderId, pl.PlatformId FROM ProductLogs pl WITH (NOLOCK) JOIN Orders o ON o.OrderId=pl.OrderId AND o.PlatformId=pl.PlatformId AND o.WarehouseId=1/*wh*/
       WHERE pl.LogTypeId IN (4,18) AND pl.OrderId>0 AND pl.InsertDateTime>=MIN(p.OccurredAt) AND pl.InsertDateTime<=MAX(p.OccurredAt) GROUP BY pl.OrderId, pl.PlatformId) z) orders
  FROM WarehouseActionPayments p JOIN WarehouseSalaryPeriods sp ON sp.Id=p.SalaryPeriodId AND sp.WarehouseId=1/*wh*/ AND sp.Status=2
  GROUP BY p.SalaryPeriodId, p.PricingVersionId ORDER BY p.SalaryPeriodId, p.PricingVersionId FOR JSON PATH) cost,
 (SELECT Id id, PeriodYear y, PeriodMonth m, Status s, CONVERT(varchar(10),FromInclusive,23) f, CONVERT(varchar(10),ToExclusive,23) t, TotalActions ta, ROUND(TotalCost,2) tc
  FROM WarehouseSalaryPeriods WHERE WarehouseId=1/*wh*/ ORDER BY Id FOR JSON PATH) periods
