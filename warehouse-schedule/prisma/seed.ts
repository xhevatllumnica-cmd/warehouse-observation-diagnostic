/**
 * Seed: krijon shift-et standarde dhe importon Excel-in origjinal.
 *
 *   npm run db:seed                         # përdor prisma/data/schedule-warehouse-team.xlsx
 *   npm run db:seed -- path/to/file.xlsx    # skedar tjetër
 *
 * Seed-i mund të ekzekutohet disa herë: punonjësit dhe shift-et nuk
 * dyfishohen, ndërsa qelizat e orarit mbishkruhen me vlerat e Excel-it.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { importWorkbook } from "../src/lib/import/import-service";
import { parseWorkbook } from "../src/lib/import/parse-workbook";
import { parseShiftCode, shiftCategory } from "../src/lib/shifts";

const DEFAULT_SHIFTS = [
  "07:00-15:00",
  "09:00-17:00",
  "09:00-18:00",
  "10:00-18:00",
  "11:00-19:00",
  "13:00-21:00",
  "15:00-23:00",
  "17:00-01:00",
  "23:00-07:00",
  "07:00-21:00",
  "09:00-21:00",
];

const db = new PrismaClient();

async function main() {
  for (const [i, code] of DEFAULT_SHIFTS.entries()) {
    const times = parseShiftCode(code)!;
    await db.shift.upsert({
      where: { code },
      update: {},
      create: {
        code,
        label: code,
        ...times,
        category: shiftCategory(times.startTime, times.endTime),
        sortOrder: i,
      },
    });
  }

  const file = path.resolve(
    process.argv[2] ?? path.join(__dirname, "data", "schedule-warehouse-team.xlsx"),
  );
  console.log(`Po lexohet ${file} …`);
  const buffer = await readFile(file);
  const parsed = await parseWorkbook(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  const result = await importWorkbook(db, parsed, { overwrite: true });

  console.log(
    [
      `Fletë: ${parsed.sheets}, javë: ${result.weeks}`,
      `Punonjës të rinj: ${result.employeesCreated}`,
      `Shift-e të reja: ${result.shiftsCreated}`,
      `Qeliza të shkruara: ${result.entriesWritten}`,
      `Shënime (${result.issues.length}):`,
      ...result.issues.map((i) => `  - ${i}`),
    ].join("\n"),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
