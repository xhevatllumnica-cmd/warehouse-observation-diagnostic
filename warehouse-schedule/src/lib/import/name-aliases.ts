/**
 * Harta e emrave nga Excel-i → emri kanonik në aplikacion.
 *
 * Në Excel i njëjti person shkruhet në mënyra të ndryshme ("Filan"/"Filani").
 * Çelësat krahasohen pa marrë parasysh shkronjat e mëdha/vogla dhe
 * hapësirat. Emrat që nuk janë këtu importohen siç janë.
 *
 * Emrat realë NUK ruhen në kod: lexohen nga `name-aliases.local.json`
 * (në rrënjë të projektit, jashtë git-it). Shembull: `name-aliases.example.json`.
 * Nëse skedari mungon, nuk ka alias-e dhe të gjithë importohen si joaktivë.
 *
 * Kur shtohet një person i ri me emër tjetër në Excel, mjafton ta shtoni
 * alias-in edhe te punonjësi në aplikacion (fusha "Emra alternativë").
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type NameConfig = { aliases?: Record<string, string>; activeEmployees?: string[] };

function loadNameConfig(): NameConfig {
  const file = path.join(process.cwd(), "name-aliases.local.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as NameConfig;
}

const config = loadNameConfig();

export const NAME_ALIASES: Record<string, string> = config.aliases ?? {};

/** Punonjësit aktualë. Të gjithë të tjerët importohen si joaktivë. */
export const ACTIVE_EMPLOYEES: string[] = config.activeEmployees ?? [];

export function normalizeKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function canonicalName(raw: string): string {
  const cleaned = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  return NAME_ALIASES[normalizeKey(cleaned)] ?? cleaned;
}

/** Alias-et e njohura për një emër kanonik, p.sh. "Filan" → "Filani". */
export function knownAliases(name: string): string[] {
  const key = normalizeKey(name);
  return Object.entries(NAME_ALIASES)
    .filter(([, canonical]) => normalizeKey(canonical) === key)
    .map(([alias]) => alias.charAt(0).toUpperCase() + alias.slice(1));
}
