-- WMS Pulse · Prishtinë — the queries behind the "WMS Pulse" page (app tab + artifact).
-- Run each block (-- @A … -- @E, keep the /*pulse:X*/ marker) as ONE read-only SELECT on the WMS database (queryWMSDb). Every block returns a
-- single row; list columns are JSON strings (FOR JSON). Save the row object as pulse/raw/<letter>.json, then run
-- `node pulse/build.js`.
-- Rules (gjirafa-wms-data-analyst): ProductLogs.InsertDateTime is local time, Orders.CreatedOnUtc is UTC;
-- Users are joined on UserId (not Id); orders on (OrderId, PlatformId); no CTEs (derived tables only).
-- Never select Country.ApiValue, ExternalPlatformTokens, Settings.Value or any hash column.
-- Weighted ops = 1.0×check-out (4,18) + 0.8×check-in (2) + 0.6×map (7).

-- @A productivity
SELECT /*pulse:A*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT CONVERT(varchar(19),MAX(InsertDateTime),126) FROM ProductLogs) lastLog,
 (SELECT CONVERT(varchar(19),MAX(CreatedOnUtc),126) FROM Orders) lastOrder,
 (SELECT u.Username n, SUM(CASE WHEN pl.LogTypeId=2 THEN 1 ELSE 0 END) ci, SUM(CASE WHEN pl.LogTypeId=7 THEN 1 ELSE 0 END) mp,
    SUM(CASE WHEN pl.LogTypeId IN (4,18) THEN 1 ELSE 0 END) co, COUNT(DISTINCT CAST(pl.InsertDateTime AS date)) d
  FROM ProductLogs pl JOIN Users u ON u.UserId=pl.UpdateBy
  WHERE pl.InsertDateTime >= DATEADD(day,-6,CAST(GETDATE() AS date)) AND pl.LogTypeId IN (2,7,4,18) AND u.UserWarehouseId=1
    AND (u.Username LIKE '%@gjirafa.com' OR u.Username NOT LIKE '%@%')
  GROUP BY u.Username FOR JSON PATH) week,
 (SELECT n, ROUND(SUM(w)/COUNT(*),1) opd, COUNT(*) d FROM (
    SELECT u.Username n, CAST(pl.InsertDateTime AS date) dt, SUM(CASE WHEN pl.LogTypeId IN (4,18) THEN 1.0 WHEN pl.LogTypeId=2 THEN 0.8 ELSE 0.6 END) w
    FROM ProductLogs pl JOIN Users u ON u.UserId=pl.UpdateBy
    WHERE pl.InsertDateTime >= DATEADD(day,-30,CAST(GETDATE() AS date)) AND pl.InsertDateTime < CAST(GETDATE() AS date) AND pl.LogTypeId IN (2,7,4,18)
      AND (u.Username LIKE '%@gjirafa.com' OR u.Username NOT LIKE '%@%')
    GROUP BY u.Username, CAST(pl.InsertDateTime AS date)) x
  GROUP BY n ORDER BY opd DESC FOR JSON PATH) bands,
 (SELECT DATEPART(hour,pl.InsertDateTime) h, SUM(CASE WHEN pl.LogTypeId=2 THEN 1 ELSE 0 END) ci, SUM(CASE WHEN pl.LogTypeId=7 THEN 1 ELSE 0 END) mp,
    SUM(CASE WHEN pl.LogTypeId IN (4,18) THEN 1 ELSE 0 END) co
  FROM ProductLogs pl WHERE pl.InsertDateTime >= DATEADD(day,-14,CAST(GETDATE() AS date)) AND pl.InsertDateTime < CAST(GETDATE() AS date) AND pl.LogTypeId IN (2,7,4,18)
  GROUP BY DATEPART(hour,pl.InsertDateTime) ORDER BY 1 FOR JSON PATH) hour

-- @B pay per action (latest closed salary period of warehouse 01)
SELECT /*pulse:B*/
 (SELECT TOP 1 Id id, PeriodYear y, PeriodMonth m, Status s, TotalActions ta, TotalCost tc FROM WarehouseSalaryPeriods WHERE WarehouseId=1 AND Status=2 ORDER BY Id DESC FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) per,
 (SELECT a.Code c, COUNT(*) r, SUM(p.Quantity) q, ROUND(SUM(p.Cost),2) cost FROM WarehouseActionPayments p JOIN WarehouseActions a ON a.Id=p.WarehouseActionId
  WHERE p.SalaryPeriodId=(SELECT MAX(Id) FROM WarehouseSalaryPeriods WHERE WarehouseId=1 AND Status=2) GROUP BY a.Code, a.SortOrder ORDER BY a.SortOrder FOR JSON PATH) period,
 (SELECT ISNULL(u.Username, CONCAT('user#',p.UserId)) n, SUM(CASE WHEN a.Code='CheckIn' THEN p.Quantity ELSE 0 END) ci, SUM(CASE WHEN a.Code='Map' THEN p.Quantity ELSE 0 END) mp,
    SUM(CASE WHEN a.Code='Picking' THEN p.Quantity ELSE 0 END) pk, SUM(CASE WHEN a.Code='CheckoutShipping' THEN p.Quantity ELSE 0 END) co,
    ROUND(SUM(p.Quantity*a.AverageTimeSeconds)/3600.0,1) hrs, ROUND(SUM(p.Cost),2) cost
  FROM WarehouseActionPayments p JOIN WarehouseActions a ON a.Id=p.WarehouseActionId LEFT JOIN (SELECT UserId, MIN(Username) Username FROM Users GROUP BY UserId) u ON u.UserId=p.UserId
  WHERE p.SalaryPeriodId=(SELECT MAX(Id) FROM WarehouseSalaryPeriods WHERE WarehouseId=1 AND Status=2)
  GROUP BY ISNULL(u.Username, CONCAT('user#',p.UserId)) ORDER BY cost DESC FOR JSON PATH) pay,
 (SELECT r.PricingVersionId v, a.Code c, v.OrderCompletionPrice ocp, v.TotalWeight tw, r.Weight w, r.Price p, CONVERT(varchar(16),r.ValidFrom,120) vf, CONVERT(varchar(16),r.ValidTo,120) vt, CAST(v.IsOpen AS int) op
  FROM WarehouseActionRates r JOIN WarehousePricingVersions v ON v.Id=r.PricingVersionId JOIN WarehouseActions a ON a.Id=r.WarehouseActionId
  ORDER BY r.PricingVersionId, a.SortOrder FOR JSON PATH, INCLUDE_NULL_VALUES) rates

