import type { Metadata } from "next";
import { ImportForm } from "@/components/import/import-form";
import { PageHeader } from "@/components/layout/page-header";

export const metadata: Metadata = { title: "Importo" };

export default function ImportPage() {
  return (
    <>
      <PageHeader
        title="Importo nga Excel"
        description="Ngarkoni skedarin “Schedule warehouse team” (.xlsx) në formatin me blloqe javore."
      />
      <div className="max-w-3xl p-4 md:p-6">
        <ImportForm />
      </div>
    </>
  );
}
