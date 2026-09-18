"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { createEmployee, updateEmployee } from "@/app/actions/employees";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EMPLOYEE_COLORS } from "@/lib/constants";
import type { EmployeeDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

export function EmployeeDialog({
  employee,
  open,
  defaultColorIndex,
  onClose,
}: {
  employee: EmployeeDTO | null;
  open: boolean;
  defaultColorIndex: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(EMPLOYEE_COLORS[0]);
  const [aliases, setAliases] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(employee?.name ?? "");
    setColor(employee?.color ?? EMPLOYEE_COLORS[defaultColorIndex % EMPLOYEE_COLORS.length]);
    setAliases(employee?.aliases.split(",").join(", ") ?? "");
    setIsActive(employee?.isActive ?? true);
    setError(null);
  }, [open, employee, defaultColorIndex]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const input = { name, color, aliases, isActive };
      const res = employee ? await updateEmployee(employee.id, input) : await createEmployee(input);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(employee ? "Ndryshimet u ruajtën." : `${name.trim()} u shtua.`);
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{employee ? `Ndrysho: ${employee.name}` : "Punonjës i ri"}</DialogTitle>
            <DialogDescription>Ngjyra shfaqet pranë emrit në orar dhe në eksport.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="emp-name">Emri</Label>
            <Input
              id="emp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={60}
              autoFocus
              aria-invalid={Boolean(error)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Ngjyra</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {EMPLOYEE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Ngjyra ${c}`}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  style={{ backgroundColor: c }}
                  className={cn(
                    "size-6 rounded-full ring-offset-2 ring-offset-background transition",
                    color === c && "ring-2 ring-foreground",
                  )}
                />
              ))}
              <input
                type="color"
                aria-label="Ngjyrë e personalizuar"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="size-7 cursor-pointer rounded border bg-transparent p-0.5"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="emp-aliases">Emra alternativë (opsionale)</Label>
            <Input
              id="emp-aliases"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="p.sh. Erik, Eriku"
              maxLength={300}
            />
            <p className="text-xs text-muted-foreground">
              Si shkruhet emri në Excel, të ndarë me presje. Përdoret gjatë importit.
            </p>
          </div>

          <Label className="flex items-center gap-2 font-normal">
            <Switch checked={isActive} onCheckedChange={(v) => setIsActive(Boolean(v))} />
            Aktiv (shfaqet në orar)
          </Label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anulo
            </Button>
            <Button type="submit" disabled={isPending || !name.trim()}>
              {isPending ? "Duke ruajtur…" : "Ruaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
