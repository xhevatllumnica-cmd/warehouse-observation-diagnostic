"use client";

/**
 * Eksporti PDF i orarit, i gjeneruar në shfletues me jsPDF.
 * Çdo javë del si tabelë më vete (si në Excel), në A4 horizontale.
 */

import { WEEKDAY_SHORT } from "@/lib/constants";
import { addDays, formatDate, formatDayMonth, weekdayIndex, type ISODate } from "@/lib/dates";
import { EXPORT_COLORS, formatHours, shiftHours, styleKey } from "@/lib/shifts";
import { entryKey, type EmployeeDTO, type EntryDTO, type ShiftDTO } from "@/lib/types";
import { cellLabel } from "./cell-format";

interface PdfOptions {
  title: string;
  weeks: ISODate[];
  employees: EmployeeDTO[];
  shifts: ShiftDTO[];
  entries: Map<string, EntryDTO>;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Gjeneron dhe shkarkon PDF-në. */
export async function exportSchedulePdf(options: PdfOptions & { fileName: string }) {
  const doc = await buildSchedulePdf(options);
  doc.save(options.fileName);
}

export async function buildSchedulePdf({ title, weeks, employees, shifts, entries }: PdfOptions) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const shiftMap = new Map(shifts.map((s) => [s.id, s]));
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(16);
  doc.text(title, 14, 15);
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(`Gjeneruar më ${formatDate(new Date().toISOString().slice(0, 10))}`, pageWidth - 14, 15, {
    align: "right",
  });
  doc.setTextColor(0);

  let startY = 20;
  for (const week of weeks) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    const rows = employees.filter(
      (e) => e.isActive || days.some((d) => entries.has(entryKey(e.id, d))),
    );

    const body = rows.map((emp) => {
      let hours = 0;
      const cells = days.map((d) => {
        const entry = entries.get(entryKey(emp.id, d));
        if (entry?.status === "working" && entry.shiftId) {
          const s = shiftMap.get(entry.shiftId);
          if (s) hours += shiftHours(s.startTime, s.endTime);
        }
        return cellLabel(entry, shiftMap, false);
      });
      return [emp.name, ...cells, hours ? formatHours(hours) : ""];
    });

    autoTable(doc, {
      startY,
      head: [
        [
          `${formatDayMonth(week)} – ${formatDayMonth(days[6])}`,
          ...days.map((d) => `${WEEKDAY_SHORT[weekdayIndex(d)]} ${formatDayMonth(d)}`),
          "Orë",
        ],
      ],
      body,
      theme: "grid",
      rowPageBreak: "avoid",
      styles: { fontSize: 8, cellPadding: 1.4, halign: "center", valign: "middle" },
      headStyles: { fillColor: [226, 232, 240], textColor: 20, fontStyle: "bold" },
      columnStyles: {
        0: { halign: "left", fontStyle: "bold", cellWidth: 32 },
        8: { fontStyle: "bold", cellWidth: 14 },
      },
      didParseCell: (data) => {
        if (data.section !== "body" || data.column.index < 1 || data.column.index > 7) return;
        const emp = rows[data.row.index];
        const entry = entries.get(entryKey(emp.id, days[data.column.index - 1]));
        if (!entry) return;
        const shift = entry.shiftId ? shiftMap.get(entry.shiftId) : undefined;
        const color = shift?.color ?? EXPORT_COLORS[styleKey(entry.status, shift?.category)];
        data.cell.styles.fillColor = hexToRgb(color);
      },
    });

    startY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

  return doc;
}
