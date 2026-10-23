import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { PositionsManager } from "@/components/positions/positions-manager";
import { getEmployees, getPositions } from "@/lib/data";

export const metadata: Metadata = { title: "Pozitat" };
export const dynamic = "force-dynamic";

export default async function PositionsPage() {
  const [positions, employees] = await Promise.all([getPositions(), getEmployees({ activeOnly: true })]);
  const members: Record<string, string[]> = {};
  for (const e of employees) if (e.positionId) (members[e.positionId] ??= []).push(e.name);
  const unassigned = employees.filter((e) => !e.positionId).length;

  return (
    <>
      <PageHeader
        title="Pozitat"
        description={`Pozitat e punës në depo dhe kush i mbulon. ${unassigned ? `${unassigned} punonjës aktivë pa pozitë — caktojeni te Punonjësit.` : "Të gjithë punonjësit aktivë kanë pozitë."}`}
      />
      <div className="p-4 md:p-6">
        <PositionsManager positions={positions} members={members} />
      </div>
    </>
  );
}
