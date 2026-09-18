"use server";

/**
 * Server actions për editimin e orarit.
 *
 * Çdo ndryshim validohet në server: statusi, shift-i dhe mbivendosja me
 * shift-et e ditëve fqinje. Ndryshimet e pavlefshme refuzohen një nga një,
 * ndërsa të tjerat ruhen.
 */

import { z } from "zod";
import { ENTRY_STATUSES, type EntryStatus } from "@/lib/constants";
import { db } from "@/lib/db";
import { addDays, diffDays, isISODate, weekdayIndex, type ISODate } from "@/lib/dates";
import { findOverlap, type RuleEntry } from "@/lib/rules";
import {
  entryKey,
  type ActionResult,
  type CellChange,
  type EntryDTO,
} from "@/lib/types";

const isoDate = z.string().refine(isISODate, "Data e pavlefshme");

const cellValueSchema = z
  .object({
    status: z.enum(ENTRY_STATUSES),
    shiftId: z.string().min(1).nullable(),
    notes: z.string().max(500).nullable().optional(),
  })
  .refine((v) => (v.status === "working") === (v.shiftId !== null), {
    message: "Statusi 'Në punë' kërkon shift; statuset e tjera nuk kanë shift.",
  });

const changesSchema = z
  .array(
    z.object({
      employeeId: z.string().min(1),
      date: isoDate,
      value: cellValueSchema.nullable(),
    }),
  )
  .min(1)
  .max(2000);

export interface SaveResult {
  saved: EntryDTO[];
  removed: { employeeId: string; date: ISODate }[];
  rejected: { employeeId: string; date: ISODate; message: string }[];
}

type ShiftTimes = { id: string; code: string; startTime: string; endTime: string };

function toRuleEntry(
  e: { employeeId: string; date: string; status: string; shiftId: string | null },
  shifts: Map<string, ShiftTimes>,
): RuleEntry {
  return {
    employeeId: e.employeeId,
    date: e.date,
    status: e.status as EntryStatus,
    shift: e.shiftId ? (shifts.get(e.shiftId) ?? null) : null,
  };
}

export async function saveCells(input: CellChange[]): Promise<ActionResult<SaveResult>> {
  const parsed = changesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Të dhëna të pavlefshme" };
  }
  const changes = parsed.data;

  const shiftRows = await db.shift.findMany({
    select: { id: true, code: true, startTime: true, endTime: true },
  });
  const shifts = new Map(shiftRows.map((s) => [s.id, s]));

  const employeeIds = [...new Set(changes.map((c) => c.employeeId))];
  const dates = changes.map((c) => c.date).sort();
  const from = addDays(dates[0], -1);
  const to = addDays(dates[dates.length - 1], 1);

  // Gjendja aktuale + ndryshimet = gjendja e re, mbi të cilën kontrollohet mbivendosja.
  const current = await db.scheduleEntry.findMany({
    where: { employeeId: { in: employeeIds }, date: { gte: from, lte: to } },
    select: { employeeId: true, date: true, status: true, shiftId: true },
  });
  const state = new Map<string, RuleEntry>();
  for (const e of current) state.set(entryKey(e.employeeId, e.date), toRuleEntry(e, shifts));

  const result: SaveResult = { saved: [], removed: [], rejected: [] };
  const accepted: typeof changes = [];

  for (const change of changes) {
    const key = entryKey(change.employeeId, change.date);
    if (change.value === null) {
      state.delete(key);
      accepted.push(change);
      continue;
    }
    if (change.value.shiftId && !shifts.has(change.value.shiftId)) {
      result.rejected.push({
        employeeId: change.employeeId,
        date: change.date,
        message: "Shift-i nuk ekziston.",
      });
      continue;
    }
    const candidate = toRuleEntry({ ...change, ...change.value }, shifts);
    const neighbours = [addDays(change.date, -1), addDays(change.date, 1)]
      .map((d) => state.get(entryKey(change.employeeId, d)))
      .filter((n): n is RuleEntry => Boolean(n));
    const overlap = findOverlap(candidate, neighbours);
    if (overlap) {
      result.rejected.push({ employeeId: change.employeeId, date: change.date, message: overlap });
      continue;
    }
    state.set(key, candidate);
    accepted.push(change);
  }

  if (accepted.length > 0) {
    await db.$transaction(
      accepted.map((c) =>
        c.value === null
          ? db.scheduleEntry.deleteMany({ where: { employeeId: c.employeeId, date: c.date } })
          : db.scheduleEntry.upsert({
              where: { employeeId_date: { employeeId: c.employeeId, date: c.date } },
              create: {
                employeeId: c.employeeId,
                date: c.date,
                status: c.value.status,
                shiftId: c.value.shiftId,
                notes: c.value.notes ?? null,
              },
              update: {
                status: c.value.status,
                shiftId: c.value.shiftId,
                // `undefined` = mos e prek shënimin ekzistues.
                ...(c.value.notes !== undefined ? { notes: c.value.notes } : {}),
              },
            }),
      ),
    );
  }

  const savedKeys = accepted.filter((c) => c.value !== null);
  if (savedKeys.length > 0) {
    const rows = await db.scheduleEntry.findMany({
      where: {
        OR: savedKeys.map((c) => ({ employeeId: c.employeeId, date: c.date })),
      },
      select: { employeeId: true, date: true, status: true, shiftId: true, notes: true },
    });
    result.saved = rows.map((r) => ({ ...r, status: r.status as EntryStatus }));
  }
  result.removed = accepted
    .filter((c) => c.value === null)
    .map(({ employeeId, date }) => ({ employeeId, date }));

  return { ok: true, data: result };
}

