/**
 * Safe bulk reads through the Supabase API.
 *
 * Two limits make naive reads silently wrong once a company has real volume:
 *  - the API returns at most 1,000 rows per request, so a plain select of a
 *    larger table is cut short without any error;
 *  - a filter like `.in("sale_id", ids)` puts every id in the URL, and a few
 *    hundred ids make the request too long to send at all.
 *
 * selectAll reads every page; selectByIds splits the id list into short chunks.
 * Both throw on an API error instead of returning an empty list, so a failed
 * read can never be mistaken for "no rows".
 */

type Rangeable = {
  range(from: number, to: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

const PAGE = 1000;
const CHUNK = 100;

/** Every row of a query. `make` must build the query afresh with a stable `.order(...)`. */
export async function selectAll<T = Record<string, unknown>>(make: () => Rangeable): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1);
    if (error) throw new Error(`Database read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Every row matching a long list of ids, read in chunks (each chunk paged). */
export async function selectByIds<T = Record<string, unknown>>(
  ids: readonly string[], make: (chunk: string[]) => Rangeable,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
  const parts = await Promise.all(chunks.map((c) => selectAll<T>(() => make(c))));
  return parts.flat();
}
