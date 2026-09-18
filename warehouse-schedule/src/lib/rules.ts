/**
 * Rregullat e biznesit dhe statistikat e orarit.
 *
 * Funksione të pastra (pa databazë) që përdoren njësoj në server (për të
 * bllokuar ruajtjet e pavlefshme) dhe në klient (për paralajmërime live).
 */

import { RULES, type EntryStatus } from "./constants";
import { addDays, diffDays, startOfWeek, type ISODate } from "./dates";
import { shiftDurationMinutes, timeToMinutes } from "./shifts";

export interface RuleEntry {
  employeeId: string;
  date: ISODate;
  status: EntryStatus;
  shift?: { code: string; startTime: string; endTime: string } | null;
}

interface Interval {
  date: ISODate;
  start: number; // minuta nga një pikë referimi e përbashkët
  end: number;
}

const REF_DATE = "2000-01-03"; // e Hënë

function toInterval(entry: RuleEntry): Interval | null {
  if (entry.status !== "working" || !entry.shift) return null;
  const dayOffset = diffDays(entry.date, REF_DATE) * 1440;
  const start = dayOffset + timeToMinutes(entry.shift.startTime);
  return {
    date: entry.date,
    start,
    end: start + shiftDurationMinutes(entry.shift.startTime, entry.shift.endTime),
  };
}

/**
 * Kontrollon nëse `candidate` mbivendoset me shift-et e ditës para/pas.
 * Kthen mesazhin e gabimit ose null. (Dy shift-e në të njëjtën ditë janë të
 * pamundura nga vetë databaza — një qelizë për person/ditë.)
 */
export function findOverlap(candidate: RuleEntry, neighbours: RuleEntry[]): string | null {
  const c = toInterval(candidate);
  if (!c) return null;
  for (const n of neighbours) {
    if (n.employeeId !== candidate.employeeId || n.date === candidate.date) continue;
    if (Math.abs(diffDays(n.date, candidate.date)) > 1) continue;
    const i = toInterval(n);
    if (i && c.start < i.end && i.start < c.end) {
      return `Mbivendoset me shift-in ${n.shift!.code} të datës ${n.date}.`;
    }
  }
  return null;
}

export type WarningType =
  | "long_shift"
  | "short_rest"
  | "consecutive_days"
  | "weekly_hours"
  | "off_days"
  | "overlap";

export interface ScheduleWarning {
  employeeId: string;
  date: ISODate;
  type: WarningType;
  message: string;
}

/**
 * Llogarit paralajmërimet për të gjitha hyrjet e dhëna. Rekomandohet të jepen
 * hyrje edhe disa ditë para intervalit të shfaqur, që ditët radhazi dhe
 * pushimi mes shift-eve të llogariten saktë në kufi.
 */
