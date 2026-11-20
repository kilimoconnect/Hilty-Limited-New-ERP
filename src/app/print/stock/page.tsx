"use client";

import * as React from "react";
import { DocumentPage, type PrintDoc } from "@/components/print/document";
import { STOCK_PRINT_KEY, type StockPrintPayload } from "@/app/(app)/inventory/stock-table";
import { formatMoney, formatQuantity } from "@/lib/format";

const read = () => { try { return localStorage.getItem(STOCK_PRINT_KEY) ?? ""; } catch { return ""; } };
const subscribe = () => () => {};
const STATUS = { negative: "Negative", low: "Low", active: "Active", inactive: "Inactive" } as const;

/**
 * PDF / print of the Current Stock selection in the Hilty document layout.
 * The rows come from the Current Stock page (kept in this browser).
 */
export default function StockPrintPage() {
  const raw = React.useSyncExternalStore(subscribe, read, () => "");
  const data = React.useMemo(() => { try { return raw ? (JSON.parse(raw) as StockPrintPayload) : null; } catch { return null; } }, [raw]);
  const printedAt = React.useMemo(() => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()), []);

  React.useEffect(() => { if (data) document.title = `Current Stock - ${printedAt}`; }, [data, printedAt]);

  if (!data) {
    return <p className="p-10 text-center text-sm text-muted-foreground">Nothing to print. Open Current Stock, tick items (or none for all) and choose PDF again.</p>;
  }
  const c = data.showCost;
  const totalQty = data.rows.reduce((s, r) => s + r.qty, 0);
  const totalValue = data.rows.reduce((s, r) => s + r.value, 0);
  const doc: PrintDoc = {
    title: "STOCK REPORT",
    number: null,
    meta: [{ label: "Date", value: printedAt }, { label: "Items", value: String(data.rows.length) }],
    parties: [{ heading: "Selection", lines: [data.filters || "All stock"] }],
    table: {
      columns: [{ label: "#", width: "26px" }, { label: "SKU" }, { label: "Product" }, { label: "Branch", align: "center" }, { label: "On hand", align: "right" }, { label: "In transit", align: "right" },
        ...(c ? [{ label: "Avg cost", align: "right" as const }, { label: "Value", align: "right" as const }] : []), { label: "Status", align: "center" }],
      rows: data.rows.map((r, i) => [i + 1, r.sku, r.group ? `${r.name}\n${r.group}` : r.name, r.branchCode, `${formatQuantity(r.qty)} ${r.unit}`.trim(), r.inTransit > 0 ? formatQuantity(r.inTransit) : "—",
        ...(c ? [formatMoney(r.avgCost).replace("TZS ", ""), formatMoney(r.value).replace("TZS ", "")] : []), STATUS[r.status]]),
    },
    totals: [{ label: "Items", value: String(data.rows.length) }, { label: "Total on hand", value: formatQuantity(totalQty), strong: !c },
      ...(c ? [{ label: "Total stock value", value: formatMoney(totalValue), strong: true }] : [])],
  };
  return <DocumentPage doc={doc} company={data.company} printedBy={data.printedBy} printedAt={printedAt} />;
}
