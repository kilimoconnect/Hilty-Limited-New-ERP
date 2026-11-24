import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActiveUser } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { isFeatureEnabled, type FeatureFlag } from "@/lib/features";
import { REPORTS, reportPermission } from "@/lib/reports/catalog";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Reports" };

/** Every report the user may open (each report has its own permission). */
export default async function ReportsIndex() {
  await requireActiveUser();
  const ctx = await getActiveContext();
  const features = new Map<string, boolean>();
  for (const f of new Set(REPORTS.map((r) => r.feature).filter(Boolean) as string[])) features.set(f, await isFeatureEnabled(ctx.companyId, f as FeatureFlag));
  const items = REPORTS.filter((r) => can(ctx.user, reportPermission(r.slug)) && (!r.feature || features.get(r.feature)));
  if (items.length === 0) redirect("/unauthorized");
  return (
    <div>
      <PageHeader title="Reports" description="Choose a report. Each one can be given to a role on its own." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((r) => (
          <Link key={r.href} href={r.href}>
            <Card className="h-full transition-colors hover:border-primary"><CardContent className="p-5">
              <p className="font-medium">{r.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{r.desc}</p>
            </CardContent></Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
