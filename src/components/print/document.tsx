import type { Letterhead } from "@/lib/print/letterhead";
import { PrintToolbar } from "./print-toolbar";

/** One printable business document (invoice, voucher, note...). Everything is already formatted text. */
export interface PrintDoc {
  /** e.g. "TAX INVOICE", "PAYMENT VOUCHER". */
  title: string;
  number: string | null;
  /** draft / voided are stamped across the page. */
  status?: "draft" | "posted" | "voided" | string;
  /** Right-hand details under the number: Date, Due date, Reference... */
  meta: { label: string; value: string | null | undefined }[];
  /** Boxes such as "Bill to", "Supplier", "Deliver to". */
  parties?: { heading: string; lines: (string | null | undefined)[] }[];
  table?: {
    columns: { label: string; align?: "left" | "right" | "center"; width?: string }[];
    rows: (string | number | null | undefined)[][];
    /** Text when the table is empty. */
    empty?: string;
  };
  totals?: { label: string; value: string; strong?: boolean }[];
  /** Small two-column blocks after the table, e.g. "Payments". */
  sections?: { heading: string; rows: { label: string; value: string }[] }[];
  notes?: string | null;
  /** Line at the very bottom, e.g. "Thank you for your business." */
  closing?: string;
}

const NAVY = "#1E2641";
const COPPER = "#C0623F";

/**
 * The Hilty document layout: letterhead with the logo, a navy title band,
 * party boxes, a navy-headed table, totals and a footer. A4, prints in colour
 * ("Save as PDF" in the print window for a PDF).
 */