-- @C orders (warehouse 01 unless noted)
SELECT /*pulse:C*/
 (SELECT CONVERT(varchar(5),r.d,104) d, r.mall, r.g50, ISNULL(c.co,0) co FROM
   (SELECT CAST(CreatedOnUtc AS date) d, SUM(CASE WHEN PlatformId=1 THEN 1 ELSE 0 END) mall, SUM(CASE WHEN PlatformId=2 THEN 1 ELSE 0 END) g50
    FROM Orders WHERE WarehouseId=1 AND CreatedOnUtc >= DATEADD(day,-14,CAST(GETUTCDATE() AS date)) GROUP BY CAST(CreatedOnUtc AS date)) r
   LEFT JOIN (SELECT d, COUNT(*) co FROM (SELECT DISTINCT CAST(pl.InsertDateTime AS date) d, pl.OrderId, pl.PlatformId FROM ProductLogs pl
      JOIN Orders o ON o.OrderId=pl.OrderId AND o.PlatformId=pl.PlatformId AND o.WarehouseId=1
      WHERE pl.LogTypeId IN (4,18) AND pl.InsertDateTime >= DATEADD(day,-14,CAST(GETDATE() AS date))) x GROUP BY d) c ON c.d=r.d
  ORDER BY r.d FOR JSON PATH) daily,
 (SELECT PlatformId p, COUNT(*) n, ROUND(AVG(h),1) avg_h, ROUND(MAX(p50),1) med_h, ROUND(MAX(p90),1) p90_h FROM (
    SELECT PlatformId, h, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY PlatformId) p50, PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY h) OVER (PARTITION BY PlatformId) p90
    FROM (SELECT o.PlatformId, DATEDIFF(minute, DATEADD(minute, DATEPART(TZOFFSET, SYSDATETIMEOFFSET() AT TIME ZONE 'Central European Standard Time'), o.CreatedOnUtc), f.fco)/60.0 h
      FROM (SELECT pl.OrderId, pl.PlatformId, MIN(pl.InsertDateTime) fco FROM ProductLogs pl WHERE pl.LogTypeId IN (4,18) AND pl.OrderId>0 GROUP BY pl.OrderId, pl.PlatformId
            HAVING MIN(pl.InsertDateTime) >= DATEADD(day,-14,CAST(GETDATE() AS date))) f
      JOIN Orders o ON o.OrderId=f.OrderId AND o.PlatformId=f.PlatformId AND o.WarehouseId=1) x WHERE h>=0) y
  GROUP BY PlatformId ORDER BY PlatformId FOR JSON PATH) o2c,
 (SELECT o.PlatformId p, COUNT(*) n, ROUND(AVG(1.0*q),2) avgu, MAX(q) mx FROM Orders o
    JOIN (SELECT OrderId, PlatformId, SUM(Quantity) q FROM OrderDetails GROUP BY OrderId, PlatformId) d ON d.OrderId=o.OrderId AND d.PlatformId=o.PlatformId
  WHERE o.WarehouseId=1 AND o.CreatedOnUtc >= DATEADD(day,-30,GETUTCDATE()) GROUP BY o.PlatformId ORDER BY o.PlatformId FOR JSON PATH) upo,
 (SELECT o.WarehouseId w, o.PlatformId p, o.WmsStatusId s, COUNT(*) n, SUM(CASE WHEN o.CreatedOnUtc < DATEADD(hour,-24,GETUTCDATE()) THEN 1 ELSE 0 END) h24,
    SUM(CASE WHEN o.CreatedOnUtc < DATEADD(hour,-72,GETUTCDATE()) THEN 1 ELSE 0 END) h72
  FROM Orders o WHERE o.CreatedOnUtc >= DATEADD(day,-30,GETUTCDATE()) GROUP BY o.WarehouseId, o.PlatformId, o.WmsStatusId ORDER BY o.WarehouseId, o.PlatformId, COUNT(*) DESC FOR JSON PATH) status,
 (SELECT WmsStatusId s, MIN(ShippingAttribute) a FROM OrderStatusMapping WHERE ShippingAttribute IS NOT NULL GROUP BY WmsStatusId FOR JSON PATH) statusNames

-- @D stock & locations (warehouse 01 unless noted)
SELECT /*pulse:D*/
 (SELECT StatusId s, COUNT(*) n FROM ProductCheckIns WHERE WarehouseId=1 AND InsertDateTime >= DATEADD(day,-90,GETDATE()) GROUP BY StatusId ORDER BY n DESC FOR JSON PATH) state,
 (SELECT COUNT(*) FROM ProductCheckIns WHERE WarehouseId=1 AND StatusId=7) onShelf,
 (SELECT COUNT(DISTINCT RowId) FROM ProductCheckIns WHERE WarehouseId=1 AND StatusId=7 AND RowId>0) rowsStock,
 (SELECT COUNT(*) FROM Rows r JOIN Shelves sh ON sh.Id=r.ShelfId JOIN Sections se ON se.Id=sh.SectionId WHERE se.WarehouseId=1) rowsTotal,
 (SELECT COUNT(*) FROM StockDifferences WHERE Resolved=0) diffOpen, (SELECT COUNT(*) FROM StockDifferences) diffTotal,
 (SELECT COUNT(*) FROM NotFoundProducts WHERE FixedBy IS NULL) nfOpen, (SELECT COUNT(*) FROM NotFoundProducts) nfTotal,
 (SELECT COUNT(*) FROM ReturnDetails WHERE IsResolved=0) retOpen,
 (SELECT CONVERT(varchar(5),ci,104) d, COUNT(*) n, AVG(DATEDIFF(minute, cit, mt)) m FROM (
    SELECT CAST(MIN(CASE WHEN pl.LogTypeId=2 THEN pl.InsertDateTime END) AS date) ci, MIN(CASE WHEN pl.LogTypeId=2 THEN pl.InsertDateTime END) cit, MIN(CASE WHEN pl.LogTypeId=7 THEN pl.InsertDateTime END) mt
    FROM ProductLogs pl JOIN ProductCheckIns c ON c.ProductItemUniqueIdentifier=pl.ProductItemUniqueIdentifierId AND c.WarehouseId=1
    WHERE pl.LogTypeId IN (2,7) AND pl.InsertDateTime >= DATEADD(day,-14,CAST(GETDATE() AS date)) GROUP BY pl.ProductItemUniqueIdentifierId) x
  WHERE cit IS NOT NULL AND mt > cit GROUP BY ci ORDER BY ci FOR JSON PATH) dwell,
 (SELECT TOP 25 se.Id id, se.SectionName nm, COUNT(*) n, COUNT(DISTINCT c.RowId) r FROM ProductCheckIns c JOIN Rows r ON r.Id=c.RowId JOIN Shelves sh ON sh.Id=r.ShelfId JOIN Sections se ON se.Id=sh.SectionId
  WHERE c.WarehouseId=1 AND c.StatusId=7 GROUP BY se.Id, se.SectionName ORDER BY n DESC FOR JSON PATH) sect,
 (SELECT TOP 12 i.Id id, i.InspectName nm, i.InspectStyle st, CONVERT(varchar(10),i.ClosedDate,104) cd,
    (SELECT COUNT(*) FROM InspectedProducts p WHERE p.InspectId=i.Id) sc, (SELECT COUNT(*) FROM InspectMissingProducts m WHERE m.InspectId=i.Id) ms
  FROM Inspects i WHERE i.WarehouseId=1 AND i.Closed=1 ORDER BY i.ClosedDate DESC FOR JSON PATH) insp,
 (SELECT TOP 20 ProductCode c, MAX(Sku) sku, COUNT(*) n, MAX(ABS(WarehouseStock-QuickbooksStock)) mx, SUM(WarehouseStock-QuickbooksStock) sm
  FROM StockDifferences WHERE Resolved=0 GROUP BY ProductCode ORDER BY mx DESC FOR JSON PATH) diff

