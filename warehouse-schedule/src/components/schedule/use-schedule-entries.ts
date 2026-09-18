"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { saveCells } from "@/app/actions/schedule";
import { formatDate } from "@/lib/dates";
import { entryKey, type CellChange, type EntryDTO } from "@/lib/types";

const MAX_UNDO = 50;

function toMap(entries: EntryDTO[]) {
  return new Map(entries.map((e) => [entryKey(e.employeeId, e.date), e]));
}

/** Ndryshimet e kundërta (për "Zhbëj") për qelizat që serveri i pranoi. */
function inverseChanges(
  applied: CellChange[],
  before: Map<string, EntryDTO | undefined>,
  rejected: Set<string>,
): CellChange[] {
  return applied
    .filter((c) => !rejected.has(entryKey(c.employeeId, c.date)))
    .map((c) => {
      const prev = before.get(entryKey(c.employeeId, c.date));
      return {
        employeeId: c.employeeId,
        date: c.date,
        value: prev ? { status: prev.status, shiftId: prev.shiftId, notes: prev.notes } : null,
      };
    });
}

/**
 * Gjendja e qelizave të orarit në klient.
 *
 * - Ndryshimet shfaqen menjëherë (optimistic) dhe ruhen në server.
 * - Nëse serveri refuzon një qelizë (p.sh. mbivendosje), ajo kthehet mbrapsht.
 * - Mban historikun për "Zhbëj" (Ctrl+Z).
 */
export function useScheduleEntries(
  initial: EntryDTO[],
  employeeNames: Map<string, string>,
) {
  const [entries, setEntries] = useState(() => toMap(initial));
  const [pending, setPending] = useState(0);
  const undoStack = useRef<CellChange[][]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // Të dhëna të reja nga serveri (p.sh. pas "Kopjo javën" + router.refresh()).
  useEffect(() => {
    setEntries(toMap(initial));
  }, [initial]);

  const apply = useCallback(
    async (changes: CellChange[], opts: { recordUndo?: boolean } = {}) => {
      const current = entriesRef.current;
      const effective = changes.filter((c) => {
        const existing = current.get(entryKey(c.employeeId, c.date));
        if (!c.value) return Boolean(existing);
        return (
          !existing ||
          existing.status !== c.value.status ||
          existing.shiftId !== c.value.shiftId ||
          (c.value.notes !== undefined && (existing.notes ?? null) !== (c.value.notes ?? null))
        );
      });
      if (effective.length === 0) return;

      // Gjendja e mëparshme e qelizave të prekura, për kthim mbrapsht / zhbërje.
      const before = new Map(
        effective.map((c) => {
          const key = entryKey(c.employeeId, c.date);
          return [key, current.get(key)] as const;
        }),
      );

      setEntries((m) => {
        const next = new Map(m);
        for (const c of effective) {
          const key = entryKey(c.employeeId, c.date);
          if (!c.value) next.delete(key);
          else
            next.set(key, {
              employeeId: c.employeeId,
              date: c.date,
              status: c.value.status,
              shiftId: c.value.shiftId,
              notes: c.value.notes !== undefined ? c.value.notes : (m.get(key)?.notes ?? null),
            });
        }
        return next;
      });

      const revert = (keys: string[]) =>
        setEntries((m) => {
          const next = new Map(m);
          for (const key of keys) {
            const prev = before.get(key);
            if (prev) next.set(key, prev);
            else next.delete(key);
          }
          return next;
        });

      setPending((n) => n + 1);
      try {
        const res = await saveCells(effective);
        if (!res.ok) {
          revert([...before.keys()]);
          toast.error(res.error);
          return;
        }
        const { saved, rejected } = res.data;
        if (saved.length > 0) {
          setEntries((m) => {
            const next = new Map(m);
            for (const e of saved) next.set(entryKey(e.employeeId, e.date), e);
            return next;
          });
        }
        const rejectedKeys = new Set(rejected.map((r) => entryKey(r.employeeId, r.date)));
        const inverse = inverseChanges(effective, before, rejectedKeys);
        if (opts.recordUndo !== false && inverse.length > 0) {
          undoStack.current.push(inverse);
          if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
        }
        if (rejected.length > 0) {
          revert([...rejectedKeys]);
          const first = rejected[0];
          toast.error(
            rejected.length === 1
              ? `${employeeNames.get(first.employeeId) ?? ""}, ${formatDate(first.date)}: ${first.message}`
              : `${rejected.length} qeliza u refuzuan. ${first.message}`,
          );
        }
      } catch {
        revert([...before.keys()]);
        toast.error("Ruajtja dështoi. Kontrolloni lidhjen dhe provoni sërish.");
      } finally {
        setPending((n) => n - 1);
      }
    },
    [employeeNames],
  );

  const undo = useCallback(() => {
    const last = undoStack.current.pop();
    if (!last) {
      toast.info("Nuk ka asgjë për të zhbërë.");
      return;
    }
    void apply(last, { recordUndo: false });
  }, [apply]);

  return { entries, apply, undo, saving: pending > 0 };
}
