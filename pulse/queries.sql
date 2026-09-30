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