-- @E inbound & logistics
SELECT /*pulse:E*/
 (SELECT DATEPART(iso_week, ws) wk, CONVERT(varchar(5), ws, 104) st, COUNT(*) n, SUM(CASE WHEN IsFastLane=1 THEN 1 ELSE 0 END) fl, SUM(u) units FROM (
    SELECT s.IsFastLane, DATEADD(day, -((DATEPART(weekday, s.InsertDateTime)+@@DATEFIRST-2)%7), CAST(s.InsertDateTime AS date)) ws,
      (SELECT COUNT(*) FROM ProductCheckIns c WHERE c.SupplyUniqueId=s.SupplyUniqueName) u
    FROM Supplies s WHERE s.WarehouseId=1 AND s.InsertDateTime >= DATEADD(week,-8,DATEADD(day, -((DATEPART(weekday, GETDATE())+@@DATEFIRST-2)%7), CAST(GETDATE() AS date)))) x
  GROUP BY ws ORDER BY ws FOR JSON PATH) sup,
 (SELECT ca.Name nm, COUNT(*) stops, SUM(CASE WHEN d.ActualArrivalDate IS NOT NULL AND CAST(d.ActualArrivalDate AS date) <= CAST(d.EstimatedArrivalDate AS date) THEN 1 ELSE 0 END) ontime,
    ROUND(AVG(CASE WHEN d.ActualArrivalDate IS NOT NULL THEN 1.0*DATEDIFF(day, d.EstimatedArrivalDate, d.ActualArrivalDate) END),2) delay, SUM(ISNULL(d.PalletCount,0)) pal, ROUND(SUM(ISNULL(d.Price,0)),0) price
  FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId JOIN Carriers ca ON ca.Id=s.CarrierId
  WHERE d.EstimatedArrivalDate <= GETDATE() GROUP BY ca.Name ORDER BY stops DESC FOR JSON PATH, INCLUDE_NULL_VALUES) car,
 (SELECT COUNT(*) FROM ShipmentDestinations WHERE ActualArrivalDate IS NULL AND EstimatedArrivalDate < GETDATE()) lateOpen,
 (SELECT COUNT(*) FROM Supplies WHERE SupplyStatusId=1 AND WarehouseId=1) supStarted,
 (SELECT ISNULL(u.Username, CONCAT('user#',ps.UserId)) n, COUNT(*) s, AVG(DATEDIFF(minute, ps.InsertDateTime, ps.UpdateDateTime)) m, SUM(ISNULL(o.n,0)) o, SUM(ISNULL(i.sc,0)) sc, SUM(ISNULL(i.rq,0)) rq
  FROM PickSession ps LEFT JOIN (SELECT UserId, MIN(Username) Username FROM Users GROUP BY UserId) u ON u.UserId=ps.UserId
    LEFT JOIN (SELECT PickSessionId, COUNT(*) n FROM PickSessionOrder GROUP BY PickSessionId) o ON o.PickSessionId=ps.Id
    LEFT JOIN (SELECT PickSessionId, SUM(ScannedQuantity) sc, SUM(RequiredQuantity) rq FROM PickSessionItem GROUP BY PickSessionId) i ON i.PickSessionId=ps.Id
  WHERE ps.Status=2 AND ps.InsertDateTime >= '2026-08-10' GROUP BY ISNULL(u.Username, CONCAT('user#',ps.UserId)) ORDER BY COUNT(*) DESC FOR JSON PATH, INCLUDE_NULL_VALUES) pick,
 (SELECT st.Name nm, CAST(st.IsCheckIn AS int) ci, CAST(st.IsCheckOut AS int) co, CAST(st.UseWmsPrintAgent AS int) pa, (SELECT COUNT(*) FROM PickSession p WHERE p.StationId=st.Id) ps
  FROM Stations st WHERE st.WarehouseId=1 AND st.Id<>13 ORDER BY st.Name FOR JSON PATH) st,
 (SELECT CONVERT(varchar(7), InsertDateTime, 126) m, COUNT(*) n, SUM(CASE WHEN StatusId=3 THEN 1 ELSE 0 END) s3, SUM(CASE WHEN StatusId=1 THEN 1 ELSE 0 END) s1, SUM(CASE WHEN SentToQbo=1 THEN 1 ELSE 0 END) qbo
  FROM Invoices WHERE InsertDateTime >= DATEADD(month,-5,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY CONVERT(varchar(7), InsertDateTime, 126) ORDER BY 1 FOR JSON PATH) inv

-- @F inbound batches (Product / Inbound Flow): every supply of warehouse 01 from yesterday and today, plus older ones
--    (≤14 days) that still have units waiting to be mapped. Stages: arrival = invoice registered (or the truck's actual
--    arrival when the invoice belongs to a shipment) → receiving = supply opened → check-in (LogType 2) → mapping
--    (LogType 7) → system update = supply closed (status 3 "Done"). Cross-dock = the unit went to an order (LogType 3)
--    before any mapping. Times are 'yyyy-mm-dd hh:mi' local.
SELECT /*pulse:F*/
 (SELECT s.SupplyUniqueName id, s.StoreId st, s.SupplyStatusId ss, CAST(s.IsFastLane AS int) fl, CAST(s.IsStarterKit AS int) sk,
    CONVERT(varchar(16),s.InsertDateTime,120) rcv, CASE WHEN s.SupplyStatusId=3 THEN CONVERT(varchar(16),s.UpdateDateTime,120) END dn,
    iv.inv, iv.ia, iv.arr, iv.ex, ISNULL(u.n,0) n, u.k, u.c1, u.c2, u.m1, u.m2, u.xd, u.mp, u.aw, u.o, u.cm, u.cc, u.im,
    (SELECT TOP 1 se.SectionName FROM ProductCheckIns c2 JOIN Rows r ON r.Id=c2.RowId JOIN Shelves sh ON sh.Id=r.ShelfId JOIN Sections se ON se.Id=sh.SectionId
      WHERE c2.SupplyUniqueId=s.SupplyUniqueName AND c2.StatusId=7 GROUP BY se.SectionName ORDER BY COUNT(*) DESC) sec,
    (SELECT TOP 1 LEFT(gp.Name,48) FROM ProductCheckIns c3 JOIN GjirafaMall_Products gp ON gp.ProductId=c3.ProductId
      WHERE c3.SupplyUniqueId=s.SupplyUniqueName GROUP BY gp.Name ORDER BY COUNT(*) DESC) pn,
    (SELECT TOP 1 c5.ProductCode FROM ProductCheckIns c5 WHERE c5.SupplyUniqueId=s.SupplyUniqueName GROUP BY c5.ProductCode ORDER BY COUNT(*) DESC) cd,
    (SELECT COUNT(*) FROM NotFoundProducts nf WHERE nf.InsertDateTime>=s.InsertDateTime
      AND nf.ProductCode IN (SELECT c4.ProductCode FROM ProductCheckIns c4 WHERE c4.SupplyUniqueId=s.SupplyUniqueName)) nf
  FROM Supplies s
  LEFT JOIN (SELECT c.SupplyUniqueId sid, COUNT(*) n, COUNT(DISTINCT c.ProductCode) k,
      CONVERT(varchar(16),MIN(x.f2),120) c1, CONVERT(varchar(16),MAX(x.l2),120) c2, CONVERT(varchar(16),MIN(x.f7),120) m1, CONVERT(varchar(16),MAX(x.l7),120) m2,
      SUM(CASE WHEN x.f3 IS NOT NULL AND (x.f7 IS NULL OR x.f3<x.f7) THEN 1 ELSE 0 END) xd, SUM(CASE WHEN x.f7 IS NOT NULL THEN 1 ELSE 0 END) mp,
      SUM(CASE WHEN c.StatusId=6 THEN 1 ELSE 0 END) aw, COUNT(DISTINCT CASE WHEN x.f3 IS NOT NULL AND c.OrderId>0 THEN c.OrderId END) o,
      AVG(CASE WHEN x.f7>x.f2 THEN DATEDIFF(minute,x.f2,x.f7) END) cm,
      SUM(CASE WHEN pc.uid IS NOT NULL THEN 1 ELSE 0 END) cc, SUM(CASE WHEN ip.uid IS NOT NULL THEN 1 ELSE 0 END) im
    FROM ProductCheckIns c
    LEFT JOIN (SELECT ProductItemUniqueIdentifierId uid, MIN(CASE WHEN LogTypeId=2 THEN InsertDateTime END) f2, MAX(CASE WHEN LogTypeId=2 THEN InsertDateTime END) l2,
         MIN(CASE WHEN LogTypeId=3 THEN InsertDateTime END) f3, MIN(CASE WHEN LogTypeId=7 THEN InsertDateTime END) f7, MAX(CASE WHEN LogTypeId=7 THEN InsertDateTime END) l7
       FROM ProductLogs WHERE LogTypeId IN (2,3,7) AND InsertDateTime>=DATEADD(day,-14,CAST(GETDATE() AS date)) GROUP BY ProductItemUniqueIdentifierId) x ON x.uid=c.ProductItemUniqueIdentifier
    LEFT JOIN (SELECT DISTINCT ProductItemUniqueIdentifier uid FROM ProductCodeLogs WHERE InsertDateTime>=DATEADD(day,-14,CAST(GETDATE() AS date))) pc ON pc.uid=c.ProductItemUniqueIdentifier
    LEFT JOIN (SELECT DISTINCT p.ProductUniqueId uid FROM InspectedProducts p JOIN ProductCheckIns q ON q.ProductItemUniqueIdentifier=p.ProductUniqueId
       WHERE p.InsertDateTime>=DATEADD(day,-14,CAST(GETDATE() AS date)) AND p.RowId<>q.RowId AND q.StatusId=7) ip ON ip.uid=c.ProductItemUniqueIdentifier
    WHERE c.WarehouseId=1 AND c.InsertDateTime>=DATEADD(day,-14,CAST(GETDATE() AS date)) GROUP BY c.SupplyUniqueId) u ON u.sid=s.SupplyUniqueName
  LEFT JOIN (SELECT m.SupplyUniqueId sid, MIN(LTRIM(RTRIM(i.InvoiceNumber))) inv, CONVERT(varchar(16),MIN(i.InsertDateTime),120) ia, CONVERT(varchar(16),MIN(sd.ActualArrivalDate),120) arr, SUM(ipc.n) ex
    FROM Supply_Invoice_Mapping m JOIN Invoices i ON i.InvoiceUniqueId=m.InvoiceNo LEFT JOIN ShipmentDestinations sd ON sd.Id=i.ShipmentDestinationId
    LEFT JOIN (SELECT InvoiceUniqueName, COUNT(*) n FROM InvoiceProducts WHERE InsertDateTime>=DATEADD(day,-21,CAST(GETDATE() AS date)) GROUP BY InvoiceUniqueName) ipc ON ipc.InvoiceUniqueName=m.InvoiceNo
    WHERE m.InsertDateTime>=DATEADD(day,-15,CAST(GETDATE() AS date)) GROUP BY m.SupplyUniqueId) iv ON iv.sid=s.SupplyUniqueName
  WHERE s.WarehouseId=1 AND (s.InsertDateTime >= DATEADD(day,-1,CAST(GETDATE() AS date)) OR (s.InsertDateTime >= DATEADD(day,-14,CAST(GETDATE() AS date)) AND u.aw>0))
  ORDER BY s.InsertDateTime DESC FOR JSON PATH, INCLUDE_NULL_VALUES) inb,
 (SELECT CONVERT(varchar(10),d,120) d, COUNT(*) s, SUM(n) n, SUM(xd) xd, SUM(mp) mp, SUM(aw) aw, AVG(cm) cm FROM (
    SELECT CAST(s.InsertDateTime AS date) d, COUNT(*) n, SUM(CASE WHEN x.f3 IS NOT NULL AND (x.f7 IS NULL OR x.f3<x.f7) THEN 1 ELSE 0 END) xd,
      SUM(CASE WHEN x.f7 IS NOT NULL THEN 1 ELSE 0 END) mp, SUM(CASE WHEN c.StatusId=6 THEN 1 ELSE 0 END) aw, AVG(CASE WHEN x.f7>x.f2 THEN DATEDIFF(minute,x.f2,x.f7) END) cm
    FROM Supplies s JOIN ProductCheckIns c ON c.SupplyUniqueId=s.SupplyUniqueName AND c.WarehouseId=1
    LEFT JOIN (SELECT ProductItemUniqueIdentifierId uid, MIN(CASE WHEN LogTypeId=2 THEN InsertDateTime END) f2, MIN(CASE WHEN LogTypeId=3 THEN InsertDateTime END) f3, MIN(CASE WHEN LogTypeId=7 THEN InsertDateTime END) f7
       FROM ProductLogs WHERE LogTypeId IN (2,3,7) AND InsertDateTime>=DATEADD(day,-14,CAST(GETDATE() AS date)) GROUP BY ProductItemUniqueIdentifierId) x ON x.uid=c.ProductItemUniqueIdentifier
    WHERE s.WarehouseId=1 AND s.InsertDateTime>=DATEADD(day,-13,CAST(GETDATE() AS date)) GROUP BY CAST(s.InsertDateTime AS date), s.SupplyUniqueName) y
  GROUP BY d ORDER BY d FOR JSON PATH) inbDaily

-- @G orders (Order Flow): warehouse 01. Stages per order: created (Orders.CreatedOnUtc, shown in local time) →
--    items assigned (LogType 3 = a unit reserved for the order — at check-in for cross-dock units) → check-out
--    (first LogType 27 scan → last of 27/9/4/18, all at the check-out station) → done. A unit scanned at check-out
--    without a LogType 3 for that same order came from stock (picked from a rack). ord = orders checked out today;
--    wait = orders with units reserved (unit status 3) but not yet checked out; daily = 14-day trend.
--    LogType 3 rows and ProductCheckIns carry PlatformId 0, so cross-dock is matched per unit (same unit, same
--    OrderId) and a waiting order's platform comes from Orders (the two platforms' order numbers do not overlap in
--    practice; the newest order with that number wins).
SELECT /*pulse:G*/
 (SELECT k.OrderId id, k.PlatformId p, o.WmsStatusId st, CONVERT(varchar(16),DATEADD(minute,z.tz,o.CreatedOnUtc),120) cr,
    CONVERT(varchar(16),a.f3,120) a1, CONVERT(varchar(16),a.l3,120) a2, ISNULL(a.u3,0) xu,
    CONVERT(varchar(16),k.f27,120) c1, CONVERT(varchar(16),k.lco,120) c2, k.u27 u, dq.l, dq.q,
    (SELECT TOP 1 LEFT(us.FirstName+' '+us.LastName,30) FROM ProductLogs x JOIN Users us ON us.UserId=x.UpdateBy WHERE x.Id=k.id27) w,
    (SELECT COUNT(*) FROM OrderUnmaps um WHERE um.OrderId=k.OrderId AND um.PlatformId=k.PlatformId) um
  FROM (SELECT pl.OrderId, pl.PlatformId, MIN(CASE WHEN pl.LogTypeId=27 THEN pl.InsertDateTime END) f27, MAX(pl.InsertDateTime) lco,
         COUNT(DISTINCT CASE WHEN pl.LogTypeId=27 THEN pl.ProductItemUniqueIdentifierId END) u27, MIN(CASE WHEN pl.LogTypeId=27 THEN pl.Id END) id27
        FROM ProductLogs pl WHERE pl.LogTypeId IN (27,9,4,18) AND pl.OrderId>0 AND pl.InsertDateTime>=CAST(GETDATE() AS date) GROUP BY pl.OrderId, pl.PlatformId
        HAVING MIN(CASE WHEN pl.LogTypeId=27 THEN pl.InsertDateTime END) IS NOT NULL) k
  JOIN Orders o ON o.OrderId=k.OrderId AND o.PlatformId=k.PlatformId AND o.WarehouseId=1
  CROSS JOIN (SELECT DATEPART(TZOFFSET, SYSDATETIMEOFFSET() AT TIME ZONE 'Central European Standard Time') tz) z
  LEFT JOIN (SELECT k2.OrderId, k2.PlatformId, MIN(x3.InsertDateTime) f3, MAX(x3.InsertDateTime) l3, COUNT(DISTINCT k2.uid) u3
        FROM (SELECT DISTINCT OrderId, PlatformId, ProductItemUniqueIdentifierId uid FROM ProductLogs
              WHERE LogTypeId=27 AND OrderId>0 AND InsertDateTime>=CAST(GETDATE() AS date)) k2
        JOIN ProductLogs x3 ON x3.ProductItemUniqueIdentifierId=k2.uid AND x3.LogTypeId=3 AND x3.OrderId=k2.OrderId
        GROUP BY k2.OrderId, k2.PlatformId) a ON a.OrderId=k.OrderId AND a.PlatformId=k.PlatformId
  OUTER APPLY (SELECT COUNT(*) l, SUM(d.Quantity) q FROM OrderDetails d WHERE d.OrderId=k.OrderId AND d.PlatformId=k.PlatformId) dq
  ORDER BY k.f27 DESC FOR JSON PATH, INCLUDE_NULL_VALUES) ord,
 (SELECT TOP 300 w.OrderId id, o.PlatformId p, o.WmsStatusId st, CONVERT(varchar(16),DATEADD(minute,z.tz,o.CreatedOnUtc),120) cr, w.u,
    CONVERT(varchar(16),w.f,120) a1, CONVERT(varchar(16),w.l,120) a2, dq.l, dq.q,
    (SELECT COUNT(DISTINCT x.ProductItemUniqueIdentifierId) FROM ProductLogs x WHERE x.OrderId=w.OrderId AND x.PlatformId=o.PlatformId AND x.LogTypeId=27) dn,
    (SELECT COUNT(*) FROM OrderUnmaps um WHERE um.OrderId=w.OrderId AND um.PlatformId=o.PlatformId) um
  FROM (SELECT c.OrderId, COUNT(*) u, MIN(COALESCE(lp.InsertDateTime,c.UpdateDateTime)) f, MAX(COALESCE(lp.InsertDateTime,c.UpdateDateTime)) l
        FROM ProductCheckIns c OUTER APPLY (SELECT TOP 1 x.InsertDateTime FROM ProductLogs x
          WHERE x.ProductItemUniqueIdentifierId=c.ProductItemUniqueIdentifier AND x.LogTypeId=3 AND x.OrderId=c.OrderId ORDER BY x.Id DESC) lp
        WHERE c.WarehouseId=1 AND c.StatusId=3 AND c.OrderId>0 GROUP BY c.OrderId) w
  OUTER APPLY (SELECT TOP 1 o0.PlatformId, o0.WmsStatusId, o0.CreatedOnUtc FROM Orders o0 WHERE o0.OrderId=w.OrderId
        ORDER BY CASE WHEN o0.WarehouseId=1 THEN 0 ELSE 1 END, o0.CreatedOnUtc DESC) o
  CROSS JOIN (SELECT DATEPART(TZOFFSET, SYSDATETIMEOFFSET() AT TIME ZONE 'Central European Standard Time') tz) z
  OUTER APPLY (SELECT COUNT(*) l, SUM(d.Quantity) q FROM OrderDetails d WHERE d.OrderId=w.OrderId AND d.PlatformId=o.PlatformId) dq
  ORDER BY w.f ASC FOR JSON PATH, INCLUDE_NULL_VALUES) wait,
 (SELECT CONVERT(varchar(10),d,120) d, COUNT(*) n, SUM(u) units, ROUND(AVG(h),1) h, ROUND(MAX(p50),1) h50,
    SUM(CASE WHEN xu>0 AND xu<u THEN 1 ELSE 0 END) split, SUM(CASE WHEN xu>0 AND xu>=u THEN 1 ELSE 0 END) xd FROM (
    SELECT CAST(k.f27 AS date) d, k.u27 u, ISNULL(a.u3,0) xu, k.h, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY k.h) OVER (PARTITION BY CAST(k.f27 AS date)) p50 FROM (
      SELECT k0.OrderId, k0.PlatformId, k0.f27, k0.u27, DATEDIFF(minute, DATEADD(minute,z.tz,o.CreatedOnUtc), k0.f27)/60.0 h FROM
        (SELECT OrderId, PlatformId, MIN(InsertDateTime) f27, COUNT(DISTINCT ProductItemUniqueIdentifierId) u27 FROM ProductLogs
          WHERE LogTypeId=27 AND OrderId>0 AND InsertDateTime>=DATEADD(day,-13,CAST(GETDATE() AS date)) GROUP BY OrderId, PlatformId) k0
        JOIN Orders o ON o.OrderId=k0.OrderId AND o.PlatformId=k0.PlatformId AND o.WarehouseId=1
        CROSS JOIN (SELECT DATEPART(TZOFFSET, SYSDATETIMEOFFSET() AT TIME ZONE 'Central European Standard Time') tz) z) k
    LEFT JOIN (SELECT k2.OrderId, k2.PlatformId, COUNT(DISTINCT k2.uid) u3
        FROM (SELECT DISTINCT OrderId, PlatformId, ProductItemUniqueIdentifierId uid FROM ProductLogs
              WHERE LogTypeId=27 AND OrderId>0 AND InsertDateTime>=DATEADD(day,-13,CAST(GETDATE() AS date))) k2
        JOIN ProductLogs x3 ON x3.ProductItemUniqueIdentifierId=k2.uid AND x3.LogTypeId=3 AND x3.OrderId=k2.OrderId
        GROUP BY k2.OrderId, k2.PlatformId) a ON a.OrderId=k.OrderId AND a.PlatformId=k.PlatformId
    WHERE k.h>=0) y GROUP BY d ORDER BY d FOR JSON PATH) daily,
 (SELECT CONVERT(varchar(10),CAST(um.InsertDateTime AS date),120) d, COUNT(*) n FROM OrderUnmaps um
    JOIN Orders o ON o.OrderId=um.OrderId AND o.PlatformId=um.PlatformId AND o.WarehouseId=1
  WHERE um.InsertDateTime>=DATEADD(day,-13,CAST(GETDATE() AS date)) GROUP BY CAST(um.InsertDateTime AS date) ORDER BY 1 FOR JSON PATH) unmaps

