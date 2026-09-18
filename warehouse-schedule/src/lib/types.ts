/** Objektet e thjeshta (të serializueshme) që kalojnë nga serveri te klienti. */

import type { EntryStatus, ShiftCategory } from "./constants";
import type { ISODate } from "./dates";

export interface EmployeeDTO {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  sortOrder: number;
  aliases: string;
}

export interface ShiftDTO {
  id: string;
  code: string;
  label: string;
  startTime: string;
  endTime: string;
  category: ShiftCategory;
  color: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface EntryDTO {
  employeeId: string;
  date: ISODate;
  status: EntryStatus;
  shiftId: string | null;
  notes: string | null;
}

/** Vlera që vendoset në një qelizë (null = pastro qelizën). */
export interface CellValue {
  status: EntryStatus;
  shiftId: string | null;
  notes?: string | null;
}

export interface CellChange {
  employeeId: string;
  date: ISODate;
  value: CellValue | null;
}

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

export function entryKey(employeeId: string, date: ISODate): string {
  return `${employeeId}|${date}`;
}