export function computeWarnings(entries: RuleEntry[]): ScheduleWarning[] {
  const warnings: ScheduleWarning[] = [];
  const byEmployee = new Map<string, RuleEntry[]>();
  for (const e of entries) {
    const list = byEmployee.get(e.employeeId) ?? [];
    list.push(e);
    byEmployee.set(e.employeeId, list);
  }

  for (const [employeeId, list] of byEmployee) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const push = (date: ISODate, type: WarningType, message: string) =>
      warnings.push({ employeeId, date, type, message });

    // Shift-e të gjata, pushim i shkurtër, mbivendosje.
    let prev: Interval | null = null;
    for (const e of list) {
      const cur = toInterval(e);
      if (!cur) continue;
      const hours = (cur.end - cur.start) / 60;
      if (hours > RULES.maxShiftHours) {
        push(e.date, "long_shift", `Shift ${hours} orë (mbi ${RULES.maxShiftHours} orë).`);
      }
      if (prev && diffDays(cur.date, prev.date) <= 1) {
        const gap = (cur.start - prev.end) / 60;
        if (gap < 0) {
          push(e.date, "overlap", "Shift-i mbivendoset me shift-in e ditës së kaluar.");
        } else if (gap < RULES.minRestHours) {
          push(e.date, "short_rest", `Vetëm ${gap} orë pushim nga shift-i i kaluar.`);
        }
      }
      prev = cur;
    }

    // Ditë pune radhazi.
    let run = 0;
    let lastDate: ISODate | null = null;
    for (const e of list) {
      if (e.status !== "working") {
        run = 0;
        lastDate = e.date;
        continue;
      }
      run = lastDate && diffDays(e.date, lastDate) === 1 ? run + 1 : 1;
      lastDate = e.date;
      if (run === RULES.maxConsecutiveWorkDays + 1) {
        push(e.date, "consecutive_days", `${run} ditë pune radhazi pa pushim.`);
      }
    }

    // Orë javore.
    const weekHours = new Map<ISODate, number>();
    for (const e of list) {
      if (e.status !== "working" || !e.shift) continue;
      const w = startOfWeek(e.date);
      weekHours.set(
        w,
        (weekHours.get(w) ?? 0) + shiftDurationMinutes(e.shift.startTime, e.shift.endTime) / 60,
      );
    }
    for (const [week, hours] of weekHours) {
      if (hours > RULES.maxWeeklyHours) {
        push(week, "weekly_hours", `${hours} orë në javën ${week} (mbi ${RULES.maxWeeklyHours}).`);
      }
    }

    // Ditë OFF në muaj (pa llogaritur Weekly OFF).
    const monthOff = new Map<string, number>();
    for (const e of list) {
      if (e.status !== "off") continue;
      const key = e.date.slice(0, 7);
      const n = (monthOff.get(key) ?? 0) + 1;
      monthOff.set(key, n);
      if (n === RULES.maxOffDaysPerMonth + 1) {
        push(e.date, "off_days", `Më shumë se ${RULES.maxOffDaysPerMonth} ditë OFF në muajin ${key}.`);
      }
    }
  }

  return warnings;
}

export interface EmployeeStats {
  employeeId: string;
  totalHours: number;
  workDays: number;
  morning: number;
  afternoon: number;
  night: number;
  weeklyOff: number;
  off: number;
  sickLeave: number;
  annualLeave: number;
}

export function emptyStats(employeeId: string): EmployeeStats {
  return {
    employeeId,
    totalHours: 0,
    workDays: 0,
    morning: 0,
    afternoon: 0,
    night: 0,
    weeklyOff: 0,
    off: 0,
    sickLeave: 0,
    annualLeave: 0,
  };
}

type StatsEntry = RuleEntry & { shift?: (RuleEntry["shift"] & { category: string }) | null };

/** Statistikat për person mbi hyrjet e dhëna (thirrësi zgjedh intervalin). */
export function computeStats(entries: StatsEntry[]): Map<string, EmployeeStats> {
  const stats = new Map<string, EmployeeStats>();
  for (const e of entries) {
    const s = stats.get(e.employeeId) ?? emptyStats(e.employeeId);
    switch (e.status) {
      case "working":
        s.workDays += 1;
        if (e.shift) {
          s.totalHours += shiftDurationMinutes(e.shift.startTime, e.shift.endTime) / 60;
          if (e.shift.category === "morning") s.morning += 1;
          else if (e.shift.category === "afternoon") s.afternoon += 1;
          else s.night += 1;
        }
        break;
      case "weekly_off":
        s.weeklyOff += 1;
        break;
      case "off":
        s.off += 1;
        break;
      case "sick_leave":
        s.sickLeave += 1;
        break;
      case "annual_leave":
        s.annualLeave += 1;
        break;
    }
    stats.set(e.employeeId, s);
  }
  return stats;
}

/** Orët e punës për person brenda [from, to]. */
export function hoursInRange(entries: StatsEntry[], from: ISODate, to: ISODate) {
  return computeStats(entries.filter((e) => e.date >= from && e.date <= to));
}

/** Sa ditë para intervalit duhen lexuar që rregullat të jenë të sakta. */
export const RULES_LOOKBACK_DAYS = RULES.maxConsecutiveWorkDays + 1;

export function lookbackStart(from: ISODate): ISODate {
  return addDays(from, -RULES_LOOKBACK_DAYS);
}
