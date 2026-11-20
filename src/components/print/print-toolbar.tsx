"use client";

import { Printer, X } from "lucide-react";

/** Bar above a printable document (not printed): Print / Save as PDF and Close. */
export function PrintToolbar() {
  return (
    <div className="print:hidden mx-auto mb-4 flex w-[210mm] items-center justify-between rounded-lg bg-[#1E2641] px-4 py-2.5 text-sm text-white shadow">
      <span className="text-white/80">Choose <span className="font-semibold text-white">Save as PDF</span> as the printer to send it as a PDF.</span>
      <div className="flex gap-2">
        <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-md bg-[#C0623F] px-3 py-1.5 font-medium hover:bg-[#a9532f]">
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </button>
        <button type="button" onClick={() => window.close()} className="inline-flex items-center gap-1.5 rounded-md border border-white/30 px-3 py-1.5 hover:bg-white/10">
          <X className="h-4 w-4" /> Close
        </button>
      </div>
    </div>
  );
}
