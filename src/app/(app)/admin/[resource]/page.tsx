import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireOwnerPage } from "@/lib/auth/guards";
import { getResource } from "@/lib/admin/resources";
import {
  getPrimaryCompanyId,
  loadResourceOptions,
  loadResourceRows,
} from "@/lib/admin/queries";
import { pageSizeOf } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { ResourceManager } from "@/components/admin/resource-manager";


type ResourcePageProps = {
  params: Promise<{ resource: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(
  props: ResourcePageProps,
): Promise<Metadata> {
  const { resource } = await props.params;
  const config = getResource(resource);
  return { title: config ? config.title : "Admin" };
}

export default async function AdminResourcePage(props: ResourcePageProps) {
  const { resource } = await props.params;
  const config = getResource(resource);
  if (!config) notFound();

  const user = await requireOwnerPage();
  const companyId = await getPrimaryCompanyId(user.defaultCompanyId);

  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const statusRaw = typeof sp.status === "string" ? sp.status : "active";
  const status = (["active", "inactive", "all"].includes(statusRaw)
    ? statusRaw
    : "active") as "active" | "inactive" | "all";
  const page = typeof sp.page === "string" ? Math.max(1, parseInt(sp.page, 10) || 1) : 1;
  const pageSize = pageSizeOf(sp);
  // Per-column filters for columns that point at another list (?f_category_id=...).
  const filters: Record<string, string> = {};
  for (const col of config.columns) {
    const v = sp[`f_${col.key}`];
    if (col.type === "ref" && typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) filters[col.key] = v;
  }

  const [options, list] = await Promise.all([
    loadResourceOptions(config, companyId),
    loadResourceRows(config, companyId, { q, status, page, pageSize, filters }),
  ]);

  return (
    <div>
      <PageHeader title={config.title} description={config.description} />
      <ResourceManager
        config={config}
        rows={list.rows}
        total={list.total}
        page={list.page}
        pageSize={list.pageSize}
        options={options}
        query={{ q, status }}
        filters={filters}
      />
    </div>
  );
}
