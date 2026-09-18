"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { shiftCategory, shiftCode } from "@/lib/shifts";
import type { ActionResult } from "@/lib/types";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ora duhet të jetë HH:MM");

const shiftSchema = z
  .object({
    startTime: time,
    endTime: time,
    label: z.string().trim().max(40),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable(),
    isActive: z.boolean(),
  })
  .refine((s) => s.startTime !== s.endTime, "Ora e fillimit dhe e mbarimit s'mund të jenë njësoj");

export type ShiftInput = z.input<typeof shiftSchema>;

function toData(input: z.output<typeof shiftSchema>) {
  const code = shiftCode(input.startTime, input.endTime);
  return {
    code,
    label: input.label || code,
    startTime: input.startTime,
    endTime: input.endTime,
    category: shiftCategory(input.startTime, input.endTime),
    color: input.color,
    isActive: input.isActive,
  };
}

function revalidate() {
  revalidatePath("/shiftet");
  revalidatePath("/orari");
}

function uniqueError(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return "Ky shift ekziston tashmë.";
  }
  return null;
}

export async function createShift(input: ShiftInput): Promise<ActionResult> {
  const parsed = shiftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  try {
    const last = await db.shift.aggregate({ _max: { sortOrder: true } });
    await db.shift.create({
      data: { ...toData(parsed.data), sortOrder: (last._max.sortOrder ?? 0) + 1 },
    });
    revalidate();
    return { ok: true, data: null };
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) return { ok: false, error: msg };
    throw err;
  }
}

export async function updateShift(id: string, input: ShiftInput): Promise<ActionResult> {
  const parsed = shiftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const current = await db.shift.findUnique({ where: { id } });
  if (!current) return { ok: false, error: "Shift-i nuk u gjet." };
  const data = toData(parsed.data);
  if (data.code !== current.code) {
    const used = await db.scheduleEntry.count({ where: { shiftId: id } });
    if (used > 0) {
      return {
        ok: false,
        error: `Orët nuk mund të ndryshohen: shift-i përdoret në ${used} ditë. Krijoni një shift të ri.`,
      };
    }
  }
  try {
    await db.shift.update({ where: { id }, data });
    revalidate();
    return { ok: true, data: null };
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) return { ok: false, error: msg };
    throw err;
  }
}

export async function reorderShifts(ids: string[]): Promise<ActionResult> {
  const parsed = z.array(z.string().min(1)).max(500).safeParse(ids);
  if (!parsed.success) return { ok: false, error: "Renditje e pavlefshme" };
  await db.$transaction(
    parsed.data.map((id, i) => db.shift.update({ where: { id }, data: { sortOrder: i } })),
  );
  revalidate();
  return { ok: true, data: null };
}

export async function deleteShift(id: string): Promise<ActionResult> {
  const used = await db.scheduleEntry.count({ where: { shiftId: id } });
  if (used > 0) {
    return { ok: false, error: `Shift-i përdoret në ${used} ditë. Çaktivizojeni në vend që ta fshini.` };
  }
  await db.shift.delete({ where: { id } });
  revalidate();
  return { ok: true, data: null };
}
