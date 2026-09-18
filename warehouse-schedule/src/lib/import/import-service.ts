/**
 * Shkrimi i një Excel-i të parsuar në databazë. Përdoret nga seed-i
 * (`npm run db:seed`) dhe nga faqja "Importo" në aplikacion.
 */

import type { PrismaClient } from "@prisma/client";
import { EMPLOYEE_COLORS } from "../constants";
import { parseShiftCode, shiftCategory } from "../shifts";
import { ACTIVE_EMPLOYEES, knownAliases, normalizeKey } from "./name-aliases";
import type { ParsedWorkbook } from "./parse-workbook";

export interface ImportOptions {
  /** Nëse true, qelizat ekzistuese mbishkruhen; përndryshe mbushen vetëm boshllëqet. */
  overwrite: boolean;
}

export interface ImportResult {
  employeesCreated: number;
  shiftsCreated: number;
  entriesWritten: number;
  entriesSkipped: number;
  weeks: number;
  issues: string[];
}

const BATCH = 500;

export async function importWorkbook(
  db: PrismaClient,
  parsed: ParsedWorkbook,
  { overwrite }: ImportOptions,
): Promise<ImportResult> {
  // 1. Punonjësit — përputhen sipas emrit ose alias-eve të ruajtura.
  const existing = await db.employee.findMany();
  const byKey = new Map<string, string>();
  for (const e of existing) {
    byKey.set(normalizeKey(e.name), e.id);
    for (const alias of e.aliases.split(",")) {
      if (alias.trim()) byKey.set(normalizeKey(alias), e.id);
    }
  }

  const activeOrder = new Map(ACTIVE_EMPLOYEES.map((n, i) => [normalizeKey(n), i]));
  const isFreshDb = existing.length === 0;
  // Në një databazë bosh krijohen edhe punonjësit aktivë që mungojnë në Excel.
  const names = isFreshDb
    ? [...new Set([...ACTIVE_EMPLOYEES, ...parsed.employees])]
    : parsed.employees;

  let employeesCreated = 0;
  let nextOrder = existing.reduce((m, e) => Math.max(m, e.sortOrder), 0) + 1;
  for (const name of names) {
    const key = normalizeKey(name);
    if (byKey.has(key)) continue;
    const activeIndex = activeOrder.get(key);
    const created = await db.employee.create({
      data: {
        name,
        aliases: knownAliases(name).join(","),
        isActive: isFreshDb ? activeIndex !== undefined : true,
        sortOrder: activeIndex ?? 100 + nextOrder++,
        color: EMPLOYEE_COLORS[(existing.length + employeesCreated) % EMPLOYEE_COLORS.length],
      },
    });
    byKey.set(key, created.id);
    employeesCreated++;
  }

  // 2. Shift-et.
  const shifts = await db.shift.findMany();
  const shiftIds = new Map(shifts.map((s) => [s.code, s.id]));
  let shiftsCreated = 0;
  for (const code of parsed.shiftCodes) {
    if (shiftIds.has(code)) continue;
    const times = parseShiftCode(code)!;
    const created = await db.shift.create({
      data: {
        code,
        label: code,
        ...times,
        category: shiftCategory(times.startTime, times.endTime),
        sortOrder: shifts.length + shiftsCreated,
      },
    });
    shiftIds.set(code, created.id);
    shiftsCreated++;
  }

  // 3. Hyrjet e orarit.
  const rows = parsed.entries.map((e) => ({
    employeeId: byKey.get(normalizeKey(e.name))!,
    date: e.date,
    status: e.status,
    shiftId: e.shiftCode ? shiftIds.get(e.shiftCode)! : null,
  }));

  const dates = [...new Set(rows.map((r) => r.date))];
  const existingKeys = new Set<string>();
  for (let i = 0; i < dates.length; i += BATCH) {
    const found = await db.scheduleEntry.findMany({
      where: { date: { in: dates.slice(i, i + BATCH) } },
      select: { employeeId: true, date: true },
    });
    for (const f of found) existingKeys.add(`${f.employeeId}|${f.date}`);
  }

  const toWrite = rows.filter((r) => overwrite || !existingKeys.has(`${r.employeeId}|${r.date}`));
  const toReplace = toWrite.filter((r) => existingKeys.has(`${r.employeeId}|${r.date}`));

  await db.$transaction(
    async (tx) => {
      for (let i = 0; i < toReplace.length; i += BATCH) {
        await tx.scheduleEntry.deleteMany({
          where: {
            OR: toReplace
              .slice(i, i + BATCH)
              .map((r) => ({ employeeId: r.employeeId, date: r.date })),
          },
        });
      }
      for (let i = 0; i < toWrite.length; i += BATCH) {
        await tx.scheduleEntry.createMany({ data: toWrite.slice(i, i + BATCH) });
      }
    },
    { timeout: 120_000 },
  );

  return {
    employeesCreated,
    shiftsCreated,
    entriesWritten: toWrite.length,
    entriesSkipped: rows.length - toWrite.length,
    weeks: parsed.weeks,
    issues: parsed.issues,
  };
}
