import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireActiveUser } from "@/lib/auth/guards";
import { getPrimaryCompanyId } from "@/lib/admin/queries";
import { loadLetterhead, printedAtText } from "@/lib/print/letterhead";
import { loadPrintDoc, PRINT_KINDS, type PrintKind } from "@/lib/print/documents";
import { DocumentPage } from "@/components/print/document";

type Params = Promise<{ kind: string; id: string }>;

async function load(params: Params) {
  const { kind, id } = await params;
  if (!(PRINT_KINDS as readonly string[]).includes(kind)) return null;
  const user = await requireActiveUser();
  const companyId = await getPrimaryCompanyId(user.defaultCompanyId);
  const loaded = await loadPrintDoc(kind as PrintKind, id, user, companyId);
  return loaded ? { ...loaded, user, companyId } : null;
}

export async function generateMetadata(props: { params: Params }): Promise<Metadata> {
  const l = await load(props.params);
  // The browser uses the title as the PDF file name.
  return { title: { absolute: l?.fileTitle ?? "Document" } };
}

/** Printable Hilty document: /print/<kind>/<id> (invoice, receipt, voucher, note...). */
export default async function PrintDocumentPage(props: { params: Params }) {
  const l = await load(props.params);
  if (!l) notFound();
  const company = await loadLetterhead(l.companyId);
  return <DocumentPage doc={l.doc} company={company} branch={l.branch} printedBy={l.user.fullName ?? l.user.email} printedAt={printedAtText()} />;
}
