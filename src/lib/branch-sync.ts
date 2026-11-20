"use client";

import * as React from "react";
import { setActiveBranch } from "@/lib/auth/actions";

/**
 * Keeps the header branch and a page's own branch picker in step.
 *
 *  - Header changed  -> `announceBranch` tells every picker on the page
 *    (form pickers follow through `useBranchFollow`); pages whose filter lives
 *    in the address (?branch=) are re-opened with the new branch (pickers
 *    marked with `data-branch-filter`).
 *  - Page picker changed to a branch -> `followPageBranch` makes it the
 *    header's (active) branch too. "All branches" leaves the header as it is.
 */
const EVENT = "hilty:active-branch";

export function announceBranch(id: string) {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: id }));
}

/** A page picker chose a branch: the header follows (refresh = re-read the active branch). */
export function followPageBranch(id: string, refresh: () => void) {
  if (!id || id === "all") return;
  announceBranch(id);
  setActiveBranch(id).then(refresh).catch(() => { /* no access: the header simply stays */ });
}

/** Form pickers (kept in React state): follow the header when it changes. */
export function useBranchFollow(onChange: (id: string) => void, enabled = true) {
  const cb = React.useRef(onChange);
  React.useEffect(() => { cb.current = onChange; });
  React.useEffect(() => {
    if (!enabled) return;
    const h = (e: Event) => cb.current((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, [enabled]);
}

/** True when the page shows a branch filter kept in the address (?branch=). */
export function pageHasBranchFilter(): boolean {
  return typeof document !== "undefined" && !!document.querySelector("[data-branch-filter]");
}
