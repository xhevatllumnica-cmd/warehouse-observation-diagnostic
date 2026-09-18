"use client";

import {
  AlertTriangleIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  EraserIcon,
  StickyNoteIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { STATUS_LABELS, WEEKDAY_NAMES, type EntryStatus } from "@/lib/constants";
import {
  addDays,
  formatDate,
  formatDayMonth,
  formatWeekday,
  isWeekend,
  weekdayIndex,
  type ISODate,
} from "@/lib/dates";
import { parseCellValue } from "@/lib/import/cell-value";
import type { ScheduleWarning } from "@/lib/rules";
import { formatHours, shiftHours } from "@/lib/shifts";
import {
  entryKey,
  type CellChange,
  type CellValue,
  type EmployeeDTO,
  type EntryDTO,
  type ShiftDTO,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { CellEditor, STATUS_HOTKEYS } from "./cell-editor";
import { cellClass, cellInlineStyle, cellLabel, cellTitle } from "./cell-format";

interface Pos {
  r: number;
  c: number;
}

interface Selection {
  anchor: Pos;
  focus: Pos;
}

export interface ScheduleGridProps {
  view: "month" | "week";
  days: ISODate[];
  today: ISODate;
  employees: EmployeeDTO[];
  shifts: ShiftDTO[];
  entries: Map<string, EntryDTO>;
  /** Paralajmërimet sipas `entryKey` (qeliza) dhe sipas punonjësit (javore). */
  cellWarnings: Map<string, ScheduleWarning[]>;
  rowWarnings: Map<string, ScheduleWarning[]>;
  /** `undefined` = furça joaktive; `null` = furça që pastron. */
  brush: CellValue | null | undefined;
  onApply: (changes: CellChange[]) => void;
  onUndo: () => void;
  onCopyPreviousWeek: (weekStart: ISODate) => void;
  onCopyWeek: (weekStart: ISODate) => void;
  onClearWeek: (weekStart: ISODate) => void;
}

const STATUS_BY_HOTKEY = Object.fromEntries(
  Object.entries(STATUS_HOTKEYS).map(([status, key]) => [key.toLowerCase(), status]),
) as Record<string, Exclude<EntryStatus, "working">>;

function rectOf(sel: Selection) {
  return {
    r0: Math.min(sel.anchor.r, sel.focus.r),
    r1: Math.max(sel.anchor.r, sel.focus.r),
    c0: Math.min(sel.anchor.c, sel.focus.c),
    c1: Math.max(sel.anchor.c, sel.focus.c),
  };
}

function toValue(entry: EntryDTO | undefined): CellValue | null {
  return entry ? { status: entry.status, shiftId: entry.shiftId } : null;
}

export function ScheduleGrid({
  view,
  days,
  today,
  employees,
  shifts,
  entries,
  cellWarnings,
  rowWarnings,
  brush,
  onApply,
  onUndo,
  onCopyPreviousWeek,
  onCopyWeek,
  onClearWeek,
}: ScheduleGridProps) {
  const compact = view === "month";
  const containerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editorAnchor, setEditorAnchor] = useState<DOMRect | null>(null);
  const [preview, setPreviewState] = useState<Map<string, CellValue | null>>(new Map());
  // Kopje në ref-e, që `mouseup` të lexojë vlerat e fundit pa side-effect në updater.
  const previewRef = useRef(preview);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const setPreview = (next: Map<string, CellValue | null>) => {
    previewRef.current = next;
    setPreviewState(next);
  };
  const drag = useRef<
    | { mode: "select" }
    | { mode: "paint"; value: CellValue | null }
    | null
  >(null);

  const shiftMap = useMemo(() => new Map(shifts.map((s) => [s.id, s])), [shifts]);
  const shiftByCode = useMemo(() => new Map(shifts.map((s) => [s.code, s])), [shifts]);
  const activeShifts = useMemo(() => shifts.filter((s) => s.isActive), [shifts]);
  const quickShifts = activeShifts.slice(0, 12);
  const otherShifts = activeShifts.slice(12);

  const weeks = useMemo(() => {
    const out: ISODate[] = [];
    for (const d of days) if (weekdayIndex(d) === 0) out.push(d);
    return out;
  }, [days]);

  const rect = selection ? rectOf(selection) : null;

  const selectedCells = useCallback((): { employeeId: string; date: ISODate }[] => {
    if (!rect) return [];
    const out = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        out.push({ employeeId: employees[r].id, date: days[c] });
      }
    }
    return out;
  }, [rect, employees, days]);

  const cellEl = (p: Pos) =>
    containerRef.current?.querySelector<HTMLElement>(`[data-r="${p.r}"][data-c="${p.c}"]`) ?? null;

  const openEditor = (p: Pos) => {
    const el = cellEl(p);
    if (el) setEditorAnchor(el.getBoundingClientRect());
  };

  const closeEditor = useCallback(() => {
    setEditorAnchor(null);
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const applyToSelection = (value: CellValue | null) => {
    const cells = selectedCells();
    if (cells.length === 0) return;
    onApply(cells.map((c) => ({ ...c, value })));
  };

  // ---- Mausi -------------------------------------------------------------

  const posFromEvent = (e: React.MouseEvent): Pos | null => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("[data-r]");
    if (!td) return null;
    return { r: Number(td.dataset.r), c: Number(td.dataset.c) };
  };

  const paint = (p: Pos, value: CellValue | null) => {
    setPreview(new Map(previewRef.current).set(entryKey(employees[p.r].id, days[p.c]), value));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = posFromEvent(e);
    if (!p) return;
    e.preventDefault();
    containerRef.current?.focus({ preventScroll: true });
    setEditorAnchor(null);

    if (brush !== undefined || e.altKey) {
      // Furça, ose Alt+tërheqje që kopjon vlerën e kësaj qelize.
      const value =
        brush !== undefined ? brush : toValue(entries.get(entryKey(employees[p.r].id, days[p.c])));
      drag.current = { mode: "paint", value };
      setSelection({ anchor: p, focus: p });
      if (brush !== undefined) paint(p, value);
      return;
    }

    if (e.shiftKey && selection) {
      setSelection({ anchor: selection.anchor, focus: p });
      drag.current = { mode: "select" };
      return;
    }
    setSelection({ anchor: p, focus: p });
    drag.current = { mode: "select" };
  };

  const onMouseOver = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = posFromEvent(e);
    if (!p) return;
    if (d.mode === "paint") {
      paint(p, d.value);
      setSelection((s) => (s ? { anchor: s.anchor, focus: p } : s));
    } else {
      setSelection((s) =>
        !s || (s.focus.r === p.r && s.focus.c === p.c) ? s : { anchor: s.anchor, focus: p },
      );
    }
  };

  const openEditorRef = useRef(openEditor);
  openEditorRef.current = openEditor;

  useEffect(() => {
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.mode === "paint") {
        const painted = previewRef.current;
        previewRef.current = new Map();
        setPreviewState(previewRef.current);
        if (painted.size > 0) {
          onApply(
            [...painted].map(([key, value]) => {
              const [employeeId, date] = key.split("|");
              return { employeeId, date, value };
            }),
          );
        }
      } else if (selectionRef.current) {
        openEditorRef.current(selectionRef.current.focus);
      }
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [onApply]);

  // Alt+tërheqje: vlera kopjohet në zonën e përzgjedhur kur lëshohet mausi.
  // (Trajtohet njësoj si furça, me pamje paraprake.)
  useEffect(() => {
    const d = drag.current;
    if (d?.mode === "paint" && brush === undefined && selection) {
      const r = rectOf(selection);
      const next = new Map<string, CellValue | null>();
      for (let i = r.r0; i <= r.r1; i++)
        for (let j = r.c0; j <= r.c1; j++) next.set(entryKey(employees[i].id, days[j]), d.value);
      setPreview(next);
    }
  }, [selection, brush, employees, days]);

  // ---- Tastiera ----------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      onUndo();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (employees.length && days.length) {
        setSelection({ anchor: { r: 0, c: 0 }, focus: { r: employees.length - 1, c: days.length - 1 } });
      }
      return;
    }
    if (!selection) {
      if (e.key.startsWith("Arrow") && employees.length) {
        e.preventDefault();
        setSelection({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
      }
      return;
    }

    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    if (e.key in moves) {
      e.preventDefault();
      const [dr, dc] = moves[e.key];
      const f = selection.focus;
      const next = {
        r: Math.min(employees.length - 1, Math.max(0, f.r + dr)),
        c: Math.min(days.length - 1, Math.max(0, f.c + dc)),
      };
      const extend = e.shiftKey && e.key !== "Tab";
      setSelection({ anchor: extend ? selection.anchor : next, focus: next });
      setEditorAnchor(null);
      cellEl(next)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }

    if (e.key === "Escape") {
      if (editorAnchor) closeEditor();
      else setSelection(null);
      return;
    }
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      openEditor(selection.focus);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      applyToSelection(null);
      return;
    }
    if (mod || e.altKey) return;

    if (/^[1-9]$/.test(e.key)) {
      const shift = quickShifts[Number(e.key) - 1];
      if (shift) {
        e.preventDefault();
        applyToSelection({ status: "working", shiftId: shift.id });
        setEditorAnchor(null);
      }
      return;
    }
    const status = STATUS_BY_HOTKEY[e.key.toLowerCase()];
    if (status) {
      e.preventDefault();
      applyToSelection({ status, shiftId: null });
      setEditorAnchor(null);
    }
  };

  // ---- Clipboard (përputhet me Excel: tekst i ndarë me TAB) --------------

  const onCopy = (e: React.ClipboardEvent) => {
    if (!rect || (e.target as HTMLElement).tagName === "INPUT") return;
    e.preventDefault();
    const lines: string[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const row: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        const entry = entries.get(entryKey(employees[r].id, days[c]));
        row.push(entry ? cellLabel(entry, shiftMap, false) : "");
      }
      lines.push(row.join("\t"));
    }
    e.clipboardData.setData("text/plain", lines.join("\n"));
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!selection || (e.target as HTMLElement).tagName === "INPUT") return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\r/g, "").replace(/\n$/, "");
    if (!text) return;

    const toCell = (raw: string): CellValue | null | undefined => {
      if (!raw.trim()) return null;
      const label = Object.entries(STATUS_LABELS).find(([, l]) => l === raw.trim());
      if (label && label[0] !== "working") return { status: label[0] as EntryStatus, shiftId: null };
      const parsed = parseCellValue(raw);
      if (!parsed) return undefined;
      if (parsed.status !== "working") return { status: parsed.status, shiftId: null };
      const shift = shiftByCode.get(parsed.shiftCode!);
      return shift ? { status: "working", shiftId: shift.id } : undefined;
    };

    const grid = text.split("\n").map((line) => line.split("\t").map(toCell));
    const r = rectOf(selection);
    const single = grid.length === 1 && grid[0].length === 1;
    // Një vlerë e vetme mbush të gjithë zonën; përndryshe ngjitet si bllok.
    const rows = single ? r.r1 - r.r0 + 1 : grid.length;
    const unknown = grid.flat().filter((v) => v === undefined).length;
    const changes: CellChange[] = [];

    for (let i = 0; i < rows; i++) {
      const cols = single ? r.c1 - r.c0 + 1 : grid[i].length;
      for (let j = 0; j < cols; j++) {
        const rr = r.r0 + i;
        const cc = r.c0 + j;
        if (rr >= employees.length || cc >= days.length) continue;
        const value = single ? grid[0][0] : grid[i][j];
        if (value === undefined) continue;
        changes.push({ employeeId: employees[rr].id, date: days[cc], value });
      }
    }
    if (changes.length) onApply(changes);
    if (unknown > 0) {
      toast.warning(`${unknown} vlera nuk u njohën dhe u anashkaluan (shift-e që nuk ekzistojnë?).`);
    }
  };

  // ---- Llogaritjet për rreshtat dhe ditët --------------------------------

  const rowTotals = useMemo(
    () =>
      employees.map((emp) => {
        let hours = 0;
        let workDays = 0;
        let off = 0;
        for (const d of days) {
          const entry = entries.get(entryKey(emp.id, d));
          if (!entry) continue;
          if (entry.status === "working") {
            workDays++;
            const s = entry.shiftId ? shiftMap.get(entry.shiftId) : undefined;
            if (s) hours += shiftHours(s.startTime, s.endTime);
          } else if (entry.status !== "weekly_off") off++;
        }
        return { hours, workDays, off };
      }),
    [employees, days, entries, shiftMap],
  );

  const coverage = useMemo(
    () =>
      days.map((d) => {
        const c = { morning: 0, afternoon: 0, night: 0, total: 0 };
        for (const emp of employees) {
          const entry = entries.get(entryKey(emp.id, d));
          if (entry?.status !== "working" || !entry.shiftId) continue;
          const s = shiftMap.get(entry.shiftId);
          if (!s) continue;
          c[s.category]++;
          c.total++;
        }
        return c;
      }),
    [days, employees, entries, shiftMap],
  );

  // ---- Paneli i editimit -------------------------------------------------

  let editor: React.ReactNode = null;
  if (editorAnchor && selection && rect) {
    const count = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
    const emp = employees[selection.focus.r];
    const day = days[selection.focus.c];
    const current = count === 1 ? (entries.get(entryKey(emp.id, day)) ?? null) : null;
    editor = (
      <CellEditor
        key={count === 1 ? entryKey(emp.id, day) : `multi-${count}`}
        anchor={editorAnchor}
        title={count === 1 ? emp.name : `${count} qeliza të përzgjedhura`}
        subtitle={
          count === 1
            ? `${WEEKDAY_NAMES[weekdayIndex(day)]}, ${formatDate(day)}`
            : `${rect.r1 - rect.r0 + 1} punonjës × ${rect.c1 - rect.c0 + 1} ditë`
        }
        current={current}
        quickShifts={quickShifts}
        otherShifts={otherShifts}
        allowNotes={count === 1}
        onApply={(value) => {
          applyToSelection(value);
          if (!value || value.notes === undefined) closeEditor();
        }}
        onClose={closeEditor}
      />
    );
  }

  const cellWidth = compact ? "min-w-[3.25rem]" : "min-w-[7.5rem]";

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onPaste={onPaste}
      onScroll={() => editorAnchor && setEditorAnchor(null)}
      className={cn(
        "scrollbar-thin relative max-h-[calc(100dvh-11rem)] overflow-auto rounded-xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        brush !== undefined && "cursor-crosshair",
      )}
      aria-label="Orari i punës. Përdorni shigjetat për të lëvizur dhe Enter për të ndryshuar."
    >
      <table
        role="grid"
        aria-rowcount={employees.length}
        className="w-max border-separate border-spacing-0 text-xs select-none"
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
      >
        <thead className="sticky top-0 z-20">
          <tr>
            <th
              rowSpan={2}
              className="sticky left-0 z-30 min-w-40 border-r border-b bg-muted px-3 text-left align-bottom font-medium"
            >
              <span className="block pb-2">Punonjësi</span>
            </th>
            {weeks.map((w) => (
              <th
                key={w}
                colSpan={7}
                className="border-b border-l-2 border-l-border bg-muted px-2 py-1 text-left font-medium"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted-foreground">
                    Java {formatDayMonth(w)} – {formatDayMonth(addDays(w, 6))}
                  </span>
                  <WeekMenu
                    onCopyPrevious={() => onCopyPreviousWeek(w)}
                    onCopy={() => onCopyWeek(w)}
                    onClear={() => onClearWeek(w)}
                  />
                </div>
              </th>
            ))}
            <th rowSpan={2} className="border-b border-l-2 bg-muted px-2 align-bottom font-medium">
              <span className="block pb-2" title="Orët e punës në periudhën e shfaqur">
                Orë
              </span>
            </th>
            <th rowSpan={2} className="border-b border-l bg-muted px-2 align-bottom font-medium">
              <span className="block pb-2" title="Ditë pune / ditë OFF, Sick Leave ose pushim">
                Ditë
              </span>
            </th>
          </tr>
          <tr>
            {days.map((d) => (
              <th
                key={d}
                className={cn(
                  "border-b bg-muted px-1 py-1 text-center font-normal",
                  cellWidth,
                  weekdayIndex(d) === 0 && "border-l-2 border-l-border",
                  isWeekend(d) && "bg-muted/60 dark:bg-muted/80",
                  d === today && "bg-primary text-primary-foreground dark:bg-primary",
                )}
              >
                <span className="block text-[10px] uppercase opacity-70">
                  {compact ? formatWeekday(d) : WEEKDAY_NAMES[weekdayIndex(d)]}
                </span>
                <span className="font-medium tabular-nums">{formatDayMonth(d)}</span>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {employees.map((emp, r) => {
            const warnings = rowWarnings.get(emp.id);
            const totals = rowTotals[r];
            return (
              <tr key={emp.id} className="group">
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-r border-b bg-card px-3 py-1 text-left font-medium group-hover:bg-muted"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="h-5 w-1 shrink-0 rounded-full"
                      style={{ backgroundColor: emp.color }}
                      aria-hidden
                    />
                    <span className={cn("truncate", !emp.isActive && "text-muted-foreground line-through")}>
                      {emp.name}
                    </span>
                    {warnings && (
                      <span
                        title={warnings.map((w) => w.message).join("\n")}
                        className="ml-auto text-amber-500"
                      >
                        <AlertTriangleIcon className="size-3.5" />
                        <span className="sr-only">{warnings.length} paralajmërime</span>
                      </span>
                    )}
                  </div>
                </th>
                {days.map((d, c) => {
                  const key = entryKey(emp.id, d);
                  const previewValue = preview.get(key);
                  const entry =
                    previewValue !== undefined
                      ? previewValue && { ...previewValue, employeeId: emp.id, date: d, notes: null }
                      : entries.get(key);
                  const inSel = rect && r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
                  const warn = cellWarnings.get(key);
                  return (
                    <GridCell
                      key={d}
                      r={r}
                      c={c}
                      label={cellLabel(entry, shiftMap, compact)}
                      title={`${emp.name} · ${formatDate(d)}\n${cellTitle(entry, shiftMap)}${
                        entry?.notes ? `\nShënim: ${entry.notes}` : ""
                      }${warn ? `\n⚠ ${warn.map((w) => w.message).join("\n⚠ ")}` : ""}`}
                      className={cn(cellClass(entry, shiftMap), cellWidth)}
                      style={cellInlineStyle(entry, shiftMap)}
                      selected={Boolean(inSel)}
                      focused={selection?.focus.r === r && selection.focus.c === c}
                      weekStart={weekdayIndex(d) === 0}
                      weekend={isWeekend(d)}
                      today={d === today}
                      warning={Boolean(warn)}
                      note={Boolean(entry?.notes)}
                      preview={previewValue !== undefined}
                    />
                  );
                })}
                <td className="border-b border-l-2 px-2 text-right font-semibold tabular-nums">
                  {totals.hours ? formatHours(totals.hours) : "–"}
                </td>
                <td className="border-b border-l px-2 text-center text-muted-foreground tabular-nums">
                  {totals.workDays}
                  {totals.off > 0 && <span className="text-red-500"> / {totals.off}</span>}
                </td>
              </tr>
            );
          })}
          {employees.length === 0 && (
            <tr>
              <td colSpan={days.length + 3} className="px-4 py-10 text-center text-muted-foreground">
                Nuk ka punonjës për t&apos;u shfaqur. Shtoni punonjës te faqja “Punonjësit”.
              </td>
            </tr>
          )}
        </tbody>

        <tfoot className="sticky bottom-0 z-20">
          <tr>
            <th className="sticky left-0 z-30 border-t border-r bg-muted px-3 py-1.5 text-left font-medium">
              Në punë
            </th>
            {coverage.map((c, i) => (
              <td
                key={days[i]}
                title={`Mëngjes: ${c.morning}\nMbasdite: ${c.afternoon}\nNatë: ${c.night}`}
                className={cn(
                  "border-t bg-muted px-1 py-1.5 text-center tabular-nums",
                  weekdayIndex(days[i]) === 0 && "border-l-2 border-l-border",
                )}
              >
                <span className="font-semibold">{c.total}</span>
                {!compact && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground">
                    <span className="text-emerald-600 dark:text-emerald-400">{c.morning}</span>
                    {" · "}
                    <span className="text-sky-600 dark:text-sky-400">{c.afternoon}</span>
                    {" · "}
                    <span className="text-violet-600 dark:text-violet-400">{c.night}</span>
                  </span>
                )}
              </td>
            ))}
            <td className="border-t border-l-2 bg-muted px-2 text-right font-semibold tabular-nums">
              {formatHours(rowTotals.reduce((s, t) => s + t.hours, 0))}
            </td>
            <td className="border-t border-l bg-muted" />
          </tr>
        </tfoot>
      </table>
      {editor}
    </div>
  );
}

