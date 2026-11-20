import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export interface Letterhead {
  name: string;
  legalName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
}

/** Company details printed on every document and report. */
export async function loadLetterhead(companyId: string): Promise<Letterhead> {
  const { data } = await createAdminClient().from("companies")
    .select("name, legal_name, address, phone, email").eq("id", companyId).maybeSingle();
  return {
    name: data?.name ?? "Hilty Limited",
    legalName: data?.legal_name && data.legal_name !== data.name ? data.legal_name : null,
    address: data?.address ?? null,
    phone: data?.phone ?? null,
    email: data?.email ?? null,
  };
}

/** "20 Nov 2026, 10:15" (Dar es Salaam) - when a document or report is printed. */
export function printedAtText(): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}
