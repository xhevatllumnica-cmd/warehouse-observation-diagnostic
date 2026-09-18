"use client";

import {
  BarChart3Icon,
  CalendarDaysIcon,
  Clock3Icon,
  FileUpIcon,
  UsersIcon,
  WarehouseIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/orari", label: "Orari", icon: CalendarDaysIcon },
  { href: "/punonjesit", label: "Punonjësit", icon: UsersIcon },
  { href: "/shiftet", label: "Shift-et", icon: Clock3Icon },
  { href: "/statistikat", label: "Statistikat", icon: BarChart3Icon },
  { href: "/importo", label: "Importo", icon: FileUpIcon },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="no-print sticky top-0 z-30 flex shrink-0 items-center gap-1 border-b bg-sidebar px-3 py-2 md:h-dvh md:w-56 md:flex-col md:items-stretch md:gap-1 md:border-r md:border-b-0 md:px-3 md:py-4">
        <Link href="/orari" className="mr-2 flex items-center gap-2 px-2 font-semibold md:mr-0 md:mb-4">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <WarehouseIcon className="size-4" />
          </span>
          <span className="hidden leading-tight sm:block">
            Warehouse
            <span className="block text-xs font-normal text-muted-foreground">Orari i punës</span>
          </span>
        </Link>

        <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm whitespace-nowrap text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  active && "bg-sidebar-accent font-medium text-sidebar-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="md:mt-auto md:px-1">
          <ThemeToggle />
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
