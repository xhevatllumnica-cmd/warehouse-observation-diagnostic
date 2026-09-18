/**
 * Logjika e shift-eve: parsimi i kodeve "HH:MM-HH:MM", kohëzgjatja,
 * kategoria (mëngjes/mbasdite/natë) dhe ngjyrat.
 */

import type { EntryStatus, ShiftCategory } from "./constants";

export const SHIFT_CODE_RE = /^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]|24):([0-5]\d)$/;

export interface ShiftTimes {
  startTime: string;
  endTime: string;
}

/** Kthen orët e fillimit/mbarimit nga një kod si "07:00-15:00", ose null. */
export function parseShiftCode(code: string): ShiftTimes | null {
  const m = code.trim().match(SHIFT_CODE_RE);
  if (!m) return null;
  const endHour = m[3] === "24" ? "00" : m[3];
  return { startTime: `${m[1]}:${m[2]}`, endTime: `${endHour}:${m[4]}` };
}

export function shiftCode(startTime: string, endTime: string): string {
  return `${startTime}-${endTime}`;
}

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** A përfundon shift-i ditën tjetër (p.sh. 23:00-07:00). */
export function crossesMidnight(startTime: string, endTime: string): boolean {
  return timeToMinutes(endTime) <= timeToMinutes(startTime);
}

/** Kohëzgjatja në minuta; shift-et që kalojnë mesnatën trajtohen saktë. */
export function shiftDurationMinutes(startTime: string, endTime: string): number {
  const start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (end <= start) end += 24 * 60;
  return end - start;
}

export function shiftHours(startTime: string, endTime: string): number {
  return shiftDurationMinutes(startTime, endTime) / 60;
}

/**
 * Kategoria e shift-it:
 * - kalon mesnatën ose fillon nga 17:00 → natë
 * - fillon para 11:00 → mëngjes
 * - përndryshe → mbasdite
 */
export function shiftCategory(startTime: string, endTime: string): ShiftCategory {
  const start = timeToMinutes(startTime);
  if (crossesMidnight(startTime, endTime) || start >= 17 * 60) return "night";
  return start < 11 * 60 ? "morning" : "afternoon";
}

/**
 * Klasat Tailwind për çdo lloj qelize. Të gjitha klasat shkruhen të plota që
 * Tailwind t'i gjejë gjatë build-it.
 */
export const CELL_STYLES: Record<ShiftCategory | Exclude<EntryStatus, "working">, string> = {
  morning:
    "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/70 dark:text-emerald-200 dark:border-emerald-900",
  afternoon:
    "bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-950/70 dark:text-sky-200 dark:border-sky-900",
  night:
    "bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-950/70 dark:text-violet-200 dark:border-violet-900",
  weekly_off:
    "bg-zinc-200 text-zinc-600 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700",
  off: "bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:border-zinc-800",
  sick_leave:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/60 dark:text-red-300 dark:border-red-900",
  annual_leave:
    "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-200 dark:border-amber-900",
};

/** Ngjyrat hex për eksportin Excel/PDF (pa dark mode). */
export const EXPORT_COLORS: Record<ShiftCategory | Exclude<EntryStatus, "working">, string> = {
  morning: "#d1fae5",
  afternoon: "#e0f2fe",
  night: "#ede9fe",
  weekly_off: "#e4e4e7",
  off: "#f4f4f5",
  sick_leave: "#fee2e2",
  annual_leave: "#fef3c7",
};

export function styleKey(
  status: EntryStatus,
  category: ShiftCategory | null | undefined,
): keyof typeof CELL_STYLES {
  if (status === "working") return category ?? "morning";
  return status;
}

/**
 * Formaton orët me presje dhjetore (p.sh. 7,5). Nuk përdor `toLocaleString`,
 * sepse jo çdo shfletues ka të dhënat për "sq" dhe serveri/klienti do të
 * jepnin tekst të ndryshëm (gabim hidratimi).
 */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return String(rounded).replace(".", ",");
}
