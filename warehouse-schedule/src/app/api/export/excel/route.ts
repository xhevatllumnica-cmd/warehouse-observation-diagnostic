import { NextResponse, type NextRequest } from "next/server";
import { MONTH_NAMES } from "@/lib/constants";
import { buildScheduleWorkbook } from "@/lib/export/excel-export";

export const dynamic = "force-dynamic";

/**
 * GET /api/export/excel?year=2026&month=9  → orari i një muaji
 * GET /api/export/excel?year=2026          → i gjithë viti (një fletë për muaj)
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const year = Number(params.get("year"));
  const month = params.get("month") ? Number(params.get("month")) : undefined;

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Viti i pavlefshëm" }, { status: 400 });
  }
  if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return NextResponse.json({ error: "Muaji i pavlefshëm" }, { status: 400 });
  }

  const wb = await buildScheduleWorkbook(year, month);
  const buffer = await wb.xlsx.writeBuffer();

  const name = month ? `Orari ${MONTH_NAMES[month - 1]} ${year}.xlsx` : `Orari ${year}.xlsx`;
  const ascii = name.normalize("NFD").replace(/[^\x20-\x7e]/g, "");
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
