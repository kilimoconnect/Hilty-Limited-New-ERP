"use client";

import * as React from "react";
import type { Letterhead } from "@/lib/print/letterhead";

const printedNow = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

/**
 * Hilty letterhead shown only on paper (and in "Save as PDF") at the top of
 * every printed page of the system: reports, lists, ledgers, statements.
 * The page's own title and filters follow underneath.
 */
export function ReportLetterhead({ company, userName, branchLabel }: { company: Letterhead; userName: string; branchLabel: string | null }) {
  const stamp = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    // The time is set when printing starts, not when the page was opened.
    const set = () => { if (stamp.current) stamp.current.textContent = printedNow(); };
    set();
    window.addEventListener("beforeprint", set);
    return () => window.removeEventListener("beforeprint", set);
  }, []);
  const contact = [company.phone, company.email].filter(Boolean).join("  ·  ");
  return (
    <div className="report-letterhead hidden print:block" data-company={(company.legalName ?? company.name).toUpperCase()}>
      <div className="flex items-start justify-between gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/hilty-logo.svg" alt="Hilty Limited" className="h-[52px] w-auto" />
        <div className="text-right text-[10px] leading-relaxed text-[#4A5373]">
          <p className="text-[12px] font-bold tracking-wide text-[#1E2641]">{(company.legalName ?? company.name).toUpperCase()}</p>
          {company.address && <p>{company.address}</p>}
          {contact && <p>{contact}</p>}
          <p>Printed <span ref={stamp} /> by {userName}{branchLabel ? `  ·  Branch: ${branchLabel}` : ""}</p>
        </div>
      </div>
      <div className="mb-4 mt-3 flex items-center">
        <div className="h-[3px] w-20 bg-[#C0623F]" />
        <div className="h-px flex-1 bg-[#1E2641]" />
      </div>
    </div>
  );
}
