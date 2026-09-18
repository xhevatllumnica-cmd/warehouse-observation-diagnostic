import "server-only";

/**
 * Eksporti në Excel në formatin e skedarit origjinal: një fletë për muaj,
 * blloqe javore (titulli në kolonën A, datat në B–H, punonjësit poshtë).
 * Skedari i eksportuar mund të importohet sërish pa ndryshime.
 */

import ExcelJS from "exceljs";
import {
  MONTH_NAMES,
  STATUS_EXCEL_TEXT,
  WEEKDAY_NAMES,
  type EntryStatus,
} from "../constants";
import { getEmployees, getEntries, getShifts } from "../data";
import {
  formatMonthYear,
  fromISO,
  monthBounds,
  scheduleMonthRange,
  scheduleMonthWeeks,
  weekDates,
  type ISODate,
} from "../dates";
import { computeStats } from "../rules";
import { EXPORT_COLORS, shiftDurationMinutes, styleKey } from "../shifts";
import type { EmployeeDTO, EntryDTO, ShiftDTO } from "../types";

const argb = (hex: string) => `FF${hex.replace("#", "").toUpperCase()}`;

const thin: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFD4D4D8" } },
  bottom: { style: "thin", color: { argb: "FFD4D4D8" } },
  left: { style: "thin", color: { argb: "FFD4D4D8" } },
  right: { style: "thin", color: { argb: "FFD4D4D8" } },
};

interface Context {
  employees: EmployeeDTO[];
  shifts: Map<string, ShiftDTO>;
  entries: Map<string, EntryDTO>;
}

function cellText(entry: EntryDTO | undefined, shifts: Map<string, ShiftDTO>): string {
  if (!entry) return "";
  if (entry.status === "working") return entry.shiftId ? (shifts.get(entry.shiftId)?.code ?? "") : "";
  return STATUS_EXCEL_TEXT[entry.status as Exclude<EntryStatus, "working">];
}

function entryHours(entry: EntryDTO | undefined, shifts: Map<string, ShiftDTO>): number {
  if (!entry || entry.status !== "working" || !entry.shiftId) return 0;
  const s = shifts.get(entry.shiftId);
  return s ? shiftDurationMinutes(s.startTime, s.endTime) / 60 : 0;
}