-- @H capacity — demand and daily volumes (Kapaciteti & Stafi): the last 12 full weeks (Mon–Sun) before the current
--    week, warehouse 01. created = orders by local day (+ after 17:30, Gjirafa50); vol = units handled by warehouse
--    staff per day (check-in 2, map 7, check-out 4/18 — sellers' own accounts and the system account excluded);
--    coOrd = distinct orders checked out per day; hourly = weekday coverage (units and operator-hours per process);
--    pay = latest closed piece-rate period; std = WMS AverageTimeSeconds per action.
SELECT /*pulse:H*/
 CONVERT(varchar(10),DATEADD(week,-12,m.mon),23) wFrom, CONVERT(varchar(10),m.mon,23) wTo,
 (SELECT CONVERT(varchar(10),d,23) d, COUNT(*) o, SUM(g) g50, SUM(lt) late FROM (
    SELECT CAST(DATEADD(minute,z.tz,o.CreatedOnUtc) AS date) d, CASE WHEN o.PlatformId=2 THEN 1 ELSE 0 END g,
      CASE WHEN CAST(DATEADD(minute,z.tz,o.CreatedOnUtc) AS time)>'17:30' THEN 1 ELSE 0 END lt
    FROM Orders o WHERE o.WarehouseId=1 AND o.CreatedOnUtc>=DATEADD(minute,-z.tz,CAST(DATEADD(week,-12,m.mon) AS datetime)) AND o.CreatedOnUtc<DATEADD(minute,-z.tz,CAST(m.mon AS datetime))) a
  GROUP BY d ORDER BY d FOR JSON PATH) created,
 (SELECT CONVERT(varchar(10),CAST(pl.InsertDateTime AS date),23) d, SUM(CASE WHEN pl.LogTypeId=2 THEN 1 ELSE 0 END) ci, SUM(CASE WHEN pl.LogTypeId=7 THEN 1 ELSE 0 END) mp,
    SUM(CASE WHEN pl.LogTypeId IN (4,18) THEN 1 ELSE 0 END) co, COUNT(DISTINCT pl.UpdateBy) ops
  FROM ProductLogs pl WITH (NOLOCK) JOIN Users u ON u.UserId=pl.UpdateBy
  WHERE pl.InsertDateTime>=DATEADD(week,-12,m.mon) AND pl.InsertDateTime<m.mon AND pl.LogTypeId IN (2,7,4,18)
    AND u.UserWarehouseId=1 AND u.UserId>0 AND (u.Username LIKE '%@gjirafa.com' OR u.Username NOT LIKE '%@%')
  GROUP BY CAST(pl.InsertDateTime AS date) ORDER BY 1 FOR JSON PATH) vol,
 (SELECT CONVERT(varchar(10),d,23) d, COUNT(*) n FROM (SELECT CAST(pl.InsertDateTime AS date) d, pl.OrderId, pl.PlatformId FROM ProductLogs pl WITH (NOLOCK)
      JOIN Orders o ON o.OrderId=pl.OrderId AND o.PlatformId=pl.PlatformId AND o.WarehouseId=1
      WHERE pl.LogTypeId IN (4,18) AND pl.OrderId>0 AND pl.InsertDateTime>=DATEADD(week,-12,m.mon) AND pl.InsertDateTime<m.mon
      GROUP BY CAST(pl.InsertDateTime AS date), pl.OrderId, pl.PlatformId) x GROUP BY d ORDER BY d FOR JSON PATH) coOrd,
 (SELECT h, COUNT(DISTINCT d) days, SUM(CASE WHEN t=2 THEN n ELSE 0 END) ci, SUM(CASE WHEN t=7 AND n<400 THEN n ELSE 0 END) mp, SUM(CASE WHEN t=4 THEN n ELSE 0 END) co,
    SUM(CASE WHEN t=2 THEN 1 ELSE 0 END) ciOps, SUM(CASE WHEN t=7 THEN 1 ELSE 0 END) mpOps, SUM(CASE WHEN t=4 THEN 1 ELSE 0 END) coOps, COUNT(DISTINCT CONCAT(d,'-',ub)) anyOps FROM (
    SELECT CAST(pl.InsertDateTime AS date) d, DATEPART(hour,pl.InsertDateTime) h, pl.UpdateBy ub, CASE WHEN pl.LogTypeId IN (4,18) THEN 4 ELSE pl.LogTypeId END t, COUNT(*) n
    FROM ProductLogs pl WITH (NOLOCK) JOIN Users u ON u.UserId=pl.UpdateBy
    WHERE pl.InsertDateTime>=DATEADD(week,-12,m.mon) AND pl.InsertDateTime<m.mon AND DATEPART(weekday,pl.InsertDateTime) NOT IN (1,7) AND pl.LogTypeId IN (2,7,4,18)
      AND u.UserWarehouseId=1 AND u.UserId>0 AND (u.Username LIKE '%@gjirafa.com' OR u.Username NOT LIKE '%@%')
    GROUP BY CAST(pl.InsertDateTime AS date), DATEPART(hour,pl.InsertDateTime), pl.UpdateBy, CASE WHEN pl.LogTypeId IN (4,18) THEN 4 ELSE pl.LogTypeId END) x
  GROUP BY h ORDER BY h FOR JSON PATH) hourly,
 (SELECT TOP 1 p.Id id, p.PeriodYear y, p.PeriodMonth mo, p.TotalActions ta, p.TotalCost tc,
    (SELECT COUNT(*) FROM (SELECT pl.OrderId, pl.PlatformId FROM ProductLogs pl WITH (NOLOCK) JOIN Orders o ON o.OrderId=pl.OrderId AND o.PlatformId=pl.PlatformId AND o.WarehouseId=1
       WHERE pl.LogTypeId IN (4,18) AND pl.OrderId>0 AND pl.InsertDateTime>=p.FromInclusive AND pl.InsertDateTime<p.ToExclusive GROUP BY pl.OrderId, pl.PlatformId) x) orders
  FROM WarehouseSalaryPeriods p WHERE p.WarehouseId=1 AND p.Status=2 ORDER BY p.Id DESC FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) pay,
 (SELECT Code c, AverageTimeSeconds s FROM WarehouseActions FOR JSON PATH) std
FROM (SELECT DATEADD(day, -((DATEPART(weekday,GETDATE())+@@DATEFIRST-2)%7), CAST(GETDATE() AS date)) mon) m
CROSS JOIN (SELECT DATEPART(TZOFFSET, SYSDATETIMEOFFSET() AT TIME ZONE 'Central European Standard Time') tz) z

-- @I capacity — operators (Kapaciteti & Stafi): per warehouse-01 staff account over the same 12 weeks: units and
--    active hours (distinct clock hours with at least one scan) per process, active days, total active hours. Shown
--    in the app as initials + the last 3 digits of the WMS UserId; temp (shared) accounts flagged. Sellers excluded.
SELECT /*pulse:I*/
 (SELECT LEFT(ISNULL(u.FirstName,'?'),1)+'.'+LEFT(ISNULL(u.LastName,'?'),1)+'.' i, RIGHT(CAST(u.UserId AS varchar(12)),3) id, CASE WHEN u.Username LIKE 'temp%' THEN 1 ELSE 0 END tmp,
    SUM(CASE WHEN x.t=2 THEN x.n ELSE 0 END) ci, SUM(CASE WHEN x.t=2 THEN 1 ELSE 0 END) ciH, SUM(CASE WHEN x.t=7 THEN x.n ELSE 0 END) mp, SUM(CASE WHEN x.t=7 THEN 1 ELSE 0 END) mpH,
    SUM(CASE WHEN x.t=4 THEN x.n ELSE 0 END) co, SUM(CASE WHEN x.t=4 THEN 1 ELSE 0 END) coH, COUNT(DISTINCT CAST(x.hh AS date)) days, COUNT(DISTINCT x.hh) hrs
  FROM (SELECT pl.UpdateBy ub, CASE WHEN pl.LogTypeId IN (4,18) THEN 4 ELSE pl.LogTypeId END t, DATEADD(hour,DATEDIFF(hour,0,pl.InsertDateTime),0) hh, COUNT(*) n
        FROM ProductLogs pl WITH (NOLOCK) WHERE pl.InsertDateTime>=DATEADD(week,-12,m.mon) AND pl.InsertDateTime<m.mon AND pl.LogTypeId IN (2,7,4,18)
        GROUP BY pl.UpdateBy, CASE WHEN pl.LogTypeId IN (4,18) THEN 4 ELSE pl.LogTypeId END, DATEADD(hour,DATEDIFF(hour,0,pl.InsertDateTime),0)) x
  JOIN Users u ON u.UserId=x.ub
  WHERE u.UserWarehouseId=1 AND u.UserId>0 AND (u.Username LIKE '%@gjirafa.com' OR u.Username NOT LIKE '%@%')
  GROUP BY u.UserId, u.FirstName, u.LastName, u.Username HAVING SUM(x.n)>=300 ORDER BY SUM(x.n) DESC FOR JSON PATH) ops
FROM (SELECT DATEADD(day, -((DATEPART(weekday,GETDATE())+@@DATEFIRST-2)%7), CAST(GETDATE() AS date)) mon) m

-- @J capacity — same-day dispatch (Kapaciteti & Stafi): the last 8 full weeks. Ready = the order's last item in the
--    warehouse (order created, or the last cross-dock unit reserved for it — LogType 3, matched per unit); out = the
--    first check-out scan (27). Cut-off 17:30 = no inbound after that, so ready by 17:30 should leave the same day.
SELECT /*pulse:J*/
 (SELECT wk, MIN(CONVERT(varchar(10),d,23)) d1, COUNT(*) n, SUM(bc) rb, SUM(CASE WHEN bc=1 AND dd=0 THEN 1 ELSE 0 END) rbSame, SUM(CASE WHEN bc=1 AND dd=1 THEN 1 ELSE 0 END) rbNext,
    SUM(CASE WHEN bc=1 AND dd>=2 THEN 1 ELSE 0 END) rbLater, SUM(xd) xdo, SUM(u) units, MAX(p50) whP50, MAX(p90) whP90
  FROM (SELECT DATEPART(iso_week,r) wk, CAST(r AS date) d, CASE WHEN CAST(r AS time)<='17:30' THEN 1 ELSE 0 END bc, DATEDIFF(day,CAST(r AS date),CAST(c1 AS date)) dd, xd, u,
     PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DATEDIFF(minute,r,c1)) OVER (PARTITION BY DATEPART(iso_week,r)) p50,
     PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY DATEDIFF(minute,r,c1)) OVER (PARTITION BY DATEPART(iso_week,r)) p90 FROM (
     SELECT k.c1, k.u, CASE WHEN a.l3 IS NOT NULL THEN 1 ELSE 0 END xd, CASE WHEN a.l3>DATEADD(minute,z.tz,o.CreatedOnUtc) THEN a.l3 ELSE DATEADD(minute,z.tz,o.CreatedOnUtc) END r
     FROM (SELECT OrderId, PlatformId, MIN(InsertDateTime) c1, COUNT(DISTINCT ProductItemUniqueIdentifierId) u FROM ProductLogs WITH (NOLOCK)
           WHERE LogTypeId=27 AND OrderId>0 AND InsertDateTime>=DATEADD(day,-7,DATEADD(week,-8,m.mon)) GROUP BY OrderId, PlatformId) k
     JOIN Orders o ON o.OrderId=k.OrderId AND o.PlatformId=k.PlatformId AND o.WarehouseId=1
     LEFT JOIN (SELECT k2.OrderId, k2.PlatformId, MAX(x3.InsertDateTime) l3 FROM
          (SELECT DISTINCT OrderId, PlatformId, ProductItemUniqueIdentifierId uid FROM ProductLogs WITH (NOLOCK)
           WHERE LogTypeId=27 AND OrderId>0 AND InsertDateTime>=DATEADD(day,-7,DATEADD(week,-8,m.mon))) k2
          JOIN ProductLogs x3 WITH (NOLOCK) ON x3.ProductItemUniqueIdentifierId=k2.uid AND x3.LogTypeId=3 AND x3.OrderId=k2.OrderId
          GROUP BY k2.OrderId, k2.PlatformId) a ON a.OrderId=k.OrderId AND a.PlatformId=k.PlatformId) y
    WHERE r>=DATEADD(week,-8,m.mon) AND r<m.mon AND c1>=r) q
  GROUP BY wk ORDER BY MIN(d) FOR JSON PATH) sameDay