export function DocumentPage({ doc, company, branch, printedBy, printedAt }: {
  doc: PrintDoc; company: Letterhead; branch?: { name: string; address?: string | null; phone?: string | null } | null;
  printedBy?: string | null; printedAt: string;
}) {
  const stamp = doc.status === "voided" ? "VOIDED" : doc.status === "draft" ? "DRAFT" : null;
  const contact = [company.phone, company.email].filter(Boolean).join("  ·  ");

  return (
    <div className="min-h-screen bg-[#E9EBF1] py-6 print:bg-white print:py-0">
      <style>{`
        @page { size: A4; margin: 12mm 12mm 14mm; }
        @media print {
          html, body { background: #fff !important; }
          .doc-sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; min-height: 0 !important; padding: 0 !important; }
          .doc-sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          thead { display: table-header-group; }
          tr, .doc-avoid { break-inside: avoid; }
        }
      `}</style>
      <PrintToolbar />
      <div className="doc-sheet relative mx-auto flex w-[210mm] min-h-[297mm] flex-col bg-white px-[14mm] py-[12mm] text-[13px] text-[#1E2641] shadow-xl" style={{ fontFamily: "var(--font-archivo), Arial, Helvetica, sans-serif" }}>
        {stamp && (
          <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
            <span className="rotate-[-28deg] select-none text-[120px] font-black tracking-[0.15em]" style={{ color: stamp === "VOIDED" ? "rgba(192,38,38,0.10)" : "rgba(30,38,65,0.07)" }}>{stamp}</span>
          </div>
        )}

        {/* Letterhead */}
        <header className="flex items-start justify-between gap-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/hilty-logo.svg" alt="Hilty Limited" className="h-[64px] w-auto" />
          <div className="text-right text-[11px] leading-relaxed text-[#4A5373]">
            <p className="text-[14px] font-bold tracking-wide text-[#1E2641]">{(company.legalName ?? company.name).toUpperCase()}</p>
            {company.address && <p>{company.address}</p>}
            {contact && <p>{contact}</p>}
            {branch && <p className="font-medium text-[#1E2641]">Branch: {branch.name}{branch.phone ? `  ·  ${branch.phone}` : ""}</p>}
          </div>
        </header>
        <div className="mt-4 flex items-center gap-0">
          <div className="h-[4px] w-24" style={{ background: COPPER }} />
          <div className="h-px flex-1" style={{ background: NAVY }} />
        </div>

        {/* Title band */}
        <section className="mt-6 flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[26px] font-black leading-none tracking-wide" style={{ color: NAVY }}>{doc.title}</h1>
            {doc.number && <p className="mt-2 font-mono text-[13px] font-semibold text-[#4A5373]">No. {doc.number}</p>}
            {stamp && <p className="mt-2 inline-block rounded px-2 py-0.5 text-[10px] font-bold tracking-widest text-white" style={{ background: stamp === "VOIDED" ? "#B42318" : "#4A5373" }}>{stamp}</p>}
          </div>
          <table className="text-[12px]">
            <tbody>
              {doc.meta.filter((m) => m.value).map((m) => (
                <tr key={m.label}>
                  <td className="py-0.5 pr-4 text-right uppercase tracking-wider text-[10px] text-[#4A5373]">{m.label}</td>
                  <td className="py-0.5 text-right font-semibold">{m.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Parties */}
        {doc.parties && doc.parties.length > 0 && (
          <section className={`mt-6 grid gap-4 ${doc.parties.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {doc.parties.map((p) => (
              <div key={p.heading} className="doc-avoid rounded-md border border-[#E1E5EF] bg-[#F7F8FB] px-4 py-3">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: COPPER }}>{p.heading}</p>
                {p.lines.filter(Boolean).map((l, i) => <p key={i} className={i === 0 ? "text-[14px] font-semibold" : "text-[12px] text-[#4A5373]"}>{l}</p>)}
              </div>
            ))}
          </section>
        )}

        {/* Lines */}
        {doc.table && (
          <section className="mt-6">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr style={{ background: NAVY }}>
                  {doc.table.columns.map((c, i) => (
                    <th key={i} className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left"}`} style={c.width ? { width: c.width } : undefined}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {doc.table.rows.length === 0 && (
                  <tr><td colSpan={doc.table.columns.length} className="px-3 py-6 text-center text-[#4A5373]">{doc.table.empty ?? "No lines."}</td></tr>
                )}
                {doc.table.rows.map((r, i) => (
                  <tr key={i} className={i % 2 ? "bg-[#F7F8FB]" : ""}>
                    {r.map((v, j) => {
                      const c = doc.table!.columns[j];
                      return <td key={j} className={`whitespace-pre-line border-b border-[#E1E5EF] px-3 py-2 align-top ${c?.align === "right" ? "text-right tabular-nums" : c?.align === "center" ? "text-center" : ""}`}>{v ?? ""}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Totals and other blocks */}
        {(doc.totals?.length || doc.sections?.length) ? (
          <section className="doc-avoid mt-5 flex items-start justify-between gap-6">
            <div className="flex-1 space-y-4">
              {doc.sections?.map((s) => (
                <div key={s.heading}>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: COPPER }}>{s.heading}</p>
                  <table className="text-[12px]"><tbody>
                    {s.rows.map((r, i) => <tr key={i}><td className="py-0.5 pr-6 text-[#4A5373]">{r.label}</td><td className="py-0.5 text-right font-medium tabular-nums">{r.value}</td></tr>)}
                  </tbody></table>
                </div>
              ))}
            </div>
            {doc.totals && doc.totals.length > 0 && (
              <table className="w-[78mm] text-[12px]">
                <tbody>
                  {doc.totals.map((t, i) => t.strong ? (
                    <tr key={i} style={{ background: NAVY }}>
                      <td className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white">{t.label}</td>
                      <td className="px-3 py-2 text-right text-[14px] font-bold tabular-nums text-white">{t.value}</td>
                    </tr>
                  ) : (
                    <tr key={i} className="border-b border-[#E1E5EF]">
                      <td className="px-3 py-1.5 text-[#4A5373]">{t.label}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{t.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ) : null}

        {doc.notes && (
          <section className="doc-avoid mt-6 rounded-md border-l-4 bg-[#F7F8FB] px-4 py-3 text-[12px]" style={{ borderColor: COPPER }}>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: COPPER }}>Notes</p>
            <p className="whitespace-pre-wrap text-[#1E2641]">{doc.notes}</p>
          </section>
        )}

        {/* Footer */}
        <footer className="mt-auto pt-10">
          {doc.closing && <p className="mb-3 text-center text-[12px] font-medium" style={{ color: NAVY }}>{doc.closing}</p>}
          <div className="flex items-center gap-0"><div className="h-px flex-1 bg-[#E1E5EF]" /></div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-[#4A5373]">
            <span>{company.name}{company.address ? `  ·  ${company.address}` : ""}{contact ? `  ·  ${contact}` : ""}</span>
            <span>Printed {printedAt}{printedBy ? ` by ${printedBy}` : ""}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
