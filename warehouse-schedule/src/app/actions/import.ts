"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { importWorkbook, type ImportResult } from "@/lib/import/import-service";
import { parseWorkbook } from "@/lib/import/parse-workbook";
import type { ActionResult } from "@/lib/types";

const MAX_BYTES = 10 * 1024 * 1024;

export async function importExcel(formData: FormData): Promise<ActionResult<ImportResult>> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Zgjidhni një skedar Excel (.xlsx)." };
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return { ok: false, error: "Lejohen vetëm skedarë .xlsx." };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: "Skedari është më i madh se 10 MB." };
  }

  try {
    const parsed = await parseWorkbook(await file.arrayBuffer());
    if (parsed.entries.length === 0) {
      return { ok: false, error: "Nuk u gjet asnjë orar në skedar. Kontrolloni formatin." };
    }
    const result = await importWorkbook(db, parsed, {
      overwrite: formData.get("overwrite") === "on",
    });
    revalidatePath("/", "layout");
    return { ok: true, data: result };
  } catch (err) {
    console.error("Import failed", err);
    return { ok: false, error: "Skedari nuk mund të lexohet. Sigurohuni që është .xlsx i vlefshëm." };
  }
}
