import { STATUS_LABELS, STATUS_SHORT } from "@/lib/constants";
import { CELL_STYLES, styleKey } from "@/lib/shifts";
import type { CellValue, EntryDTO, ShiftDTO } from "@/lib/types";

/** "07:00-15:00" → "07-15" (për qelizat e ngushta të pamjes mujore). */
export function compactCode(code: string): string {
  return code.replace(/:00/g, "");
}

export function cellLabel(
  entry: Pick<EntryDTO, "status" | "shiftId"> | null | undefined,
  shifts: Map<string, ShiftDTO>,
  compact: boolean,
): string {
  if (!entry) return "";
  if (entry.status === "working") {
    const shift = entry.shiftId ? shifts.get(entry.shiftId) : undefined;
    if (!shift) return "?";
    return compact ? compactCode(shift.code) : shift.code;
  }
  return compact ? STATUS_SHORT[entry.status] : STATUS_LABELS[entry.status];
}

export function cellTitle(
  entry: Pick<EntryDTO, "status" | "shiftId"> | null | undefined,
  shifts: Map<string, ShiftDTO>,
): string {
  if (!entry) return "Bosh";
  if (entry.status === "working") {
    const shift = entry.shiftId ? shifts.get(entry.shiftId) : undefined;
    return shift ? (shift.label !== shift.code ? `${shift.label} (${shift.code})` : shift.code) : "Shift i panjohur";
  }
  return STATUS_LABELS[entry.status];
}

export function cellClass(
  entry: Pick<EntryDTO, "status" | "shiftId"> | null | undefined,
  shifts: Map<string, ShiftDTO>,
): string {
  if (!entry) return "";
  const shift = entry.shiftId ? shifts.get(entry.shiftId) : undefined;
  return CELL_STYLES[styleKey(entry.status, shift?.category)];
}

/** Ngjyra e personalizuar e shift-it (nëse ka), si stil inline. */
export function cellInlineStyle(
  entry: Pick<EntryDTO, "status" | "shiftId"> | null | undefined,
  shifts: Map<string, ShiftDTO>,
): React.CSSProperties | undefined {
  if (!entry?.shiftId) return undefined;
  const color = shifts.get(entry.shiftId)?.color;
  return color ? { backgroundColor: color, color: "#0f172a", borderColor: color } : undefined;
}

export function sameValue(a: CellValue | null, b: CellValue | null): boolean {
  if (a === null || b === null) return a === b;
  return a.status === b.status && a.shiftId === b.shiftId;
}
