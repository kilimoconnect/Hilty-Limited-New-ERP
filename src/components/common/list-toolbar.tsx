"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export interface ToolbarSelect {
  name: string;
  placeholder: string;
  value: string;
  width?: string;
  options: { value: string; label: string }[];
}

export function ListToolbar({
  searchName = "q",
  searchValue = "",
  searchPlaceholder = "Search...",
  selects = [],
  dates,
  children,
}: {
  searchName?: string;
  searchValue?: string;
  searchPlaceholder?: string;
  selects?: ToolbarSelect[];
  /** Optional date range filter, kept in ?from= and ?to= (YYYY-MM-DD). */
  dates?: { from: string; to: string };
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = React.useState(searchValue);
  const [, startTransition] = React.useTransition();

  function nav(next: Record<string, string>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v || v === "all") p.delete(k);
      else p.set(k, v);
    }
    p.delete("page");
    startTransition(() => router.push(`${pathname}?${p.toString()}`));
  }

  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => { e.preventDefault(); nav({ [searchName]: text }); }}
          className="relative min-w-[200px] flex-1 sm:max-w-xs"
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={searchPlaceholder} className="pl-8" />
        </form>
        {selects.map((s) => (
          <Select key={s.name} value={s.value || "all"} onValueChange={(v) => nav({ [s.name]: v })}>
            <SelectTrigger className={`h-9 ${s.width ?? "w-[160px]"}`}>
              <SelectValue placeholder={s.placeholder} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{s.placeholder}</SelectItem>
              {s.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        {dates && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Input type="date" aria-label="From date" value={dates.from} max={dates.to || undefined}
              onChange={(e) => nav({ from: e.target.value })} className="h-9 w-[150px]" />
            <span>to</span>
            <Input type="date" aria-label="To date" value={dates.to} min={dates.from || undefined}
              onChange={(e) => nav({ to: e.target.value })} className="h-9 w-[150px]" />
          </div>
        )}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
