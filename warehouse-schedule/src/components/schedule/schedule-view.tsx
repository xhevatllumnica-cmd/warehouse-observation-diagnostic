"use client";

import {
  AlertTriangleIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileDownIcon,
  FileSpreadsheetIcon,
  Loader2Icon,
  PaintbrushIcon,
  SearchIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { clearWeek } from "@/app/actions/schedule";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { MONTH_NAMES, NON_WORKING_STATUSES, STATUS_LABELS } from "@/lib/constants";
import {
  addDays,
  formatDate,
  formatMonthYear,
  formatWeekRange,
  isISODate,
  startOfWeek,
  type ISODate,
} from "@/lib/dates";
import { computeWarnings, type ScheduleWarning } from "@/lib/rules";
import { CELL_STYLES } from "@/lib/shifts";
import { entryKey, type CellValue, type EmployeeDTO, type EntryDTO, type ShiftDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { cellLabel, compactCode } from "./cell-format";
import { CopyWeekDialog, type CopyWeekRequest } from "./copy-week-dialog";
import { Legend } from "./legend";
import { exportSchedulePdf } from "./pdf-export";
import { ScheduleGrid } from "./schedule-grid";
import { useScheduleEntries } from "./use-schedule-entries";

export interface ScheduleViewProps {
  view: "month" | "week";
  year: number;
  month: number;
  weekStart: ISODate;
  /** Javët e shfaqura (E Hëna e secilës). */
  weeks: ISODate[];
  today: ISODate;
  years: number[];
  employees: EmployeeDTO[];
  shifts: ShiftDTO[];
  /** Hyrjet për javët e shfaqura + disa ditë më parë (për rregullat). */
  entries: EntryDTO[];
}

export function ScheduleView(props: ScheduleViewProps) {
  const { view, year, month, weekStart, weeks, today, years, shifts } = props;
  const router = useRouter();
  const [isNavigating, startNavigation] = useTransition();
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [brush, setBrush] = useState<CellValue | null | undefined>(undefined);
  const [copyRequest, setCopyRequest] = useState<CopyWeekRequest | null>(null);
  const [clearTarget, setClearTarget] = useState<ISODate | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);

  const employeeNames = useMemo(
    () => new Map(props.employees.map((e) => [e.id, e.name])),
    [props.employees],
  );
  const { entries, apply, undo, saving } = useScheduleEntries(props.entries, employeeNames);

  const days = useMemo(
    () => weeks.flatMap((w) => Array.from({ length: 7 }, (_, i) => addDays(w, i))),
    [weeks],
  );
  const from = days[0];
  const to = days[days.length - 1];
  const shiftMap = useMemo(() => new Map(shifts.map((s) => [s.id, s])), [shifts]);

  // Punonjësit në grid: aktivët + joaktivët me orar në këtë periudhë.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.employees.filter((e) => {
      if (q && !e.name.toLowerCase().includes(q)) return false;
      if (e.isActive) return true;
      return showInactive && days.some((d) => entries.has(entryKey(e.id, d)));
    });
  }, [props.employees, query, showInactive, days, entries]);

  // ---- Paralajmërimet ----------------------------------------------------

  const warnings = useMemo(() => {
    const list = computeWarnings(
      [...entries.values()].map((e) => ({
        ...e,
        shift: e.shiftId ? (shiftMap.get(e.shiftId) ?? null) : null,
      })),
    ).filter((w) => w.date >= from && w.date <= to);
    const cell = new Map<string, ScheduleWarning[]>();
    const row = new Map<string, ScheduleWarning[]>();
    for (const w of list) {
      const target = w.type === "weekly_hours" ? row : cell;
      const key = w.type === "weekly_hours" ? w.employeeId : entryKey(w.employeeId, w.date);
      target.set(key, [...(target.get(key) ?? []), w]);
    }
    return { list, cell, row };
  }, [entries, shiftMap, from, to]);

  // ---- Navigimi ----------------------------------------------------------

  const go = useCallback(
    (params: Record<string, string | number>) => {
      const search = new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      );
      startNavigation(() => router.push(`/orari?${search}`));
    },
    [router],
  );

  const goMonth = (y: number, m: number) => go({ view: "month", year: y, month: m });
  const goWeek = (w: ISODate) => go({ view: "week", week: w });

  const step = (dir: -1 | 1) => {
    if (view === "week") return goWeek(addDays(weekStart, dir * 7));
    const m = month + dir;
    goMonth(m < 1 ? year - 1 : m > 12 ? year + 1 : year, ((m + 11) % 12) + 1);
  };

  const title = view === "month" ? formatMonthYear(year, month) : `Java ${formatWeekRange(weekStart)}`;

  // ---- Veprimet e javës --------------------------------------------------

  const confirmClear = async () => {
    if (!clearTarget) return;
    const res = await clearWeek({ weekStart: clearTarget });
    setClearTarget(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Java u pastrua (${res.data.removed} qeliza).`);
    router.refresh();
  };

  const exportPdf = async () => {
    const id = toast.loading("Po gjenerohet PDF…");
    try {
      await exportSchedulePdf({
        title: view === "month" ? `Orari – ${title}` : `Orari – ${formatWeekRange(weekStart)}`,
        weeks,
        employees: rows,
        shifts,
        entries,
        fileName:
          view === "month"
            ? `Orari ${MONTH_NAMES[month - 1]} ${year}.pdf`
            : `Orari java ${weekStart}.pdf`,
      });
      toast.success("PDF u shkarkua.", { id });
    } catch (err) {
      console.error(err);
      toast.error("PDF nuk u gjenerua.", { id });
    }
  };

  const brushLabel =
    brush === undefined ? null : brush === null ? "Pastro" : cellLabel(brush, shiftMap, false);

  return (
    <div className="flex flex-col gap-3 p-4 md:p-6">
      {/* Rreshti 1: titulli dhe navigimi */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => step(-1)} aria-label="Periudha e kaluar">
            <ChevronLeftIcon />
          </Button>
          <Button variant="outline" size="icon" onClick={() => step(1)} aria-label="Periudha e ardhshme">
            <ChevronRightIcon />
          </Button>
          <h1 className="ml-1 text-xl font-semibold tracking-tight">{title}</h1>
          {(isNavigating || saving) && (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-label="Duke ngarkuar" />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label="Pamja">
            {(["month", "week"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() =>
                  v === "month"
                    ? goMonth(year, month)
                    : goWeek(
                        weeks.includes(startOfWeek(today)) ? startOfWeek(today) : weeks[0],
                      )
                }
                className={cn(
                  "rounded-md px-3 py-1 text-sm transition-colors",
                  view === v ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
              >
                {v === "month" ? "Muaji" : "Java"}
              </button>
            ))}
          </div>

          {view === "month" ? (
            <>
              <NativeSelect
                aria-label="Muaji"
                value={month}
                onChange={(e) => goMonth(year, Number(e.target.value))}
              >
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="Viti"
                value={year}
                onChange={(e) => goMonth(Number(e.target.value), month)}
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </NativeSelect>
            </>
          ) : (
            <Input
              type="date"
              aria-label="Zgjidh javën"
              className="w-40"
              value={weekStart}
              onChange={(e) => isISODate(e.target.value) && goWeek(startOfWeek(e.target.value))}
            />
          )}

          <Button
            variant="outline"
            onClick={() =>
              view === "week"
                ? goWeek(startOfWeek(today))
                : go({ view: "month" }) /* muaji aktual llogaritet në server */
            }
          >
            <CalendarIcon />
            Sot
          </Button>
        </div>
      </div>

      {/* Rreshti 2: veglat */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Kërko punonjës…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-44 pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={showInactive} onCheckedChange={(v) => setShowInactive(Boolean(v))} />
          Joaktivët
        </label>

        <div className="mx-1 hidden h-6 w-px bg-border sm:block" />

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant={brush !== undefined ? "default" : "outline"} />}>
            <PaintbrushIcon />
            {brushLabel ? `Furça: ${brushLabel}` : "Furça"}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Zgjidh vlerën, pastaj kliko/tërhiq mbi qeliza</DropdownMenuLabel>
            </DropdownMenuGroup>
            <div className="grid grid-cols-3 gap-1 p-1">
              {shifts
                .filter((s) => s.isActive)
                .map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => setBrush({ status: "working", shiftId: s.id })}
                    className={cn("justify-center font-mono text-xs", CELL_STYLES[s.category])}
                  >
                    {compactCode(s.code)}
                  </DropdownMenuItem>
                ))}
            </div>
            <DropdownMenuSeparator />
            <div className="grid grid-cols-2 gap-1 p-1">
              {NON_WORKING_STATUSES.map((status) => (
                <DropdownMenuItem
                  key={status}
                  onClick={() => setBrush({ status, shiftId: null })}
                  className={cn("justify-center text-xs", CELL_STYLES[status])}
                >
                  {STATUS_LABELS[status]}
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setBrush(null)}>Furça që pastron</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {brush !== undefined && (
          <Button variant="ghost" size="icon" onClick={() => setBrush(undefined)} aria-label="Çaktivizo furçën">
            <XIcon />
          </Button>
        )}

        <Button variant="outline" onClick={undo} title="Zhbëj (Ctrl+Z)">
          <Undo2Icon />
          Zhbëj
        </Button>

        <Button
          variant="outline"
          onClick={() => {
            const target =
              view === "week"
                ? weekStart
                : weeks.includes(startOfWeek(today))
                  ? startOfWeek(today)
                  : weeks[0];
            setCopyRequest({ source: addDays(target, -7), target });
          }}
        >
          <CopyIcon />
          Kopjo javë
        </Button>

        <Button
          variant={warnings.list.length ? "outline" : "ghost"}
          onClick={() => setWarningsOpen(true)}
          className={cn(warnings.list.length > 0 && "border-amber-500/50 text-amber-600 dark:text-amber-400")}
        >
          <AlertTriangleIcon />
          {warnings.list.length} paralajmërime
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <FileSpreadsheetIcon />
              Excel
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                render={<a href={`/api/export/excel?year=${year}&month=${month}`} download />}
              >
                {formatMonthYear(year, month)}
              </DropdownMenuItem>
              <DropdownMenuItem render={<a href={`/api/export/excel?year=${year}`} download />}>
                I gjithë viti {year}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={exportPdf}>
            <FileDownIcon />
            PDF
          </Button>
        </div>
      </div>

      <ScheduleGrid
        view={view}
        days={days}
        today={today}
        employees={rows}
        shifts={shifts}
        entries={entries}
        cellWarnings={warnings.cell}
        rowWarnings={warnings.row}
        brush={brush}
        onApply={apply}
        onUndo={undo}
        onCopyPreviousWeek={(w) => setCopyRequest({ source: addDays(w, -7), target: w })}
        onCopyWeek={(w) => setCopyRequest({ source: w, target: addDays(w, 7) })}
        onClearWeek={setClearTarget}
      />

      <Legend />

      <CopyWeekDialog request={copyRequest} onClose={() => setCopyRequest(null)} />

      <AlertDialog open={clearTarget !== null} onOpenChange={(open) => !open && setClearTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pastro javën?</AlertDialogTitle>
            <AlertDialogDescription>
              Do të fshihen të gjitha qelizat e javës {clearTarget && formatWeekRange(clearTarget)} për
              të gjithë punonjësit. Veprimi nuk mund të zhbëhet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anulo</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmClear}>
              Pastro
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={warningsOpen} onOpenChange={setWarningsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Paralajmërimet</DialogTitle>
            <DialogDescription>
              Rregullat: pushim minimal mes shift-eve, ditë radhazi, orë javore, shift-e të gjata dhe
              ditë OFF. Pragjet ndryshohen te <code>src/lib/constants.ts</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {warnings.list.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Asnjë paralajmërim. 👍</p>
            ) : (
              <ul className="divide-y text-sm">
                {warnings.list
                  .slice()
                  .sort(
                    (a, b) =>
                      (employeeNames.get(a.employeeId) ?? "").localeCompare(
                        employeeNames.get(b.employeeId) ?? "",
                      ) || a.date.localeCompare(b.date),
                  )
                  .map((w, i) => (
                    <li key={i} className="flex items-start gap-3 py-2">
                      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
                      <div className="min-w-0">
                        <p className="font-medium">
                          {employeeNames.get(w.employeeId)}{" "}
                          <span className="font-normal text-muted-foreground">· {formatDate(w.date)}</span>
                        </p>
                        <p className="text-muted-foreground">{w.message}</p>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {view === "week" && (
        <p className="text-xs text-muted-foreground">
          Java i përket muajit{" "}
          <Link className={buttonVariants({ variant: "link", size: "xs" })} href={`/orari?view=month&year=${year}&month=${month}`}>
            {formatMonthYear(year, month)}
          </Link>
        </p>
      )}
    </div>
  );
}
