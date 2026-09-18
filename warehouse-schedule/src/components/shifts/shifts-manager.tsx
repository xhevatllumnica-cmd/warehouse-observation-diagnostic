"use client";

import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { createShift, deleteShift, reorderShifts, updateShift } from "@/app/actions/shifts";
import { Badge } from "@/components/ui/badge";
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
import { SHIFT_CATEGORY_LABELS } from "@/lib/constants";
import { CELL_STYLES, crossesMidnight, shiftCategory, shiftHours } from "@/lib/shifts";
import type { ShiftDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ShiftsManager({
  shifts,
  usage,
}: {
  shifts: ShiftDTO[];
  usage: Record<string, number>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<ShiftDTO | "new" | null>(null);

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
    const ids = shifts.map((s) => s.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    run(() => reorderShifts(ids));
  };

  let hotkey = 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>
          <PlusIcon />
          Shto shift
        </Button>
      </div>

      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Tasti</TableHead>
              <TableHead>Shift-i</TableHead>
              <TableHead className="hidden sm:table-cell">Emërtimi</TableHead>
              <TableHead>Kategoria</TableHead>
              <TableHead className="text-right">Orë</TableHead>
              <TableHead className="hidden text-right md:table-cell">Përdorur</TableHead>
              <TableHead>Aktiv</TableHead>
              <TableHead className="w-40 text-right">Veprime</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shifts.map((s, i) => {
              const key = s.isActive && hotkey < 9 ? ++hotkey : null;
              return (
                <TableRow key={s.id} className={cn(!s.isActive && "text-muted-foreground")}>
                  <TableCell>{key && <kbd className="rounded border px-1.5 text-xs">{key}</kbd>}</TableCell>
                  <TableCell>
                    <span
                      style={s.color ? { backgroundColor: s.color, color: "#0f172a" } : undefined}
                      className={cn(
                        "rounded-md border px-2 py-0.5 font-mono text-xs font-medium",
                        CELL_STYLES[s.category],
                      )}
                    >
                      {s.code}
                    </span>
                    {crossesMidnight(s.startTime, s.endTime) && (
                      <span className="ml-2 text-xs text-muted-foreground">+1 ditë</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {s.label !== s.code ? s.label : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{SHIFT_CATEGORY_LABELS[s.category]}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{shiftHours(s.startTime, s.endTime)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">
                    {usage[s.id] ?? 0}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={s.isActive}
                      disabled={isPending}
                      aria-label={s.isActive ? "Çaktivizo" : "Aktivizo"}
                      onCheckedChange={(v) =>
                        run(() =>
                          updateShift(s.id, {
                            startTime: s.startTime,
                            endTime: s.endTime,
                            label: s.label === s.code ? "" : s.label,
                            color: s.color,
                            isActive: Boolean(v),
                          }),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Lëviz lart"
                        disabled={isPending || i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Lëviz poshtë"
                        disabled={isPending || i === shifts.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Ndrysho" onClick={() => setEditing(s)}>
                        <PencilIcon />
                      </Button>
                      {!usage[s.id] && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Fshi"
                          disabled={isPending}
                          onClick={() => {
                            if (confirm(`Të fshihet shift-i ${s.code}?`)) {
                              run(() => deleteShift(s.id), "Shift-i u fshi.");
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
          </TableBody>
        </Table>
      </div>

      <ShiftDialog
        shift={editing === "new" ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function ShiftDialog({
  shift,
  open,
  onClose,
}: {
  shift: ShiftDTO | null;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [startTime, setStartTime] = useState("07:00");
  const [endTime, setEndTime] = useState("15:00");
  const [label, setLabel] = useState("");
  const [customColor, setCustomColor] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStartTime(shift?.startTime ?? "07:00");
    setEndTime(shift?.endTime ?? "15:00");
    setLabel(shift && shift.label !== shift.code ? shift.label : "");
    setCustomColor(shift?.color ?? null);
    setIsActive(shift?.isActive ?? true);
    setError(null);
  }, [open, shift]);

  const valid = /^\d{2}:\d{2}$/.test(startTime) && /^\d{2}:\d{2}$/.test(endTime) && startTime !== endTime;
  const category = valid ? shiftCategory(startTime, endTime) : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const input = { startTime, endTime, label, color: customColor, isActive };
      const res = shift ? await updateShift(shift.id, input) : await createShift(input);
      if (!res.ok) return setError(res.error);
      toast.success(shift ? "Shift-i u përditësua." : "Shift-i u shtua.");
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{shift ? `Ndrysho ${shift.code}` : "Shift i ri"}</DialogTitle>
            <DialogDescription>
              Nëse ora e mbarimit është para asaj të fillimit, shift-i përfundon ditën tjetër.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="shift-start">Fillon</Label>
              <Input id="shift-start" type="time" step={900} value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="shift-end">Mbaron</Label>
              <Input id="shift-end" type="time" step={900} value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
            </div>
          </div>

          {valid && category && (
            <p className="text-sm text-muted-foreground">
              <span className={cn("mr-2 rounded-md border px-2 py-0.5 font-mono text-xs", CELL_STYLES[category])}>
                {startTime}-{endTime}
              </span>
              {SHIFT_CATEGORY_LABELS[category]} · {shiftHours(startTime, endTime)} orë
              {crossesMidnight(startTime, endTime) && " · përfundon ditën tjetër"}
            </p>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="shift-label">Emërtimi (opsional)</Label>
            <Input
              id="shift-label"
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="p.sh. Mëngjes, Inventar"
            />
          </div>

          <div className="flex items-center gap-3">
            <Label className="flex items-center gap-2 font-normal">
              <Switch
                checked={customColor !== null}
                onCheckedChange={(v) => setCustomColor(v ? "#fde68a" : null)}
              />
              Ngjyrë e personalizuar
            </Label>
            {customColor !== null && (
              <input
                type="color"
                aria-label="Ngjyra"
                value={customColor}
                onChange={(e) => setCustomColor(e.target.value)}
                className="size-7 cursor-pointer rounded border bg-transparent p-0.5"
              />
            )}
          </div>

          <Label className="flex items-center gap-2 font-normal">
            <Switch checked={isActive} onCheckedChange={(v) => setIsActive(Boolean(v))} />
            Aktiv (shfaqet në listën e zgjedhjes)
          </Label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anulo
            </Button>
            <Button type="submit" disabled={!valid || isPending}>
              {isPending ? "Duke ruajtur…" : "Ruaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
