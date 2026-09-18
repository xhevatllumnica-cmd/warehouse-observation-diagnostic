import type { Metadata } from "next";
import { ScheduleView } from "@/components/schedule/schedule-view";
import { getEmployees, getEntries, getShifts } from "@/lib/data";
import { db } from "@/lib/db";
import {
  addDays,
  isISODate,
  scheduleMonthOfWeek,
  scheduleMonthRange,
  scheduleMonthWeeks,
  startOfWeek,
  todayISO,
} from "@/lib/dates";
import { lookbackStart } from "@/lib/rules";

export const metadata: Metadata = { title: "Orari" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function param(sp: Record<string, string | string[] | undefined>, key: string) {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

function intParam(value: string | undefined, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export default async function SchedulePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const today = todayISO();
  const view = param(sp, "view") === "week" ? "week" : "month";

  let weeks: string[];
  let year: number;
  let month: number;
  let weekStart: string;

  if (view === "week") {
    const w = param(sp, "week");
    weekStart = startOfWeek(w && isISODate(w) ? w : today);
    weeks = [weekStart];
    ({ year, month } = scheduleMonthOfWeek(weekStart));
  } else {
    const current = scheduleMonthOfWeek(startOfWeek(today));
    year = intParam(param(sp, "year"), 2000, 2100) ?? current.year;
    month = intParam(param(sp, "month"), 1, 12) ?? current.month;
    weeks = scheduleMonthWeeks(year, month);
    weekStart = weeks[0];
  }

  const from = lookbackStart(weeks[0]);
  const to = view === "month" ? scheduleMonthRange(year, month).to : addDays(weekStart, 6);

  const [employees, shifts, entries, bounds] = await Promise.all([
    getEmployees(),
    getShifts(),
    getEntries(from, to),
    db.scheduleEntry.aggregate({ _min: { date: true }, _max: { date: true } }),
  ]);

  // Vitet në filtër: nga viti i parë me orar deri te viti i ardhshëm.
  const thisYear = Number(today.slice(0, 4));
  const firstYear = Math.min(Number(bounds._min.date?.slice(0, 4) ?? thisYear), year);
  const lastYear = Math.max(Number(bounds._max.date?.slice(0, 4) ?? thisYear), thisYear + 1, year);
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);

  return (
    <ScheduleView
      key={`${view}-${weeks[0]}`}
      view={view}
      year={year}
      month={month}
      weekStart={weekStart}
      weeks={weeks}
      today={today}
      years={years}
      employees={employees}
      shifts={shifts}
      entries={entries}
    />
  );
}