FROM (SELECT DATEADD(day, -((DATEPART(weekday,GETDATE())+@@DATEFIRST-2)%7), CAST(GETDATE() AS date)) mon) m
CROSS JOIN (SELECT DATEPART(TZOFFSET, SYSDATETIMEOFFSET() AT TIME ZONE 'Central European Standard Time') tz) z

-- @K shipments (module "Shipments"): every inbound shipment stop (ShipmentDestinations × Shipments) of all warehouses
--    that was picked up, due or arrived in the last 30 days, or is still on the way. Category from Shipments.SupplierType:
--    10 = Kombëtare (local sellers, e.g. Beki), 20 = Ndërkombëtare (Poland, Czechia, Romania, Hungary … — meaning inferred
--    from the origin names). Per stop: carrier, origin, pickup / estimated / actual arrival, status (shown as a number),
--    pallets, price, invoices linked to it (count only — local invoice numbers carry sellers' personal names) and the
--    units checked in from those invoices' supplies with the first / last check-in. Carriers' contact info is not read.
SELECT /*pulse:K*/ CONVERT(varchar(19),GETDATE(),126) gen,
 (SELECT d.Id did, s.Id sid, d.WarehouseId w, CASE WHEN s.SupplierType=20 THEN 'I' ELSE 'K' END cat, s.SupplierType stp, s.CarrierId cid, LEFT(s.OriginWarehouseName,60) o, s.TruckId tr,
    d.DestinationOrder dor, d.Status st, CONVERT(varchar(16),s.PickupDateTime,120) pick, CONVERT(varchar(16),d.EstimatedArrivalDate,120) eta, CONVERT(varchar(16),d.ActualArrivalDate,120) arr,
    d.PalletCount pal, d.Price pr, d.RouteDistanceKm km, iv.n inv, u.units, CONVERT(varchar(16),u.f,120) ci1, CONVERT(varchar(16),u.l,120) ci2
  FROM ShipmentDestinations d JOIN Shipments s ON s.Id=d.ShipmentId
  LEFT JOIN (SELECT i.ShipmentDestinationId sd, COUNT(*) n FROM Invoices i
             WHERE i.ShipmentDestinationId IS NOT NULL AND i.InsertDateTime>=DATEADD(day,-75,GETDATE()) GROUP BY i.ShipmentDestinationId) iv ON iv.sd=d.Id
  LEFT JOIN (SELECT i.ShipmentDestinationId sd, COUNT(DISTINCT c.ProductItemUniqueIdentifier) units, MIN(c.InsertDateTime) f, MAX(c.InsertDateTime) l FROM Invoices i
             JOIN Supply_Invoice_Mapping m ON m.InvoiceNo=i.InvoiceUniqueId JOIN ProductCheckIns c ON c.SupplyUniqueId=m.SupplyUniqueId AND c.InsertDateTime>=DATEADD(day,-75,GETDATE())
             WHERE i.ShipmentDestinationId IS NOT NULL AND i.InsertDateTime>=DATEADD(day,-75,GETDATE()) GROUP BY i.ShipmentDestinationId) u ON u.sd=d.Id
  WHERE d.EstimatedArrivalDate>=DATEADD(day,-30,CAST(GETDATE() AS date)) OR s.PickupDateTime>=DATEADD(day,-30,GETDATE()) OR d.ActualArrivalDate>=DATEADD(day,-30,GETDATE())
  ORDER BY d.EstimatedArrivalDate DESC FOR JSON PATH, INCLUDE_NULL_VALUES) stops,
 (SELECT ca.Id id, ca.Name nm, ca.CountryCode cc, CAST(ca.IsActive AS int) act FROM Carriers ca FOR JSON PATH) carriers,
 (SELECT t.Id id, t.CarrierId car, t.TruckType tt, t.MaxPallets mp FROM Trucks t FOR JSON PATH) trucks