interface GridCellProps {
  r: number;
  c: number;
  label: string;
  title: string;
  className: string;
  style?: React.CSSProperties;
  selected: boolean;
  focused: boolean;
  weekStart: boolean;
  weekend: boolean;
  today: boolean;
  warning: boolean;
  note: boolean;
  preview: boolean;
}

const GridCell = memo(function GridCell({
  r,
  c,
  label,
  title,
  className,
  style,
  selected,
  focused,
  weekStart,
  weekend,
  today,
  warning,
  note,
  preview,
}: GridCellProps) {
  return (
    <td
      data-r={r}
      data-c={c}
      role="gridcell"
      aria-selected={selected}
      title={title}
      className={cn(
        "relative h-8 border-b p-0.5",
        weekStart && "border-l-2 border-l-border",
        weekend && !label && "bg-muted/40",
        today && "bg-primary/5",
      )}
    >
      <div
        style={style}
        className={cn(
          "flex h-full items-center justify-center rounded-md border border-transparent px-1 font-mono text-[11px] font-medium whitespace-nowrap transition-colors",
          !label && "hover:border-border hover:bg-muted/60",
          className,
          selected && "ring-2 ring-primary/50 ring-inset",
          focused && "ring-2 ring-primary ring-inset",
          preview && "opacity-70",
        )}
      >
        {label}
      </div>
      {warning && (
        <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-amber-500" aria-hidden />
      )}
      {note && (
        <StickyNoteIcon className="absolute bottom-0.5 left-0.5 size-2.5 text-foreground/40" aria-hidden />
      )}
    </td>
  );
});

function WeekMenu({
  onCopyPrevious,
  onCopy,
  onClear,
}: {
  onCopyPrevious: () => void;
  onCopy: () => void;
  onClear: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label="Veprime për javën" />}
      >
        <EllipsisVerticalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={onCopyPrevious}>
          <CopyIcon />
          Kopjo nga java e kaluar
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopy}>
          <CopyIcon />
          Kopjo këtë javë te…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onClear}>
          <EraserIcon />
          Pastro javën
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
