"use client";

import { CheckCircle2Icon, FileSpreadsheetIcon, UploadIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { importExcel } from "@/app/actions/import";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { ImportResult } from "@/lib/import/import-service";

export function ImportForm() {
  const [isPending, startTransition] = useTransition();
  const [fileName, setFileName] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const submit = (formData: FormData) => {
    if (overwrite) formData.set("overwrite", "on");
    startTransition(async () => {
      const res = await importExcel(formData);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setResult(res.data);
      toast.success(`Importi përfundoi: ${res.data.entriesWritten} qeliza.`);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Skedari</CardTitle>
          <CardDescription>
            Çdo fletë është një muaj; çdo javë fillon me një rresht me datat në kolonat B–H, pasuar nga
            punonjësit. Datat me gabime shtypi korrigjohen automatikisht.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={submit} className="flex flex-col gap-4">
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors hover:bg-muted/50">
              <FileSpreadsheetIcon className="size-8 text-muted-foreground" />
              <span className="text-sm font-medium">{fileName ?? "Kliko për të zgjedhur .xlsx"}</span>
              <span className="text-xs text-muted-foreground">Maksimumi 10 MB</span>
              <input
                type="file"
                name="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                required
                className="sr-only"
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
              />
            </label>

            <Label className="flex items-start gap-2 font-normal">
              <Checkbox checked={overwrite} onCheckedChange={(v) => setOverwrite(Boolean(v))} />
              <span>
                Mbishkruaj qelizat ekzistuese
                <span className="block text-xs text-muted-foreground">
                  Përndryshe importohen vetëm ditët që janë bosh në aplikacion — ndryshimet e bëra këtu
                  ruhen.
                </span>
              </span>
            </Label>

            <Button type="submit" disabled={isPending || !fileName} className="self-start">
              <UploadIcon />
              {isPending ? "Duke importuar…" : "Importo"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2Icon className="size-5 text-emerald-500" />
              Rezultati
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ["Javë", result.weeks],
                ["Qeliza të shkruara", result.entriesWritten],
                ["Qeliza të kapërcyera", result.entriesSkipped],
                ["Punonjës / shift-e të rinj", `${result.employeesCreated} / ${result.shiftsCreated}`],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-lg bg-muted p-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            {result.issues.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  Shënime ({result.issues.length})
                </summary>
                <ul className="mt-2 max-h-72 list-disc overflow-y-auto pl-5 font-mono text-xs text-muted-foreground">
                  {result.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
