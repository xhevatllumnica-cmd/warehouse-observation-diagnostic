/**
 * Konstante të përbashkëta për klientin dhe serverin: statuset, emrat shqip
 * të muajve/ditëve dhe pragjet e validimit.
 */

export const ENTRY_STATUSES = [
  "working",
  "weekly_off",
  "off",
  "sick_leave",
  "annual_leave",
] as const;

export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** Statuset që nuk kanë shift (gjithçka përveç "working"). */
export const NON_WORKING_STATUSES = ENTRY_STATUSES.filter(
  (s): s is Exclude<EntryStatus, "working"> => s !== "working",
);

export const STATUS_LABELS: Record<EntryStatus, string> = {
  working: "Në punë",
  weekly_off: "Weekly OFF",
  off: "OFF",
  sick_leave: "Sick Leave",
  annual_leave: "Pushim vjetor",
};

/** Etiketat e shkurtra që shfaqen brenda qelizave të grid-it. */
export const STATUS_SHORT: Record<EntryStatus, string> = {
  working: "",
  weekly_off: "W.OFF",
  off: "OFF",
  sick_leave: "Sick",
  annual_leave: "Pushim",
};

/** Teksti i statusit siç shkruhet në Excel (përdoret në import/eksport). */
export const STATUS_EXCEL_TEXT: Record<Exclude<EntryStatus, "working">, string> = {
  weekly_off: "Weekly OFF",
  off: "OFF",
  sick_leave: "Sick Leave",
  annual_leave: "Pushim vjetor",
};

export const SHIFT_CATEGORIES = ["morning", "afternoon", "night"] as const;
export type ShiftCategory = (typeof SHIFT_CATEGORIES)[number];

export const SHIFT_CATEGORY_LABELS: Record<ShiftCategory, string> = {
  morning: "Mëngjes",
  afternoon: "Mbasdite",
  night: "Natë",
};

export const MONTH_NAMES = [
  "Janar",
  "Shkurt",
  "Mars",
  "Prill",
  "Maj",
  "Qershor",
  "Korrik",
  "Gusht",
  "Shtator",
  "Tetor",
  "Nëntor",
  "Dhjetor",
] as const;

/** Ditët e javës duke filluar nga e Hëna (si në Excel). */
export const WEEKDAY_NAMES = [
  "E Hënë",
  "E Martë",
  "E Mërkurë",
  "E Enjte",
  "E Premte",
  "E Shtunë",
  "E Diel",
] as const;

export const WEEKDAY_SHORT = ["Hën", "Mar", "Mër", "Enj", "Pre", "Sht", "Die"] as const;

/**
 * Pragjet e rregullave të biznesit. Paralajmërimet nuk bllokojnë ruajtjen;
 * vetëm mbivendosja e shift-eve bllokohet.
 */
export const RULES = {
  /** Orë maksimale në javë para paralajmërimit. */
  maxWeeklyHours: 48,
  /** Ditë pune radhazi para paralajmërimit. */
  maxConsecutiveWorkDays: 6,
  /** Orë minimale pushimi mes dy shift-eve. */
  minRestHours: 11,
  /** Gjatësia maksimale e një shift-i para paralajmërimit. */
  maxShiftHours: 12,
  /** Ditë OFF (jo Weekly OFF) në muaj para paralajmërimit. */
  maxOffDaysPerMonth: 4,
} as const;

/** Paleta e ngjyrave që ofrohet kur krijohet një punonjës. */
export const EMPLOYEE_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#84cc16",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
  "#64748b",
  "#78716c",
] as const;
