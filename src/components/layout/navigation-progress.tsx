"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { LoadingPill } from "@/components/ui/hilty-loader";

/**
 * App-wide "it is loading" feedback for every click, using the Hilty loaders.
 *
 * Next.js loads pages (links, router.push / replace / refresh, filters, the
 * pager) and runs server actions (Save, Post, Confirm...) through fetch calls
 * carrying the `rsc` or `next-action` header. Counting those requests until
 * their response has fully streamed covers every kind of click without
 * touching each button. Background prefetches are ignored.
 *
 *   - Opening a page, filters, paging, refresh -> small pill "Loading…"
 *   - Buttons running a server action          -> small pill "Working…"
 *
 * Both appear only when the wait passes a short moment, so instant clicks do
 * not flash. The cursor shows progress meanwhile.
 */

type Kind = "page" | "same" | "action";
interface Snapshot { full: boolean; pill: string | null }
const DELAY = 300;

const store = (() => {
  const count: Record<Kind, number> = { page: 0, same: 0, action: 0 };
  let snap: Snapshot = { full: false, pill: null };
  let timer: number | undefined;
  let clickTimer: number | undefined;
  let clickPending = false;
  let lastClickKind: Kind = "page";
  const subs = new Set<() => void>();

  const total = () => count.page + count.same + count.action;
  const target = (): Snapshot => ({
    full: false,
    pill: count.action > 0 ? "Working…" : count.page + count.same > 0 ? "Loading…" : null,
  });
  function publish(next: Snapshot) {
    if (next.full === snap.full && next.pill === snap.pill) return;
    snap = next; subs.forEach((f) => f());
  }
  function update() {
    if (total() === 0) {
      window.clearTimeout(timer); timer = undefined;
      document.documentElement.classList.remove("app-busy");
      publish({ full: false, pill: null });
      return;
    }
    document.documentElement.classList.add("app-busy");
    // Already showing: switch at once (e.g. pill -> full screen). Otherwise wait a moment.
    if (snap.full || snap.pill) publish(target());
    else if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; if (total() > 0) publish(target()); }, DELAY);
  }
  function begin(kind: Kind) { count[kind] += 1; update(); }
  function end(kind: Kind) { count[kind] = Math.max(0, count[kind] - 1); update(); }

  /** A link click shows the loader before its request starts; it ends when the new address is shown. */
  function clickStart(kind: Kind) {
    if (clickPending) return;
    clickPending = true;
    begin(kind);
    clickTimer = window.setTimeout(() => clickEnd(), 15000);
    lastClickKind = kind;
  }
  function clickEnd() {
    if (!clickPending) return;
    clickPending = false;
    window.clearTimeout(clickTimer);
    end(lastClickKind);
  }
  return {
    begin, end, clickStart, clickEnd,
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
    get: () => snap,
  };
})();
const SERVER_SNAPSHOT: Snapshot = { full: false, pill: null };

function headerOf(init: RequestInit | undefined, input: RequestInfo | URL, name: string): string | null {
  const h = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const rec = h as Record<string, string>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name);
  return k ? rec[k] : null;
}
function urlOf(input: RequestInfo | URL): URL | null {
  try { return new URL(input instanceof Request ? input.url : String(input), window.location.href); } catch { return null; }
}

/** The page is ready only when the streamed body has finished; read a copy to know when. */
function whenDone(res: Response, done: () => void) {
  try {
    const body = res.clone().body;
    if (!body) { done(); return; }
    const reader = body.getReader();
    const pump = (): Promise<void> => reader.read().then((r) => (r.done ? undefined : pump()));
    pump().catch(() => undefined).finally(done);
  } catch { done(); }
}

let patched = false;
function patchFetch() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const isAction = !!headerOf(init, input, "next-action");
    const isPage = !!headerOf(init, input, "rsc") && !headerOf(init, input, "next-router-prefetch");
    if (!isAction && !isPage) return original(input, init);
    const kind: Kind = isAction ? "action" : urlOf(input)?.pathname === window.location.pathname ? "same" : "page";
    store.begin(kind);
    let finished = false;
    const done = () => { if (!finished) { finished = true; store.end(kind); } };
    return original(input, init).then(
      (res) => { whenDone(res, done); return res; },
      (err) => { done(); throw err; },
    );
  };
}

/** A click on a link to another address of this app: which kind of load it starts, if any. */
function navKind(e: MouseEvent): Kind | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a");
  if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return null;
  const url = new URL(a.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname !== window.location.pathname) return "page";
  return url.search !== window.location.search ? "same" : null;
}

function ProgressInner() {
  const snap = React.useSyncExternalStore(store.subscribe, store.get, () => SERVER_SNAPSHOT);
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";

  React.useEffect(() => {
    patchFetch();
    // Clicks that start a page load: in the capture phase, before Next.js handles them.
    const onClick = (e: MouseEvent) => { const k = navKind(e); if (k) store.clickStart(k); };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  // The new address is showing: the click part is over (its requests may still be finishing).
  React.useEffect(() => { store.clickEnd(); }, [pathname, search]);

  return (
    <>
      {snap.pill && <Pill text={snap.pill} />}
    </>
  );
}

/** A section loader that is actually on screen (React may keep hidden ones in the page). */
function sectionLoaderShowing(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-hl-section]")).some((el) => el.getClientRects().length > 0);
}

/** The top pill. One loader at a time: it steps aside while a section loader is on screen. */
function Pill({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const sync = () => { if (ref.current) ref.current.style.display = sectionLoaderShowing() ? "none" : ""; };
    sync();
    const t = window.setInterval(sync, 60);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div ref={ref} className="pointer-events-none fixed left-1/2 top-3 z-[200] -translate-x-1/2">
      <LoadingPill text={text} />
    </div>
  );
}

export function NavigationProgress() {
  // useSearchParams needs a Suspense boundary.
  return <React.Suspense fallback={null}><ProgressInner /></React.Suspense>;
}
