"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Printer, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { followPageBranch } from "@/lib/branch-sync";

/** "2026-11-20" -> "20/11/2026" (printed filter values). */
const dmy = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : iso);
/** The filter as plain text on paper (the controls are not printed). */
function PrintedFilter({ label, value }: { label: string; value: string }) {
  return <span data-print-filter className="hidden text-[11px] text-[#4A5373] print:inline">{label}: <span className="font-semibold text-[#1E2641]">{value}</span></span>;
}

export function PeriodFilter({ start, end }: { start: string; end: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [s, setS] = React.useState(start);
  const [e, setE] = React.useState(end);
  function apply() {
    const p = new URLSearchParams(sp.toString());
    p.set("start", s); p.set("end", e);
    router.push(`${pathname}?${p.toString()}`);
  }
  return (
    <>
    <PrintedFilter label="Period" value={`${dmy(start)} – ${dmy(end)}`} />
    <div className="flex flex-wrap items-end gap-2 print-hide">
      <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" className="h-8 w-40" value={s} onChange={(ev) => setS(ev.target.value)} /></div>
      <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" className="h-8 w-40" value={e} onChange={(ev) => setE(ev.target.value)} /></div>
      <Button size="sm" onClick={apply}>Apply</Button>
    </div>
    </>
  );
}

export function AsOfFilter({ asOf }: { asOf: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [d, setD] = React.useState(asOf);
  function apply() {
    const p = new URLSearchParams(sp.toString());
    p.set("asOf", d);
    router.push(`${pathname}?${p.toString()}`);
  }
  return (
    <>
    <PrintedFilter label="As of" value={dmy(asOf)} />
    <div className="flex items-end gap-2 print-hide">
      <div className="space-y-1"><Label className="text-xs">As of</Label><Input type="date" className="h-8 w-40" value={d} onChange={(ev) => setD(ev.target.value)} /></div>
      <Button size="sm" onClick={apply}>Apply</Button>
    </div>
    </>
  );
}

export function AccountPicker({ accounts, value }: { accounts: { id: string; code: string; name: string }[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  function onChange(id: string) {
    const p = new URLSearchParams(sp.toString());
    p.set("account", id);
    router.push(`${pathname}?${p.toString()}`);
  }
  const chosen = accounts.find((x) => x.id === value);
  return (
    <>
    {chosen && <PrintedFilter label="Account" value={`${chosen.code} — ${chosen.name}`} />}
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-input bg-card px-2 text-sm print-hide">
      <option value="">Select account…</option>
      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
    </select>
    </>
  );
}

export function ParamSelect({ param, value, options, placeholder }: { param: string; value: string; options: { id: string; label: string }[]; placeholder: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  function onChange(id: string) {
    const p = new URLSearchParams(sp.toString());
    p.set(param, id);
    router.push(`${pathname}?${p.toString()}`);
    // A branch picked here becomes the header branch too.
    if (param === "branch") followPageBranch(id, router.refresh);
  }
  const chosen = options.find((o) => o.id === value)?.label ?? placeholder;
  return (
    <>
    <PrintedFilter label={param === "branch" ? "Branch" : param === "by" ? "Grouped" : param.charAt(0).toUpperCase() + param.slice(1)} value={chosen} />
    <select value={value} onChange={(e) => onChange(e.target.value)} data-branch-filter={param === "branch" ? "" : undefined}
      className="h-8 rounded-md border border-input bg-card px-2 text-sm print-hide">
      {/* For branches the first choice means "all" (an empty filter shows the header branch). */}
      {!(param === "branch" && options.some((o) => o.id === "all")) && <option value={param === "branch" ? "all" : ""}>{placeholder}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
    </>
  );
}

export function PrintButton() {
  return (
    <Button variant="outline" size="sm" className="print-hide" onClick={() => window.print()}>
      <Printer className="h-4 w-4" /> Print
    </Button>
  );
}

/**
 * Builds and downloads a Hilty-style Excel workbook (logo, company, title,
 * filters, date, navy heading row, number formats, filters, A4 page setup).
 */
export async function downloadExcel(opts: { filename: string; header: string[]; rows: (string | number)[][]; title?: string; filters?: string }) {
  const { filename, header, rows } = opts;
  const { default: ExcelJS } = await import("exceljs");
  const title = opts.title || document.querySelector("main h1")?.textContent?.trim() || filename.replace(/\.csv$/i, "");
  const filters = opts.filters ?? Array.from(document.querySelectorAll("[data-print-filter]")).map((e) => e.textContent?.trim()).filter(Boolean).join("   ·   ");
  const company = document.querySelector(".report-letterhead")?.getAttribute("data-company") || "HILTY LIMITED";
  const printed = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

  const wb = new ExcelJS.Workbook();
  wb.creator = "Hilty ERP"; wb.created = new Date();
  const ws = wb.addWorksheet(title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Report", {
    views: [{ state: "frozen", ySplit: 6 }],
    pageSetup: { paperSize: 9, orientation: header.length > 7 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: `&L${company}&C${title}&RPage &P of &N` },
  });
  const cols = Math.max(header.length, 4);

  // Logo (rows 1-3) and letterhead text to the right of it.
  try {
    const res = await fetch("/logo.png");
    const buf = await res.arrayBuffer();
    const img = wb.addImage({ buffer: buf, extension: "png" });
    ws.addImage(img, { tl: { col: 0, row: 0 }, ext: { width: 160, height: 60 } });
  } catch { /* the export still works without the picture */ }
  ws.getRow(1).height = 22; ws.getRow(2).height = 22; ws.getRow(3).height = 18;
  const textCol = Math.min(3, cols);
  const put = (r: number, v: string, font: Partial<import("exceljs").Font>) => { const c = ws.getCell(r, textCol); c.value = v; c.font = font; };
  put(1, company, { name: "Arial", size: 14, bold: true, color: { argb: "FF1E2641" } });
  put(2, title, { name: "Arial", size: 12, bold: true, color: { argb: "FFC0623F" } });
  put(3, [filters, `Printed ${printed}`].filter(Boolean).join("   ·   "), { name: "Arial", size: 9, color: { argb: "FF4A5373" } });
  // Copper and navy rule under the letterhead
  for (let c = 1; c <= cols; c++) ws.getCell(4, c).border = { bottom: { style: "medium", color: { argb: c <= 2 ? "FFC0623F" : "FF1E2641" } } };
  ws.getRow(4).height = 6;

  // Heading row 6, data from row 7.
  const head = ws.getRow(6);
  header.forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E2641" } };
    c.alignment = { vertical: "middle", horizontal: typeof rows[0]?.[i] === "number" ? "right" : "left", wrapText: true };
  });
  head.height = 22;
  rows.forEach((r, ri) => {
    const row = ws.getRow(7 + ri);
    r.forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v === "" ? null : v;
      c.font = { name: "Arial", size: 10, color: { argb: "FF1E2641" } };
      if (typeof v === "number") { c.numFmt = Number.isInteger(v) && Math.abs(v) < 1e6 && !/amount|value|total|cost|price|balance|net|vat|paid|debit|credit|profit|sales|purchases/i.test(header[i] ?? "") ? "#,##0" : "#,##0.00"; c.alignment = { horizontal: "right" }; }
      if (ri % 2 === 1) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F5F9" } };
      c.border = { bottom: { style: "hair", color: { argb: "FFE1E5EF" } } };
    });
  });
  ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6 + Math.max(rows.length, 1), column: header.length } };
  header.forEach((h, i) => {
    const longest = Math.max(h.length, ...rows.slice(0, 500).map((r) => (typeof r[i] === "number" ? (r[i] as number).toLocaleString("en-US", { maximumFractionDigits: 2 }).length + 2 : String(r[i] ?? "").length)));
    ws.getColumn(i + 1).width = Math.min(Math.max(longest + 2, i === 0 ? 14 : 10), 48);
  });

  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename.replace(/\.csv$/i, "") + ".xlsx"; a.click();
  URL.revokeObjectURL(url);
}

/**
 * Exports the report as an Excel workbook in the Hilty style: logo, company,
 * report title, the filters in use and the date, then a navy heading row,
 * number formats, filters and a frozen heading. (Kept under its old name:
 * every report already uses it.)
 */
export function ExportCsvButton({ filename, header, rows }: { filename: string; header: string[]; rows: (string | number)[][] }) {
  const [busy, setBusy] = React.useState(false);
  async function download() {
    setBusy(true);
    try {
      await downloadExcel({ filename, header, rows });
    } finally { setBusy(false); }
  }
  return (
    <Button variant="outline" size="sm" className="print-hide" onClick={download} disabled={busy}>
      <Download className="h-4 w-4" /> {busy ? "Preparing…" : "Excel"}
    </Button>
  );
}
