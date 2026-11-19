import { cn } from "@/lib/utils";

/**
 * Hilty loaders (designs "Main" full-screen loader and "Compact" small
 * loaders): the shield with three growing bars - copper, blue, light.
 * Animations live in globals.css (hl-grow, hl-breathe, hl-dot).
 */

type Size = 104 | 56 | 28 | 14;
const PRESET: Record<Size, { h: number; radius: string; bar: number; tall: number; short: number; gap: number }> = {
  104: { h: 124, radius: "16px 16px 52px 52px / 16px 16px 48px 48px", bar: 14, tall: 50, short: 32, gap: 6 },
  56: { h: 66, radius: "10px 10px 28px 28px / 10px 10px 26px 26px", bar: 8, tall: 28, short: 18, gap: 3 },
  28: { h: 33, radius: "6px 6px 14px 14px / 6px 6px 13px 13px", bar: 4, tall: 14, short: 9, gap: 2 },
  14: { h: 17, radius: "3px 3px 7px 7px / 3px 3px 6px 6px", bar: 2, tall: 7, short: 4, gap: 1 },
};

/** The shield. 104 = full screen, 56 = page section, 28 = cards and tables, 14 = inline. */
export function HiltyMark({ size = 28, onDark = false, breathe = false, className }: {
  size?: Size; onDark?: boolean; breathe?: boolean; className?: string;
}) {
  const p = PRESET[size];
  const big = size === 104;
  return (
    <div aria-hidden className={cn("flex shrink-0 flex-col items-center justify-center", breathe && "hl-shield", className)}
      style={{
        width: size, height: p.h, borderRadius: p.radius, boxSizing: "border-box",
        background: onDark && !big ? "#151B2E" : "#1E2640",
        boxShadow: big ? "0 0 0 1px rgba(225,229,239,.14), 0 18px 40px rgba(0,0,0,.28)" : onDark ? "0 0 0 1px rgba(225,229,239,.2)" : undefined,
        gap: big ? 12 : 0, paddingBottom: big ? 6 : 0,
      }}>
      <LoaderBars bar={p.bar} tall={p.tall} short={p.short} gap={p.gap} />
      {big && <div className="font-semibold" style={{ fontSize: 9, letterSpacing: 3, color: "#E1E5EF", paddingLeft: 3, fontFamily: "var(--font-archivo), system-ui, sans-serif" }}>HILTY</div>}
    </div>
  );
}

function LoaderBars({ bar, tall, short, gap, mono }: { bar: number; tall: number; short: number; gap: number; mono?: boolean }) {
  return (
    <div className="flex items-end" style={{ height: tall, gap }}>
      <div className="hl-bar" style={{ width: bar, height: tall, background: mono ? "currentColor" : "#C2623F" }} />
      <div className="hl-bar hl-b2" style={{ width: bar, height: short, background: mono ? "currentColor" : "#5B7FDB", opacity: mono ? 0.75 : 1 }} />
      <div className="hl-bar hl-b3" style={{ width: bar, height: tall, background: mono ? "currentColor" : "#E1E5EF" }} />
    </div>
  );
}

/** Bars in the text colour, for inside a button: <Button disabled><ButtonBars /> Saving…</Button>. */
export function ButtonBars({ className }: { className?: string }) {
  return <span aria-hidden className={cn("inline-flex", className)}><LoaderBars bar={3} tall={14} short={9} gap={2} mono /></span>;
}

/** "LOADING..." with pulsing dots. */
export function LoadingLabel({ text = "LOADING", className }: { text?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-0.5 text-xs font-medium", className)}
      style={{ fontFamily: "var(--font-plex-mono), ui-monospace, monospace", letterSpacing: 3 }}>
      <span>{text}</span><span className="hl-dot">.</span><span className="hl-dot hl-d2">.</span><span className="hl-dot hl-d3">.</span>
    </div>
  );
}

/** Full-screen loader (design "Main"). */
export function FullScreenLoader({ className }: { className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label="Loading"
      className={cn("fixed inset-0 z-[200] flex flex-col items-center justify-center gap-7", className)} style={{ background: "#151B2E" }}>
      <HiltyMark size={104} breathe />
      <LoadingLabel className="text-[#B4BCD4]" />
    </div>
  );
}

/** Loader for a page section or card (design "Compact", 64 / 32). */
export function SectionLoader({ size = 56, label = "LOADING", className }: { size?: 56 | 28; label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label="Loading" data-hl-section className={cn("flex flex-col items-center justify-center gap-4 py-16", className)}>
      <HiltyMark size={size} />
      <LoadingLabel text={label} className="text-[#4A5373] dark:text-[#B4BCD4]" />
    </div>
  );
}

/** Small dark pill (design "Compact"): shield + text, e.g. "Loading products…". */
export function LoadingPill({ text = "Loading…", className }: { text?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("inline-flex items-center gap-3 rounded-2xl px-4 py-2.5 shadow-lg", className)} style={{ background: "#1E2640" }}>
      <HiltyMark size={28} onDark />
      <span className="text-sm font-semibold" style={{ color: "#E1E5EF" }}>{text}</span>
    </div>
  );
}
