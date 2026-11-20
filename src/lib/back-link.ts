/**
 * "Back" trail between pages: a link carries the page it was opened from in
 * ?back= (and an optional ?backLabel=), so the next page can offer a Back
 * button to that exact page - list filters and paging included.
 * Only paths inside this app are accepted.
 */
type SP = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

/** A safe in-app path ("/..."), or null. */
export function safePath(p: string | undefined | null): string | null {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.includes("://") || p.includes("\\")) return null;
  return p;
}

/** The page to go back to: ?back= when valid, else the fallback. */
export function backOf(sp: SP, fallback: string, fallbackLabel: string): { href: string; label: string } {
  const href = safePath(first(sp.back));
  const label = first(sp.backLabel);
  return href ? { href, label: label || fallbackLabel } : { href: fallback, label: fallbackLabel };
}

/** This page's own address (path + current query), to pass on as ?back=. */
export function selfPath(path: string, sp: SP, drop: string[] = []): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = first(v);
    if (val !== undefined && val !== "" && !drop.includes(k)) q.set(k, val);
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Appends back / backLabel to a link. */
export function withBack(href: string, back: string, label?: string): string {
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}back=${encodeURIComponent(back)}${label ? `&backLabel=${encodeURIComponent(label)}` : ""}`;
}