function addMonthSheet(wb: ExcelJS.Workbook, year: number, month: number, ctx: Context) {
  const title = formatMonthYear(year, month);
  const ws = wb.addWorksheet(title, {
    views: [{ state: "frozen", xSplit: 1 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [
    { width: 18 },
    ...Array.from({ length: 7 }, () => ({ width: 14 })),
    { width: 8 },
  ];

  for (const weekStart of scheduleMonthWeeks(year, month)) {
    const days = weekDates(weekStart);
    const rowEmployees = ctx.employees.filter(
      (e) => e.isActive || days.some((d) => ctx.entries.has(`${e.id}|${d}`)),
    );

    const header = ws.addRow([title, ...days.map((d) => fromISO(d)), "Orë"]);
    header.font = { bold: true };
    header.eachCell((cell, col) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      cell.border = thin;
      cell.alignment = { horizontal: col === 1 ? "left" : "center" };
      if (col >= 2 && col <= 8) cell.numFmt = "dd.mm.yyyy";
    });

    const dayRow = ws.addRow(["", ...WEEKDAY_NAMES, ""]);
    dayRow.font = { italic: true, size: 9, color: { argb: "FF71717A" } };
    dayRow.alignment = { horizontal: "center" };

    for (const emp of rowEmployees) {
      const cells = days.map((d) => ctx.entries.get(`${emp.id}|${d}`));
      const hours = cells.reduce((sum, e) => sum + entryHours(e, ctx.shifts), 0);
      const row = ws.addRow([emp.name, ...cells.map((e) => cellText(e, ctx.shifts)), hours || ""]);
      row.getCell(1).font = { bold: true };
      row.getCell(1).border = { ...thin, left: { style: "thick", color: { argb: argb(emp.color) } } };
      cells.forEach((entry, i) => {
        const cell = row.getCell(i + 2);
        cell.alignment = { horizontal: "center" };
        cell.border = thin;
        if (!entry) return;
        const shift = entry.shiftId ? ctx.shifts.get(entry.shiftId) : undefined;
        const color =
          shift?.color ?? EXPORT_COLORS[styleKey(entry.status, shift?.category)];
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(color) } };
        if (entry.notes) cell.note = entry.notes;
      });
      row.getCell(9).alignment = { horizontal: "center" };
      row.getCell(9).font = { bold: true };
    }
    ws.addRow([]);
  }
}

function addStatsSheet(
  wb: ExcelJS.Workbook,
  name: string,
  from: ISODate,
  to: ISODate,
  ctx: Context,
) {
  const ws = wb.addWorksheet(name);
  ws.columns = [
    { header: "Punonjësi", key: "name", width: 20 },
    { header: "Orë totale", key: "totalHours", width: 12 },
    { header: "Ditë pune", key: "workDays", width: 11 },
    { header: "Mëngjes", key: "morning", width: 10 },
    { header: "Mbasdite", key: "afternoon", width: 10 },
    { header: "Natë", key: "night", width: 8 },
    { header: "Weekly OFF", key: "weeklyOff", width: 12 },
    { header: "OFF", key: "off", width: 8 },
    { header: "Sick Leave", key: "sickLeave", width: 11 },
    { header: "Pushim vjetor", key: "annualLeave", width: 13 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const inRange = [...ctx.entries.values()]
    .filter((e) => e.date >= from && e.date <= to)
    .map((e) => {
      const shift = e.shiftId ? ctx.shifts.get(e.shiftId) : undefined;
      return { ...e, shift: shift ?? null };
    });
  const stats = computeStats(inRange);
  for (const emp of ctx.employees) {
    const s = stats.get(emp.id);
    if (!s) continue;
    ws.addRow({ name: emp.name, ...s });
  }
  ws.addRow([]);
  ws.addRow([`Periudha: ${from} – ${to}`]).font = { italic: true, color: { argb: "FF71717A" } };
}

async function loadContext(from: ISODate, to: ISODate): Promise<Context> {
  const [employees, shifts, entries] = await Promise.all([
    getEmployees(),
    getShifts(),
    getEntries(from, to),
  ]);
  return {
    employees,
    shifts: new Map(shifts.map((s) => [s.id, s])),
    entries: new Map(entries.map((e) => [`${e.employeeId}|${e.date}`, e])),
  };
}

/** Eksporti i një muaji (me `month`) ose i gjithë vitit (pa `month`). */
export async function buildScheduleWorkbook(year: number, month?: number): Promise<ExcelJS.Workbook> {
  const months = month ? [month] : Array.from({ length: 12 }, (_, i) => i + 1);
  const first = months[0];
  const last = months[months.length - 1];
  const ctx = await loadContext(
    scheduleMonthRange(year, first).from,
    scheduleMonthRange(year, last).to,
  );
  const wb = new ExcelJS.Workbook();
  wb.creator = "Orari i Warehouse";
  wb.created = new Date();

  for (const m of months) {
    const weeks = scheduleMonthWeeks(year, m);
    const hasData = weeks.some((w) =>
      weekDates(w).some((d) => ctx.employees.some((e) => ctx.entries.has(`${e.id}|${d}`))),
    );
    // Në eksportin vjetor anashkalohen muajt bosh.
    if (month || hasData) addMonthSheet(wb, year, m, ctx);
  }

  addStatsSheet(
    wb,
    month ? `Statistikat ${MONTH_NAMES[month - 1]}` : `Statistikat ${year}`,
    monthBounds(year, first).from,
    monthBounds(year, last).to,
    ctx,
  );
  return wb;
}
