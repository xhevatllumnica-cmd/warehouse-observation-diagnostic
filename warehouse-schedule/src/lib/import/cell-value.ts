/**
 * Kthen tekstin e një qelize (nga Excel ose clipboard) në status + kod shift-i.
 * Modul i lehtë pa varësi, që përdoret edhe në shfletues (paste).
 */

import type { EntryStatus } from "../constants";
import { parseShiftCode, shiftCode } from "../shifts";

export function parseCellValue(raw: string): { status: EntryStatus; shiftCode?: string } | null {
  const text = raw.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const times = parseShiftCode(text);
  if (times) return { status: "working", shiftCode: shiftCode(times.startTime, times.endTime) };
  switch (text.toLowerCase()) {
    case "weekly off":
    case "weeklyoff":
    case "w.off":
      return { status: "weekly_off" };
    case "off":
      return { status: "off" };
    case "sick leave":
    case "sick":
      return { status: "sick_leave" };
    case "pushim":
    case "pushim vjetor":
    case "annual leave":
    case "vacation":
      return { status: "annual_leave" };
    default:
      return null;
  }
}
