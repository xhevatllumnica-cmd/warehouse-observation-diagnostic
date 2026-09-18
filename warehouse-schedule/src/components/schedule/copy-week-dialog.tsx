"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { copyWeek } from "@/app/actions/schedule";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatWeekRange, isISODate, startOfWeek, type ISODate } from "@/lib/dates";

export interface CopyWeekRequest {
  source: ISODate;
  target: ISODate;
}

/** Dialog për kopjimin e orarit nga një javë në tjetrën. */
export function CopyWeekDialog({
  request,
  onClose,
}: {
  request: CopyWeekRequest | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (request) {
      setSource(request.source);
      setTarget(request.target);
      setOverwrite(false);
    }
  }, [request]);

  const sourceWeek = isISODate(source) ? startOfWeek(source) : null;
  const targetWeek = isISODate(target) ? startOfWeek(target) : null;
  const valid = sourceWeek && targetWeek && sourceWeek !== targetWeek;

  const submit = () => {
    if (!sourceWeek || !targetWeek) return;
    startTransition(async () => {
      const res = await copyWeek({ sourceWeek, targetWeek, overwrite });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const { copied, skipped, rejected } = res.data;
      const parts = [`${copied} qeliza u kopjuan`];
      if (skipped) parts.push(`${skipped} ekzistuese u lanë të pandryshuara`);
      if (rejected) parts.push(`${rejected} u refuzuan për mbivendosje`);
      toast.success(parts.join(", ") + ".");
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kopjo orarin e javës</DialogTitle>
          <DialogDescription>
            Zgjidhni çdo ditë të javës; kopjohet e gjithë java (E Hënë – E Diel).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="copy-source">Nga java</Label>
            <Input id="copy-source" type="date" value={source} onChange={(e) => setSource(e.target.value)} />
            {sourceWeek && <p className="text-xs text-muted-foreground">{formatWeekRange(sourceWeek)}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="copy-target">Te java</Label>
            <Input id="copy-target" type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
            {targetWeek && <p className="text-xs text-muted-foreground">{formatWeekRange(targetWeek)}</p>}
          </div>
          <Label className="flex items-start gap-2 font-normal">
            <Checkbox checked={overwrite} onCheckedChange={(v) => setOverwrite(Boolean(v))} />
            <span>
              Mbishkruaj qelizat ekzistuese
              <span className="block text-xs text-muted-foreground">
                Përndryshe mbushen vetëm qelizat bosh.
              </span>
            </span>
          </Label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Anulo
          </Button>
          <Button onClick={submit} disabled={!valid || isPending}>
            {isPending ? "Duke kopjuar…" : "Kopjo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
