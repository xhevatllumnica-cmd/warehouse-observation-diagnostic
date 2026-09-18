/**
 * Parsimi i Excel-it "Schedule warehouse team" në të dhëna të normalizuara.
 *
 * Formati i pritur (çdo fletë = një muaj):
 *
 *   A              B           C           …  H
 *   "Shtator 2026" 2026-08-31  2026-09-01  …  2026-09-06   ← titulli i javës
 *   "Erik"         07:00-15:00 07:00-15:00 …  Weekly OFF   ← një punonjës
 *   …
 *
 * Datat në titujt e javëve kanë shpesh gabime shtypi (viti 2024 në vend të
 * 2025, muaj/ditë të ndërruar, e Diel në vend të së Hënës). Prandaj data e
 * fillimit të javës zgjidhet me "votim" nga të 7 kolonat dhe krahasohet me
 * javën e mëparshme + 7 ditë.
 */

import ExcelJS from "exceljs";
import type { EntryStatus } from "../constants";
import { addDays, diffDays, toISO, weekdayIndex, type ISODate } from "../dates";
import { parseCellValue } from "./cell-value";
import { canonicalName } from "./name-aliases";

export interface ParsedEntry {
  name: string;
  date: ISODate;
  status: EntryStatus;
  shiftCode?: string;
  /** P.sh. "Shtator 2026!C5" — për mesazhe gabimi. */
  source: string;
}

export interface ParsedWorkbook {
  /** Emrat kanonikë sipas renditjes së shfaqjes së fundit. */
  employees: string[];
  shiftCodes: string[];
  entries: ParsedEntry[];
  weeks: number;
  sheets: number;
  /** Qeliza të anashkaluara dhe korrigjime datash, për raportin e importit. */
  issues: string[];
}

const DATE_COLUMNS = 7; // B..H
const VACATION_SHEET = /pushim/i;

type CellValue = ExcelJS.CellValue;

function unwrap(value: CellValue): CellValue {
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if ("result" in value) return unwrap(value.result as CellValue);
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value) return String(value.text);
  }
  return value;
}

function cellDate(value: CellValue): ISODate | null {
  const v = unwrap(value);
  return v instanceof Date && !Number.isNaN(v.getTime()) ? toISO(v) : null;
}

function cellText(value: CellValue): string {
  const v = unwrap(value);
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/** Ndërron muajin me ditën (2025-06-01 → 2025-01-06), nëse është e vlefshme. */
function swapMonthDay(date: ISODate): ISODate | null {
  const [y, m, d] = date.split("-");
  if (Number(d) > 12) return null;
  return `${y}-${d}-${m}`;
}

/** E Hëna më e afërt (para ose pas). */
function nearestMonday(date: ISODate): ISODate {
  const wd = weekdayIndex(date);
  return wd <= 3 ? addDays(date, -wd) : addDays(date, 7 - wd);
}

export function resolveWeekStart(
  headerDates: (ISODate | null)[],
  expected: ISODate | null,
): ISODate | null {
  const votes = new Map<ISODate, number>();
  const vote = (start: ISODate, weight: number) => {
    if (weekdayIndex(start) === 0) votes.set(start, (votes.get(start) ?? 0) + weight);
  };
  headerDates.forEach((d, i) => {
    if (!d) return;
    vote(addDays(d, -i), 1);
    const swapped = swapMonthDay(d);
    if (swapped && swapped !== d) vote(addDays(swapped, -i), 0.5);
  });

  if (expected && votes.has(expected)) return expected;

  let best: ISODate | null = null;
  let bestVotes = 0;
  for (const [start, n] of votes) {
    if (n > bestVotes) [best, bestVotes] = [start, n];
  }
  // Pak vota larg javës së pritur = më shumë gjasë gabim shtypi sesa boshllëk.
  if (best && expected && bestVotes < 3 && Math.abs(diffDays(best, expected)) > 14) {
    return expected;
  }
  if (best) return best;
  if (expected) return expected;
  const first = headerDates.find((d): d is ISODate => d !== null);
  return first ? nearestMonday(first) : null;
}

export async function parseWorkbook(data: ArrayBuffer): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ExcelJS.Buffer);

  const issues: string[] = [];
  const entriesByKey = new Map<string, ParsedEntry>();
  const lastSeen = new Map<string, number>();
  const shiftCodes = new Set<string>();
  let order = 0;
  let weeks = 0;
  let sheets = 0;
  let expected: ISODate | null = null;

  const seeName = (name: string) => lastSeen.set(name, order++);

  for (const ws of wb.worksheets) {
    if (VACATION_SHEET.test(ws.name)) {
      // Fleta "Pushimet vjetore" përmban vetëm emra.
      ws.eachRow((row) => {
        const name = cellText(row.getCell(1).value);
        if (name) seeName(canonicalName(name));
      });
      continue;
    }

    sheets++;
    let weekStart: ISODate | null = null;

    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const headerDates = Array.from({ length: DATE_COLUMNS }, (_, i) =>
        cellDate(row.getCell(i + 2).value),
      );

      if (headerDates.filter(Boolean).length >= 4) {
        const resolved = resolveWeekStart(headerDates, expected);
        const written = headerDates[0];
        if (resolved && written && resolved !== written) {
          issues.push(`${ws.name}!B${r}: data e javës u korrigjua ${written} → ${resolved}`);
        }
        weekStart = resolved;
        if (resolved) {
          expected = addDays(resolved, 7);
          weeks++;
        }
        continue;
      }

      const rawName = cellText(row.getCell(1).value);
      if (!rawName || !weekStart) continue;

      const name = canonicalName(rawName);
      let hasValue = false;

      for (let i = 0; i < DATE_COLUMNS; i++) {
        const cell = row.getCell(i + 2);
        const text = cellText(cell.value);
        if (!text) continue;
        const source = `${ws.name}!${cell.address}`;
        const parsed = parseCellValue(text);
        if (!parsed) {
          issues.push(`${source}: vlera "${text}" (${name}) u anashkalua`);
          continue;
        }
        hasValue = true;
        const date = addDays(weekStart, i);
        if (parsed.shiftCode) shiftCodes.add(parsed.shiftCode);
        const key = `${name}|${date}`;
        if (entriesByKey.has(key)) {
          issues.push(`${source}: ${name} ${date} u gjet dy herë — mbahet vlera e fundit`);
        }
        entriesByKey.set(key, { name, date, source, ...parsed });
      }

      if (hasValue) seeName(name);
    }
  }

  const employees = [...lastSeen.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);

  return {
    employees,
    shiftCodes: [...shiftCodes].sort(),
    entries: [...entriesByKey.values()],
    weeks,
    sheets,
    issues,
  };
}
