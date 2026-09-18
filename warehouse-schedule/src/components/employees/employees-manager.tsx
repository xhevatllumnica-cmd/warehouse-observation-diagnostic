"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  deleteEmployee,
  reorderEmployees,
  setEmployeeActive,
} from "@/app/actions/employees";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import type { EmployeeDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmployeeDialog } from "./employee-dialog";

interface Usage {
  days: number;
  lastDate: string | null;
}

type Filter = "active" | "inactive" | "all";

export function EmployeesManager({
  employees,
  usage,
}: {
  employees: EmployeeDTO[];
  usage: Record<string, Usage>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EmployeeDTO | "new" | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return employees.filter(
      (e) =>
        (filter === "all" || (filter === "active") === e.isActive) &&
        (!q || e.name.toLowerCase().includes(q) || e.aliases.toLowerCase().includes(q)),
    );
  }, [employees, filter, query]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) =>
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error);
      else {
        if (success) toast.success(success);
        router.refresh();
      }
    });

  /** Lëviz punonjësin lart/poshtë brenda listës së aktivëve. */
  const move = (emp: EmployeeDTO, dir: -1 | 1) => {
    const actives = employees.filter((e) => e.isActive);
    const i = actives.findIndex((e) => e.id === emp.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= actives.length) return;
    const ids = actives.map((e) => e.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const inactive = employees.filter((e) => !e.isActive).map((e) => e.id);
    run(() => reorderEmployees([...ids, ...inactive]));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Kërko…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-52 pl-8"
          />
        </div>
        <div className="inline-flex rounded-lg border p-0.5" role="tablist">
          {(
            [
              ["active", "Aktivë"],
              ["inactive", "Joaktivë"],
              ["all", "Të gjithë"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                filter === value ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Button className="ml-auto" onClick={() => setEditing("new")}>
          <PlusIcon />
          Shto punonjës
        </Button>
      </div>

      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Emri</TableHead>
              <TableHead className="hidden md:table-cell">Emra alternativë</TableHead>
              <TableHead className="text-right">Ditë në orar</TableHead>
              <TableHead className="hidden sm:table-cell">Dita e fundit</TableHead>
              <TableHead>Aktiv</TableHead>
              <TableHead className="w-40 text-right">Veprime</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((emp, index) => {
              const u = usage[emp.id];
              return (
                <TableRow key={emp.id} className={cn(!emp.isActive && "text-muted-foreground")}>
                  <TableCell className="tabular-nums">{index + 1}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 font-medium">
                      <span
                        className="size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: emp.color }}
                        aria-hidden
                      />
                      {emp.name}
                      {!emp.isActive && <Badge variant="secondary">Joaktiv</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {emp.aliases ? emp.aliases.split(",").join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{u?.days ?? 0}</TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">
                    {u?.lastDate ? formatDate(u.lastDate) : "—"}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={emp.isActive}
                      disabled={isPending}
                      aria-label={emp.isActive ? "Çaktivizo" : "Aktivizo"}
                      onCheckedChange={(v) =>
                        run(
                          () => setEmployeeActive(emp.id, Boolean(v)),
                          `${emp.name} u ${v ? "aktivizua" : "çaktivizua"}.`,
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      {emp.isActive && filter !== "inactive" && !query && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Lëviz lart"
                            disabled={isPending || index === 0}
                            onClick={() => move(emp, -1)}
                          >
                            <ArrowUpIcon />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Lëviz poshtë"
                            disabled={isPending || index === visible.length - 1}
                            onClick={() => move(emp, 1)}
                          >
                            <ArrowDownIcon />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Ndrysho"
                        onClick={() => setEditing(emp)}
                      >
                        <PencilIcon />
                      </Button>
                      {!u?.days && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Fshi"
                          disabled={isPending}
                          onClick={() => {
                            if (confirm(`Të fshihet ${emp.name}?`)) {
                              run(() => deleteEmployee(emp.id), `${emp.name} u fshi.`);
                            }
                          }}
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  Asnjë punonjës.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Punonjësit me orar nuk fshihen — çaktivizojini që të mos shfaqen më në orarin e ri, ndërsa
        historiku ruhet. “Emrat alternativë” përdoren kur importohet Excel-i (p.sh. “Erik” → Eriku).
      </p>

      <EmployeeDialog
        employee={editing === "new" ? null : editing}
        open={editing !== null}
        defaultColorIndex={employees.length}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
