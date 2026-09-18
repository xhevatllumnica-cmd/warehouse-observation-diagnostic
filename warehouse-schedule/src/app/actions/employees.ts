"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import type { ActionResult } from "@/lib/types";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Ngjyrë e pavlefshme");

const employeeSchema = z.object({
  name: z.string().trim().min(1, "Emri është i detyrueshëm").max(60),
  color: hexColor,
  isActive: z.boolean(),
  aliases: z
    .string()
    .max(300)
    .transform((s) =>
      s
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
        .join(","),
    ),
});

export type EmployeeInput = z.input<typeof employeeSchema>;

function revalidate() {
  revalidatePath("/punonjesit");
  revalidatePath("/orari");
}

function uniqueError(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return "Ekziston tashmë një punonjës me këtë emër.";
  }
  return null;
}

export async function createEmployee(input: EmployeeInput): Promise<ActionResult<{ id: string }>> {
  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  try {
    const last = await db.employee.aggregate({ _max: { sortOrder: true }, where: { isActive: true } });
    const created = await db.employee.create({
      data: { ...parsed.data, sortOrder: (last._max.sortOrder ?? 0) + 1 },
    });
    revalidate();
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) return { ok: false, error: msg };
    throw err;
  }
}

export async function updateEmployee(id: string, input: EmployeeInput): Promise<ActionResult> {
  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  try {
    await db.employee.update({ where: { id }, data: parsed.data });
    revalidate();
    return { ok: true, data: null };
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) return { ok: false, error: msg };
    throw err;
  }
}

export async function setEmployeeActive(id: string, isActive: boolean): Promise<ActionResult> {
  await db.employee.update({ where: { id }, data: { isActive } });
  revalidate();
  return { ok: true, data: null };
}

/** Ruan renditjen e re (lista e plotë e id-ve në rendin e dëshiruar). */
export async function reorderEmployees(ids: string[]): Promise<ActionResult> {
  const parsed = z.array(z.string().min(1)).max(1000).safeParse(ids);
  if (!parsed.success) return { ok: false, error: "Renditje e pavlefshme" };
  await db.$transaction(
    parsed.data.map((id, i) => db.employee.update({ where: { id }, data: { sortOrder: i } })),
  );
  revalidate();
  return { ok: true, data: null };
}

/** Fshirja lejohet vetëm për punonjës pa asnjë orar; përndryshe çaktivizoni. */
export async function deleteEmployee(id: string): Promise<ActionResult> {
  const count = await db.scheduleEntry.count({ where: { employeeId: id } });
  if (count > 0) {
    return {
      ok: false,
      error: `Punonjësi ka ${count} ditë në orar. Çaktivizojeni në vend që ta fshini.`,
    };
  }
  await db.employee.delete({ where: { id } });
  revalidate();
  return { ok: true, data: null };
}
