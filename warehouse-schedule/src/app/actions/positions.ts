"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DEFAULT_POSITIONS } from "@/lib/constants";
import { db } from "@/lib/db";
import type { ActionResult } from "@/lib/types";

const positionSchema = z.object({
  name: z.string().trim().min(1, "Emri i pozitës është i detyrueshëm").max(40),
  description: z.string().trim().max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Ngjyrë e pavlefshme"),
  isActive: z.boolean(),
});

export type PositionInput = z.input<typeof positionSchema>;

function revalidate() {
  revalidatePath("/pozitat");
  revalidatePath("/punonjesit");
  revalidatePath("/orari");
}

function uniqueError(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return "Ekziston tashmë një pozitë me këtë emër.";
  }
  return null;
}

export async function createPosition(input: PositionInput): Promise<ActionResult> {
  const parsed = positionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  try {
    const last = await db.position.aggregate({ _max: { sortOrder: true } });
    await db.position.create({ data: { ...parsed.data, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
    revalidate();
    return { ok: true, data: null };
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) return { ok: false, error: msg };
    throw err;
  }
}

export async function updatePosition(id: string, input: PositionInput): Promise<ActionResult> {
  const parsed = positionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  try {
    await db.position.update({ where: { id }, data: parsed.data });
    revalidate();
    return { ok: true, data: null };
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) return { ok: false, error: msg };
    throw err;
  }
}

export async function reorderPositions(ids: string[]): Promise<ActionResult> {
  const parsed = z.array(z.string().min(1)).max(200).safeParse(ids);
  if (!parsed.success) return { ok: false, error: "Renditje e pavlefshme" };
  await db.$transaction(
    parsed.data.map((id, i) => db.position.update({ where: { id }, data: { sortOrder: i } })),
  );
  revalidate();
  return { ok: true, data: null };
}

/** Fshirja lejohet vetëm kur asnjë punonjës s'e ka këtë pozitë; përndryshe çaktivizoni. */
export async function deletePosition(id: string): Promise<ActionResult> {
  const used = await db.employee.count({ where: { positionId: id } });
  if (used > 0) {
    return { ok: false, error: `${used} punonjës e kanë këtë pozitë. Çaktivizojeni në vend që ta fshini.` };
  }
  await db.position.delete({ where: { id } });
  revalidate();
  return { ok: true, data: null };
}

/** Shton pozitat standarde të depos (vetëm ato që mungojnë). */
export async function addDefaultPositions(): Promise<ActionResult<{ added: number }>> {
  const existing = new Set((await db.position.findMany({ select: { name: true } })).map((p) => p.name));
  const last = await db.position.aggregate({ _max: { sortOrder: true } });
  let order = last._max.sortOrder ?? 0;
  const missing = DEFAULT_POSITIONS.filter((p) => !existing.has(p.name));
  await db.$transaction(
    missing.map((p) => db.position.create({ data: { ...p, sortOrder: ++order } })),
  );
  revalidate();
  return { ok: true, data: { added: missing.length } };
}
