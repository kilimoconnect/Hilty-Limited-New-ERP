"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export interface SearchOption { id: string; label: string; hint?: string | null; search?: string }

/** A text box that filters a list as you type (name, phone, code...). */
export function SearchSelect({
  options, value, onChange, placeholder = "Search…", className, disabled, emptyText = "No match",
}: {
  options: SearchOption[]; value: string; onChange: (id: string) => void; placeholder?: string;
  className?: string; disabled?: boolean; emptyText?: string;
}) {
  const selected = options.find((o) => o.id === value);
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const box = React.useRef<HTMLDivElement>(null);

  const results = React.useMemo(() => {
    const t = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = t.length === 0 ? options : options.filter((o) => {
      const hay = `${o.label} ${o.hint ?? ""} ${o.search ?? ""}`.toLowerCase();
      return t.every((x) => hay.includes(x));
    });
    return list.slice(0, 100);
  }, [options, q]);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function pick(o: SearchOption) { onChange(o.id); setQ(""); setOpen(false); }

  return (
    <div ref={box} className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        disabled={disabled}
        className="pl-8 pr-8"
        placeholder={selected ? selected.label : placeholder}
        value={open ? q : selected ? selected.label : ""}
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, results.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && open && results[active]) { e.preventDefault(); pick(results[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {selected && !disabled && (
        <button type="button" aria-label="Clear" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={() => { onChange(""); setQ(""); }}><X className="h-4 w-4" /></button>
      )}
      {open && !disabled && (
        <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md">
          {results.length === 0 && <li className="px-3 py-2 text-muted-foreground">{emptyText}</li>}
          {results.map((o, i) => (
            <li key={o.id}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setActive(i)}
                className={cn("flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left", i === active && "bg-muted", o.id === value && "font-medium")}>
                <span className="truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
