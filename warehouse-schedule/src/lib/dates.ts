/**
 * Ndihmës për data. Të gjitha datat ruhen si "YYYY-MM-DD" dhe llogariten në
 * UTC, që orari të mos zhvendoset kurrë nga zona kohore e shfletuesit/serverit.
 */

import { MONTH_NAMES, WEEKDAY_SHORT } from "./constants";

export type ISODate = string;

const DAY_MS = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== "string" || !ISO_RE.test(value)) return false;
  return toISO(fromISO(value)) === value;
}

export function fromISO(date: ISODate): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

export function makeISO(year: number, month: number, day: number): ISODate {
  return toISO(new Date(Date.UTC(year, month - 1, day)));
}

export function todayISO(): ISODate {
  const now = new Date();
  return makeISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function addDays(date: ISODate, days: number): ISODate {
  return toISO(new Date(fromISO(date).getTime() + days * DAY_MS));
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((fromISO(a).getTime() - fromISO(b).getTime()) / DAY_MS);
}

/** 0 = e Hënë … 6 = e Diel. */
export function weekdayIndex(date: ISODate): number {
  return (fromISO(date).getUTCDay() + 6) % 7;
}

export function startOfWeek(date: ISODate): ISODate {
  return addDays(date, -weekdayIndex(date));
}

export function weekDates(weekStart: ISODate): ISODate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function dateRange(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthBounds(year: number, month: number): { from: ISODate; to: ISODate } {
  return { from: makeISO(year, month, 1), to: makeISO(year, month, daysInMonth(year, month)) };
}

/**
 * Javët (E Hënë–E Diel) që i përkasin një muaji orari. Si në Excel, një javë
 * i përket muajit ku bie e Diela e saj — p.sh. java 31 Gusht–6 Shtator 2026
 * është pjesë e "Shtator 2026".
 */
export function scheduleMonthWeeks(year: number, month: number): ISODate[] {
  const { from, to } = monthBounds(year, month);
  const weeks: ISODate[] = [];
  // E Diela e parë e muajit.
  let sunday = addDays(from, (6 - weekdayIndex(from) + 7) % 7);
  while (sunday <= to) {
    weeks.push(addDays(sunday, -6));
    sunday = addDays(sunday, 7);
  }
  return weeks;
}

/**
 * Intervali që mbulon si javët e muajit të orarit, ashtu edhe muajin
 * kalendarik (për statistikat).
 */
export function scheduleMonthRange(year: number, month: number): { from: ISODate; to: ISODate } {
  const bounds = monthBounds(year, month);
  const weeks = scheduleMonthWeeks(year, month);
  const weeksEnd = addDays(weeks[weeks.length - 1], 6);
  return {
    from: weeks[0] < bounds.from ? weeks[0] : bounds.from,
    to: weeksEnd > bounds.to ? weeksEnd : bounds.to,
  };
}

/** Muaji i orarit ku bën pjesë java që fillon më `weekStart`. */
export function scheduleMonthOfWeek(weekStart: ISODate): { year: number; month: number } {
  const sunday = fromISO(addDays(weekStart, 6));
  return { year: sunday.getUTCFullYear(), month: sunday.getUTCMonth() + 1 };
}

export function formatDayMonth(date: ISODate): string {
  const d = fromISO(date);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function formatDate(date: ISODate): string {
  return `${formatDayMonth(date)}.${fromISO(date).getUTCFullYear()}`;
}

export function formatWeekday(date: ISODate): string {
  return WEEKDAY_SHORT[weekdayIndex(date)];
}

export function formatMonthYear(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

export function formatWeekRange(weekStart: ISODate): string {
  return `${formatDate(weekStart)} – ${formatDate(addDays(weekStart, 6))}`;
}

export function isWeekend(date: ISODate): boolean {
  return weekdayIndex(date) >= 5;
}
