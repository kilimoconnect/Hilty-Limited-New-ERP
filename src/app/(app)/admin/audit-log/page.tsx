import type { Metadata } from "next";
import { requireOwnerPage } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { ListToolbar } from "@/components/common/list-toolbar";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { localDayStart, localDayEnd } from "@/lib/format";
import { AuditTable, type AuditRow } from "./audit-table";

export const metadata: Metadata = { title: "Audit Log" };

export default async function AuditLogPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwnerPage();
  const admin = createAdminClient();

  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  const from = (page - 1) * size;
  const to = from + size - 1;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const term = q.replace(/[,()]/g, " ").trim();
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");

  let query = admin
    .from("audit_logs")
    .select(
      "id, created_at, action, resource_type, resource_id, reason, user_id, ip_address, old_values, new_values",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to);
  if (from_) query = query.gte("created_at", localDayStart(from_));
  if (to_) query = query.lte("created_at", localDayEnd(to_));
  if (term) query = query.or(`action.ilike.%${term}%,resource_type.ilike.%${term}%,reason.ilike.%${term}%`);
  const { data, count } = await query;

  const rows = (data ?? []) as (Omit<AuditRow, "user_email"> & { user_id: string | null })[];

  // Resolve user emails.
  const userIds = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean))) as string[];
  const emailMap = new Map<string, string>();
  if (userIds.length) {
    const { data: users } = await admin
      .from("user_profiles")
      .select("id, email")
      .in("id", userIds);
    for (const u of users ?? []) emailMap.set(u.id, u.email);
  }

  const auditRows: AuditRow[] = rows.map((r) => ({
    ...r,
    user_email: r.user_id ? emailMap.get(r.user_id) ?? null : null,
  }));

  const total = count ?? 0;

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="Immutable record of administrative activity. Records cannot be edited or deleted."
      />
      <ListToolbar searchValue={q} searchPlaceholder="Search action, record type or reason..." dates={{ from: from_, to: to_ }} />
      <AuditTable rows={auditRows} />

      <Pager basePath="/admin/audit-log" params={{ q, from: from_, to: to_ }} page={page} pageSize={size} total={total} />
    </div>
  );
}
