"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import { MONTH_NAMES } from "@/lib/constants";

export function StatsFilters({ year, month }: { year: number; month: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear - 2025 + 2 }, (_, i) => 2025 + i);
  if (!years.includes(year)) years.push(year);

  const go = (y: number, m: number) =>
    startTransition(() => router.push(`/statistikat?year=${y}&month=${m || "all"}`));

  return (
    <>
      <NativeSelect aria-label="Muaji" value={month} onChange={(e) => go(year, Number(e.target.value))}>
        <option value={0}>I gjithë viti</option>
        {MONTH_NAMES.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect aria-label="Viti" value={year} onChange={(e) => go(Number(e.target.value), month)}>
        {years.sort().map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </NativeSelect>
    </>
  );
}
