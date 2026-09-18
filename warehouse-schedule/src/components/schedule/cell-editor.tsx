"use client";

import { EraserIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NON_WORKING_STATUSES, STATUS_LABELS } from "@/lib/constants";
import { CELL_STYLES } from "@/lib/shifts";
import type { CellValue, EntryDTO, ShiftDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { compactCode } from "./cell-format";

export const STATUS_HOTKEYS = {
  weekly_off: "W",
  off: "O",
  sick_leave: "S",
  annual_leave: "P",
} as const;

interface CellEditorProps {
  anchor: DOMRect;
  title: string;
  subtitle?: string;
  /** Hyrja aktuale (vetëm kur është zgjedhur një qelizë). */
  current: EntryDTO | null;
  quickShifts: ShiftDTO[];
  otherShifts: ShiftDTO[];
  allowNotes: boolean;
  onApply: (value: CellValue | null) => void;
  onClose: () => void;
}

const WIDTH = 320;

/**
 * Panel i vogël që hapet pranë qelizës. Nuk përdor Popover për çdo qelizë
 * (qindra qeliza), por një panel të vetëm të pozicionuar me `position: fixed`.
 */
export function CellEditor({
  anchor,
  title,
  subtitle,
  current,
  quickShifts,
  otherShifts,
  allowNotes,
  onApply,
  onClose,
}: CellEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 4, left: anchor.left });
  const [notes, setNotes] = useState(current?.notes ?? "");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = anchor.bottom + 4;
    if (top + h > vh - 8) top = Math.max(8, anchor.top - h - 4);
    let left = anchor.left;
    if (left + WIDTH > vw - 8) left = Math.max(8, vw - WIDTH - 8);
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // `setTimeout` që klikimi që hapi panelin të mos e mbyllë menjëherë.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown));
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const saveNotes = () => {
    if (!current) return;
    onApply({ status: current.status, shiftId: current.shiftId, notes: notes.trim() || null });
  };

  const shiftButton = (shift: ShiftDTO, hotkey?: number) => {
    const selected = current?.status === "working" && current.shiftId === shift.id;
    return (
      <button
        key={shift.id}
        type="button"
        title={shift.label !== shift.code ? shift.label : undefined}
        onClick={() => onApply({ status: "working", shiftId: shift.id })}
        style={shift.color ? { backgroundColor: shift.color, color: "#0f172a" } : undefined}
        className={cn(
          "relative rounded-md border px-1.5 py-1.5 font-mono text-xs font-medium transition hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:hover:brightness-125",
          CELL_STYLES[shift.category],
          selected && "ring-2 ring-foreground",
        )}
      >
        {compactCode(shift.code)}
        {hotkey !== undefined && (
          <span className="absolute top-0 right-0.5 text-[9px] opacity-50">{hotkey}</span>
        )}
      </button>
    );
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Ndrysho ${title}`}
      style={{ top: pos.top, left: pos.left, width: WIDTH }}
      className="fixed z-50 flex flex-col gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Mbyll">
          <XIcon />
        </Button>
      </div>

      <section>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Shift-et</p>
        <div className="grid grid-cols-4 gap-1.5">
          {quickShifts.map((s, i) => shiftButton(s, i < 9 ? i + 1 : undefined))}
        </div>
        {otherShifts.length > 0 && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Shift-e të tjera ({otherShifts.length})
            </summary>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">{otherShifts.map((s) => shiftButton(s))}</div>
          </details>
        )}
      </section>

      <section>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Statusi</p>
        <div className="grid grid-cols-2 gap-1.5">
          {NON_WORKING_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => onApply({ status, shiftId: null })}
              className={cn(
                "flex items-center justify-between rounded-md border px-2 py-1.5 text-xs font-medium transition hover:brightness-95 dark:hover:brightness-125",
                CELL_STYLES[status],
                current?.status === status && "ring-2 ring-foreground",
              )}
            >
              {STATUS_LABELS[status]}
              <kbd className="text-[10px] opacity-50">{STATUS_HOTKEYS[status]}</kbd>
            </button>
          ))}
        </div>
      </section>

      {allowNotes && current && (
        <section>
          <label htmlFor="cell-notes" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Shënim
          </label>
          <div className="flex gap-1.5">
            <input
              id="cell-notes"
              value={notes}
              maxLength={500}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") saveNotes();
              }}
              placeholder="p.sh. zëvendëson Arianin"
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={saveNotes}
              disabled={(current.notes ?? "") === notes.trim()}
            >
              Ruaj
            </Button>
          </div>
        </section>
      )}

      <div className="flex items-center justify-between border-t pt-2">
        <span className="text-[11px] text-muted-foreground">
          <kbd>1–9</kbd> shift · <kbd>Del</kbd> pastro · <kbd>Esc</kbd> mbyll
        </span>
        <Button variant="ghost" size="sm" onClick={() => onApply(null)}>
          <EraserIcon />
          Pastro
        </Button>
      </div>
    </div>
  );
}
