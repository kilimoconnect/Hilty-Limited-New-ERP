"use client";

import * as React from "react";
import { Download, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { ClickableRow } from "@/components/common/clickable-row";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadExcel } from "@/components/reports/report-tools";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { Letterhead } from "@/lib/print/letterhead";

export interface StockRow {
  id: string; sku: string; name: string; group: string; branchCode: string; branchName: string; unit: string;
  qty: number; inTransit: number; avgCost: number; value: number; status: "negative" | "low" | "active" | "inactive"; href: string;
}
/** What the PDF print view reads (sessionStorage key below). */
export interface StockPrintPayload {
  title: string; filters: string; showCost: boolean; company: Letterhead; printedBy: string; rows: StockRow[];
}
export const STOCK_PRINT_KEY = "hilty:print:stock";

/**
 * Current Stock with selection: tick rows (or the whole page, or every row
 * matching the filters) and export them to Excel or PDF. Nothing ticked =
 * export everything matching the filters.
 */
export function StockTable({ pageRows, allRows, showCost, filters, company, printedBy }: {
  pageRows: StockRow[]; allRows: StockRow[]; showCost: boolean; filters: string; company: Letterhead; printedBy: string;
}) {
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const pageIds = pageRows.map((r) => r.id);
  const pageAll = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const pageSome = pageIds.some((id) => picked.has(id));
  const everything = picked.size === allRows.length && allRows.length > 0;
  const chosen = picked.size ? allRows.filter((r) => picked.has(r.id)) : allRows;
  const label = picked.size ? `${picked.size} selected` : `all ${allRows.length}`;

  const flip = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const flipPage = () => setPicked((p) => { const n = new Set(p); if (pageAll) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id)); return n; });

  const header = ["SKU", "Product", "Category / brand", "Branch", "Unit", "On hand", "In transit", ...(showCost ? ["Avg cost", "Stock value"] : []), "Status"];
  const STATUS = { negative: "Negative", low: "Low", active: "Active", inactive: "Inactive" } as const;

  async function excel() {
    setBusy(true);
    try {
      await downloadExcel({
        filename: `current-stock-${new Date().toISOString().slice(0, 10)}`,
        title: "Current Stock", filters: [filters, picked.size ? `${picked.size} selected items` : ""].filter(Boolean).join("   ·   "), header,
        rows: chosen.map((r) => [r.sku, r.name, r.group, r.branchCode, r.unit, r.qty, r.inTransit, ...(showCost ? [r.avgCost, r.value] : []), STATUS[r.status]]),
      });
    } finally { setBusy(false); }
  }
  function pdf() {
    const payload: StockPrintPayload = {
      title: "Current Stock", filters: [filters, picked.size ? `${picked.size} selected items` : ""].filter(Boolean).join("  ·  "),
      showCost, company, printedBy, rows: chosen,
    };
    try { localStorage.setItem(STOCK_PRINT_KEY, JSON.stringify(payload)); } catch { /* storage full or blocked */ }
    window.open("/print/stock", "_blank", "noopener");
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <span className="text-muted-foreground">
          {picked.size ? <><span className="font-medium text-foreground">{picked.size}</span> selected
            <button type="button" onClick={() => setPicked(new Set())} className="ml-2 inline-flex items-center gap-1 text-xs underline hover:text-foreground"><X className="h-3 w-3" /> Clear</button></>
            : <>Tick items to export only those; otherwise all {allRows.length} matching items are exported.</>}
          {pageAll && !everything && allRows.length > pageIds.length && (
            <button type="button" onClick={() => setPicked(new Set(allRows.map((r) => r.id)))} className="ml-3 font-medium text-primary hover:underline">
              Select all {allRows.length} matching
            </button>
          )}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={excel} disabled={busy || allRows.length === 0}><Download className="h-4 w-4" /> {busy ? "Preparing…" : `Excel (${label})`}</Button>
          <Button variant="outline" size="sm" onClick={pdf} disabled={allRows.length === 0}><FileText className="h-4 w-4" /> PDF ({label})</Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input type="checkbox" aria-label="Select this page" checked={pageAll}
                  ref={(el) => { if (el) el.indeterminate = !pageAll && pageSome; }} onChange={flipPage} />
              </TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">In transit</TableHead>
              {showCost && <TableHead className="text-right">Avg cost</TableHead>}
              {showCost && <TableHead className="text-right">Value</TableHead>}
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((r) => (
              // Click a row: that item's Kardex at this branch (the tick box only selects).
              <ClickableRow key={r.id} href={r.href} title="Open this item's Kardex" className={picked.has(r.id) ? "bg-primary/5" : undefined}>
                <TableCell><input type="checkbox" aria-label={`Select ${r.name}`} checked={picked.has(r.id)} onChange={() => flip(r.id)} /></TableCell>
                <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                <TableCell>
                  <div className="font-medium text-primary">{r.name}</div>
                  <div className="text-xs text-muted-foreground">{r.group || "—"}</div>
                </TableCell>
                <TableCell className="text-sm">{r.branchCode}</TableCell>
                <TableCell className="text-right tabular-nums">{formatQuantity(r.qty)} {r.unit}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{r.inTransit > 0 ? formatQuantity(r.inTransit) : "—"}</TableCell>
                {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.avgCost)}</TableCell>}
                {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.value)}</TableCell>}
                <TableCell>
                  {r.status === "negative" ? <Badge variant="destructive">Negative</Badge>
                    : r.status === "low" ? <Badge variant="warning">Low</Badge>
                    : <StatusBadge active={r.status === "active"} />}
                </TableCell>
              </ClickableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
