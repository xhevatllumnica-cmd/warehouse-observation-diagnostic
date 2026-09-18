"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ORDER = ["light", "dark", "system"] as const;
const LABELS = { light: "E çelët", dark: "E errët", system: "Sipas sistemit" } as const;

/** Kalon me radhë: e çelët → e errët → sipas sistemit. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = (mounted && ORDER.includes(theme as never) ? theme : "system") as (typeof ORDER)[number];
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  const Icon = current === "light" ? SunIcon : current === "dark" ? MoonIcon : MonitorIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Tema: ${LABELS[current]}`}
            onClick={() => setTheme(next)}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>Tema: {LABELS[current]}</TooltipContent>
    </Tooltip>
  );
}
