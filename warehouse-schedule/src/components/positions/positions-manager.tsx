"use client";

import { ArrowDownIcon, ArrowUpIcon, ListPlusIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  addDefaultPositions,
  createPosition,
  deletePosition,
  reorderPositions,
  updatePosition,
} from "@/app/actions/positions";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EMPLOYEE_COLORS } from "@/lib/constants";
import type { PositionDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PositionsManager({
  positions,
  members,
}: {
  positions: PositionDTO[];
  /** positionId → emrat e punonjësve aktivë me këtë pozitë */
  members: Record<string, string[]>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<PositionDTO | "new" | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) =>
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error);
      else {
        if (success) toast.success(success);
        router.refresh();
      }
    });

  const move = (index: number, dir: -1 | 1) => {
    const ids = positions.map((p) => p.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    run(() => reorderPositions(ids));
  };

  const addDefaults = () =>
    startTransition(async () => {
      const res = await addDefaultPositions();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.data.added ? `U shtuan ${res.data.added} pozita.` : "Pozitat standarde ekzistojnë tashmë.");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={isPending} onClick={addDefaults}>
          <ListPlusIcon />
          Shto pozitat standarde
        </Button>
        <Button onClick={() => setEditing("new")}>
          <PlusIcon />
          Shto pozitë
        </Button>
      </div>

      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pozita</TableHead>
              <TableHead className="hidden md:table-cell">Përshkrimi</TableHead>
              <TableHead className="text-right">Punonjës</TableHead>
              <TableHead className="hidden lg:table-cell">Kush e mbulon</TableHead>
              <TableHead>Aktiv</TableHead>
              <TableHead className="w-40 text-right">Veprime</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((p, i) => {
              const names = members[p.id] ?? [];
              return (
                <TableRow key={p.id} className={cn(!p.isActive && "text-muted-foreground")}>
                  <TableCell>
                    <span className="flex items-center gap-2 font-medium">
                      <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: p.color }} aria-hidden />
                      {p.name}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{p.description || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{names.length}</TableCell>
                  <TableCell className="hidden max-w-80 truncate text-muted-foreground lg:table-cell" title={names.join(", ")}>
                    {names.length ? names.join(", ") : "—"}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={p.isActive}
                      disabled={isPending}
                      aria-label={p.isActive ? "Çaktivizo" : "Aktivizo"}
                      onCheckedChange={(v) =>
                        run(() =>
                          updatePosition(p.id, {
                            name: p.name,
                            description: p.description,
                            color: p.color,
                            isActive: Boolean(v),
                          }),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="icon-sm" aria-label="Lëviz lart" disabled={isPending || i === 0} onClick={() => move(i, -1)}>
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Lëviz poshtë"
                        disabled={isPending || i === positions.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Ndrysho" onClick={() => setEditing(p)}>
                        <PencilIcon />
                      </Button>
                      {names.length === 0 && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Fshi"
                          disabled={isPending}
                          onClick={() => {
                            if (confirm(`Të fshihet pozita ${p.name}?`)) run(() => deletePosition(p.id), "Pozita u fshi.");
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
            {positions.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  Asnjë pozitë ende — shtoni pozitat standarde (Check-in, Mapim, Picking, Check-out…) ose një pozitë të re.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Pozita e secilit punonjës caktohet te Punonjësit (✏️). Pozitat me punonjës nuk fshihen — çaktivizojini.
      </p>

      <PositionDialog
        position={editing === "new" ? null : editing}
        open={editing !== null}
        defaultColorIndex={positions.length}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function PositionDialog({
  position,
  open,
  defaultColorIndex,
  onClose,
}: {
  position: PositionDTO | null;
  open: boolean;
  defaultColorIndex: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(EMPLOYEE_COLORS[0]);
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(position?.name ?? "");
    setDescription(position?.description ?? "");
    setColor(position?.color ?? EMPLOYEE_COLORS[(defaultColorIndex * 3) % EMPLOYEE_COLORS.length]);
    setIsActive(position?.isActive ?? true);
    setError(null);
  }, [open, position, defaultColorIndex]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const input = { name, description, color, isActive };
      const res = position ? await updatePosition(position.id, input) : await createPosition(input);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(position ? "Pozita u përditësua." : `${name.trim()} u shtua.`);
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{position ? `Ndrysho: ${position.name}` : "Pozitë e re"}</DialogTitle>
            <DialogDescription>P.sh. Check-in, Mapim, Check-out — hapat e punës në depo.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="pos-name">Emri</Label>
            <Input id="pos-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} autoFocus aria-invalid={Boolean(error)} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="pos-desc">Përshkrimi (opsional)</Label>
            <Input id="pos-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Detyrat kryesore" />
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
                  className={cn("size-6 rounded-full ring-offset-2 ring-offset-background transition", color === c && "ring-2 ring-foreground")}
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

          <Label className="flex items-center gap-2 font-normal">
            <Switch checked={isActive} onCheckedChange={(v) => setIsActive(Boolean(v))} />
            Aktive (shfaqet në listën e zgjedhjes)
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
