import { AlertTriangleIcon, ClockIcon, HeartPulseIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { StatsFilters } from "@/components/stats/stats-filters";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MONTH_NAMES } from "@/lib/constants";
import { getEmployees, getEntries, getShifts } from "@/lib/data";
import { formatDate, makeISO, monthBounds, todayISO } from "@/lib/dates";
import {
  computeStats,
  computeWarnings,
  emptyStats,
  lookbackStart,
  type EmployeeStats,
} from "@/lib/rules";
import { formatHours } from "@/lib/shifts";

export const metadata: Metadata = { title: "Statistikat" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const COLUMNS: { key: keyof Omit<EmployeeStats, "employeeId">; label: string; className?: string }[] = [
  { key: "totalHours", label: "Orë" },
  { key: "workDays", label: "Ditë pune" },
  { key: "morning", label: "Mëngjes", className: "text-emerald-600 dark:text-emerald-400" },
  { key: "afternoon", label: "Mbasdite", className: "text-sky-600 dark:text-sky-400" },
  { key: "night", label: "Natë", className: "text-violet-600 dark:text-violet-400" },
  { key: "weeklyOff", label: "Weekly OFF" },
  { key: "off", label: "OFF" },
  { key: "sickLeave", label: "Sick Leave", className: "text-red-600 dark:text-red-400" },
  { key: "annualLeave", label: "Pushim", className: "text-amber-600 dark:text-amber-400" },
];

export default async function StatsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const today = todayISO();
  const yearParam = Number(sp.year);
  const year =
    Number.isInteger(yearParam) && yearParam > 1999 && yearParam < 2101
      ? yearParam
      : Number(today.slice(0, 4));
  const monthParam = sp.month === "all" ? 0 : Number(sp.month ?? today.slice(5, 7));
  const month = Number.isInteger(monthParam) && monthParam >= 0 && monthParam <= 12 ? monthParam : 0;

  const from = month ? monthBounds(year, month).from : makeISO(year, 1, 1);
  const to = month ? monthBounds(year, month).to : makeISO(year, 12, 31);

  const [employees, shifts, entries] = await Promise.all([
    getEmployees(),
    getShifts(),
    getEntries(lookbackStart(from), to),
  ]);
  const shiftMap = new Map(shifts.map((s) => [s.id, s]));
  const withShift = entries.map((e) => ({
    ...e,
    shift: e.shiftId ? (shiftMap.get(e.shiftId) ?? null) : null,
  }));

  const stats = computeStats(withShift.filter((e) => e.date >= from));
  const warnings = computeWarnings(withShift).filter((w) => w.date >= from && w.date <= to);
  const warningCount = new Map<string, number>();
  for (const w of warnings) warningCount.set(w.employeeId, (warningCount.get(w.employeeId) ?? 0) + 1);

  const rows = employees
    .filter((e) => stats.has(e.id) || e.isActive)
    .map((e) => ({ employee: e, stats: stats.get(e.id) ?? emptyStats(e.id) }));
  const totals = rows.reduce((acc, r) => {
    for (const c of COLUMNS) acc[c.key] += r.stats[c.key];
    return acc;
  }, emptyStats("total"));
  const maxHours = Math.max(1, ...rows.map((r) => r.stats.totalHours));
  const periodLabel = month ? `${MONTH_NAMES[month - 1]} ${year}` : `Viti ${year}`;
  const exportHref = `/api/export/excel?year=${year}${month ? `&month=${month}` : ""}`;

  return (
    <>
      <PageHeader title="Statistikat" description={`${periodLabel} · ${formatDate(from)} – ${formatDate(to)}`}>
        <StatsFilters year={year} month={month} />
        <a href={exportHref} download className={buttonVariants({ variant: "outline" })}>
          Eksporto Excel
        </a>
      </PageHeader>

      <div className="flex flex-col gap-6 p-4 md:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={ClockIcon} label="Orë pune gjithsej" value={formatHours(totals.totalHours)} />
          <StatCard icon={UsersIcon} label="Punonjës me orar" value={String(stats.size)} />
          <StatCard icon={HeartPulseIcon} label="Ditë Sick Leave" value={String(totals.sickLeave)} />
          <StatCard icon={AlertTriangleIcon} label="Paralajmërime" value={String(warnings.length)} />
        </div>

        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Punonjësi</TableHead>
                {COLUMNS.map((c) => (
                  <TableHead key={c.key} className="text-right">
                    {c.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">⚠</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ employee, stats: s }) => (
                <TableRow key={employee.id}>
                  <TableCell className="min-w-44">
                    <div className="flex items-center gap-2 font-medium">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: employee.color }} />
                      <span className={employee.isActive ? "" : "text-muted-foreground"}>{employee.name}</span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-muted">
                      <div
                        className="h-1 rounded-full bg-primary/70"
                        style={{ width: `${(s.totalHours / maxHours) * 100}%` }}
                      />
                    </div>
                  </TableCell>
                  {COLUMNS.map((c) => (
                    <TableCell
                      key={c.key}
                      className={`text-right tabular-nums ${s[c.key] ? (c.className ?? "") : "text-muted-foreground/50"} ${c.key === "totalHours" ? "font-semibold" : ""}`}
                    >
                      {s[c.key] ? formatHours(s[c.key]) : "–"}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">
                    {warningCount.get(employee.id) ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">Gjithsej</TableCell>
                {COLUMNS.map((c) => (
                  <TableCell key={c.key} className="text-right font-semibold tabular-nums">
                    {formatHours(totals[c.key])}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular-nums">{warnings.length}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>

        {warnings.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Paralajmërimet ({warnings.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-x-6 gap-y-1.5 text-sm md:grid-cols-2">
                {warnings.slice(0, 200).map((w, i) => (
                  <li key={i} className="flex gap-2">
                    <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                    <span>
                      <b>{employees.find((e) => e.id === w.employeeId)?.name}</b>{" "}
                      <span className="text-muted-foreground">{formatDate(w.date)}</span> — {w.message}
                    </span>
                  </li>
                ))}
              </ul>
              {warnings.length > 200 && (
                <p className="mt-3 text-xs text-muted-foreground">Shfaqen 200 të parat.</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4" />
        </span>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
