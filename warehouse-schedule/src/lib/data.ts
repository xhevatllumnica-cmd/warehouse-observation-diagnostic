import "server-only";

/**
 * Leximi i të dhënave nga databaza për faqet (Server Components).
 */

import type { EntryStatus, ShiftCategory } from "./constants";
import { db } from "./db";
import type { ISODate } from "./dates";
import type { EmployeeDTO, EntryDTO, ShiftDTO } from "./types";

export async function getEmployees(opts: { activeOnly?: boolean } = {}): Promise<EmployeeDTO[]> {
  return db.employee.findMany({
    where: opts.activeOnly ? { isActive: true } : undefined,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, color: true, isActive: true, sortOrder: true, aliases: true },
  });
}

export async function getShifts(): Promise<ShiftDTO[]> {
  const rows = await db.shift.findMany({ orderBy: [{ sortOrder: "asc" }, { startTime: "asc" }] });
  return rows.map((s) => ({
    id: s.id,
    code: s.code,
    label: s.label,
    startTime: s.startTime,
    endTime: s.endTime,
    category: s.category as ShiftCategory,
    color: s.color,
    isActive: s.isActive,
    sortOrder: s.sortOrder,
  }));
}

export async function getEntries(from: ISODate, to: ISODate): Promise<EntryDTO[]> {
  const rows = await db.scheduleEntry.findMany({
    where: { date: { gte: from, lte: to } },
    select: { employeeId: true, date: true, status: true, shiftId: true, notes: true },
    orderBy: { date: "asc" },
  });
  return rows.map((r) => ({ ...r, status: r.status as EntryStatus }));
}

/** Punonjësit për një interval: aktivët + joaktivët që kanë orar aty. */
export function employeesForRange(employees: EmployeeDTO[], entries: EntryDTO[]): EmployeeDTO[] {
  const withEntries = new Set(entries.map((e) => e.employeeId));
  return employees.filter((e) => e.isActive || withEntries.has(e.id));
}