const copyWeekSchema = z.object({
  sourceWeek: isoDate,
  targetWeek: isoDate,
  overwrite: z.boolean(),
  employeeIds: z.array(z.string()).optional(),
});

/**
 * Kopjon orarin e një jave (E Hënë–E Diel) në një javë tjetër. Qelizat që do
 * mbivendoseshin me shift-e fqinje refuzohen dhe numërohen te `rejected`.
 */
export async function copyWeek(
  input: z.infer<typeof copyWeekSchema>,
): Promise<ActionResult<{ copied: number; skipped: number; rejected: number }>> {
  const parsed = copyWeekSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Të dhëna të pavlefshme" };
  const { sourceWeek, targetWeek, overwrite, employeeIds } = parsed.data;
  if (weekdayIndex(sourceWeek) !== 0 || weekdayIndex(targetWeek) !== 0) {
    return { ok: false, error: "Javët duhet të fillojnë të Hënën." };
  }
  if (sourceWeek === targetWeek) {
    return { ok: false, error: "Java burim dhe java e synuar janë të njëjta." };
  }

  const employeeFilter = employeeIds?.length ? { employeeId: { in: employeeIds } } : {};
  const [source, target] = await Promise.all([
    db.scheduleEntry.findMany({
      where: { date: { gte: sourceWeek, lte: addDays(sourceWeek, 6) }, ...employeeFilter },
    }),
    db.scheduleEntry.findMany({
      where: { date: { gte: targetWeek, lte: addDays(targetWeek, 6) }, ...employeeFilter },
      select: { employeeId: true, date: true },
    }),
  ]);
  if (source.length === 0) return { ok: false, error: "Java burim nuk ka orar." };

  const existing = new Set(target.map((t) => entryKey(t.employeeId, t.date)));
  const offset = diffDays(targetWeek, sourceWeek);

  const changes: CellChange[] = [];
  let skipped = 0;
  for (const e of source) {
    const date = addDays(e.date, offset);
    if (!overwrite && existing.has(entryKey(e.employeeId, date))) {
      skipped++;
      continue;
    }
    changes.push({
      employeeId: e.employeeId,
      date,
      value: { status: e.status as EntryStatus, shiftId: e.shiftId, notes: e.notes },
    });
  }
  if (changes.length === 0) return { ok: true, data: { copied: 0, skipped, rejected: 0 } };

  const saved = await saveCells(changes);
  if (!saved.ok) return saved;
  return {
    ok: true,
    data: {
      copied: saved.data.saved.length,
      skipped,
      rejected: saved.data.rejected.length,
    },
  };
}

/** Fshin të gjitha qelizat e një jave (opsionalisht vetëm për disa punonjës). */
export async function clearWeek(input: {
  weekStart: string;
  employeeIds?: string[];
}): Promise<ActionResult<{ removed: number }>> {
  if (!isISODate(input.weekStart) || weekdayIndex(input.weekStart) !== 0) {
    return { ok: false, error: "Java duhet të fillojë të Hënën." };
  }
  const { count } = await db.scheduleEntry.deleteMany({
    where: {
      date: { gte: input.weekStart, lte: addDays(input.weekStart, 6) },
      ...(input.employeeIds?.length ? { employeeId: { in: input.employeeIds } } : {}),
    },
  });
  return { ok: true, data: { removed: count } };
}
