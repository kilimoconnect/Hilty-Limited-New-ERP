import Link from "next/link";

export const PAGE_SIZE = 50;
/** Rows-per-page choices offered on every paged list (1,000 is the API's per-request maximum). */
export const PAGE_SIZES = [50, 100, 500, 1000] as const;

/** Server-rendered pager: keeps the other query parameters, changes ?page= and ?size=. */
export function Pager({ basePath, params, page, pageSize, total }: {
  basePath: string; params: Record<string, string | undefined>; page: number; pageSize: number; total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number, size = pageSize) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    if (size !== PAGE_SIZE) q.set("size", String(size));
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm print-hide">
      <span className="text-xs text-muted-foreground">
        {total} rows{total > 0 && pages > 1 ? ` · showing ${first}–${last}` : ""} · page {page} of {pages}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          Rows per page:
          {PAGE_SIZES.map((n) => n === pageSize
            ? <span key={n} className="rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground">{n}</span>
            : <Link key={n} className="rounded-md border border-border px-2 py-0.5 hover:bg-muted" href={href(1, n)}>{n}</Link>)}
        </span>
        {pages > 1 && (page > 1
          ? <Link className="rounded-md border border-border px-3 py-1" href={href(page - 1)}>Previous</Link>
          : <span className="rounded-md border border-border px-3 py-1 opacity-40">Previous</span>)}
        {pages > 1 && (page < pages
          ? <Link className="rounded-md border border-border px-3 py-1" href={href(page + 1)}>Next</Link>
          : <span className="rounded-md border border-border px-3 py-1 opacity-40">Next</span>)}
      </span>
    </div>
  );
}

export function pageOf(sp: Record<string, string | string[] | undefined>): number {
  const p = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  return Number.isInteger(p) && p > 0 ? p : 1;
}
/** Rows per page from ?size= (one of PAGE_SIZES), default 50. */
export function pageSizeOf(sp: Record<string, string | string[] | undefined>): number {
  const n = Number(Array.isArray(sp.size) ? sp.size[0] : sp.size);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : PAGE_SIZE;
}
/** Date filter from ?from= / ?to= (YYYY-MM-DD), empty when absent or malformed. */
export function dateParam(sp: Record<string, string | string[] | undefined>, k: "from" | "to"): string {
  const v = str(sp, k);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
}
export function str(sp: Record<string, string | string[] | undefined>, k: string): string {
  const v = sp[k];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}
