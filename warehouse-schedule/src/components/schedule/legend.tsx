import { SHIFT_CATEGORY_LABELS, STATUS_LABELS } from "@/lib/constants";
import { CELL_STYLES } from "@/lib/shifts";
import { cn } from "@/lib/utils";

const ITEMS = [
  { key: "morning", label: SHIFT_CATEGORY_LABELS.morning },
  { key: "afternoon", label: SHIFT_CATEGORY_LABELS.afternoon },
  { key: "night", label: SHIFT_CATEGORY_LABELS.night },
  { key: "weekly_off", label: STATUS_LABELS.weekly_off },
  { key: "off", label: STATUS_LABELS.off },
  { key: "sick_leave", label: STATUS_LABELS.sick_leave },
  { key: "annual_leave", label: STATUS_LABELS.annual_leave },
] as const;

export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-1.5">
        {ITEMS.map((i) => (
          <span key={i.key} className={cn("rounded-md border px-1.5 py-0.5 font-medium", CELL_STYLES[i.key])}>
            {i.label}
          </span>
        ))}
      </div>
      <p className="hidden lg:block">
        <b>Klik</b> ose <b>tërhiq</b> për të zgjedhur · <b>1–9</b> shift · <b>W/O/S/P</b> status ·{" "}
        <b>Del</b> pastro · <b>Ctrl+C/V</b> kopjo/ngjit (edhe nga Excel) · <b>Alt+tërhiq</b> përsërit
        vlerën · <b>Ctrl+Z</b> zhbëj
      </p>
    </div>
  );
}
