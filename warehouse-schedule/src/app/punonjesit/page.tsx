import type { Metadata } from "next";
import { EmployeesManager } from "@/components/employees/employees-manager";
import { PageHeader } from "@/components/layout/page-header";
import { getEmployees } from "@/lib/data";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Punonjësit" };
export const dynamic = "force-dynamic";

export default async function EmployeesPage() {
  const [employees, usage] = await Promise.all([
    getEmployees(),
    db.scheduleEntry.groupBy({
      by: ["employeeId"],
      _count: { _all: true },
      _max: { date: true },
    }),
  ]);
  const usageMap = Object.fromEntries(
    usage.map((u) => [u.employeeId, { days: u._count._all, lastDate: u._max.date }]),
  );
  const active = employees.filter((e) => e.isActive).length;

  return (
    <>
      <PageHeader
        title="Punonjësit"
        description={`${active} aktivë · ${employees.length - active} joaktivë`}
      />
      <div className="p-4 md:p-6">
        <EmployeesManager employees={employees} usage={usageMap} />
      </div>
    </>
  );
}
