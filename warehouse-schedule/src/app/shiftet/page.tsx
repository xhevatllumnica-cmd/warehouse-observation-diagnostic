import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { ShiftsManager } from "@/components/shifts/shifts-manager";
import { getShifts } from "@/lib/data";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Shift-et" };
export const dynamic = "force-dynamic";

export default async function ShiftsPage() {
  const [shifts, usage] = await Promise.all([
    getShifts(),
    db.scheduleEntry.groupBy({
      by: ["shiftId"],
      where: { shiftId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const usageMap = Object.fromEntries(usage.map((u) => [u.shiftId!, u._count._all]));

  return (
    <>
      <PageHeader
        title="Shift-et"
        description="Lista e paracaktuar që shfaqet kur ndryshoni një qelizë. 12 shift-et e para aktive kanë shkurtore 1–9."
      />
      <div className="p-4 md:p-6">
        <ShiftsManager shifts={shifts} usage={usageMap} />
      </div>
    </>
  );
}
