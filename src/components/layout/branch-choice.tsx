"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Building2, Check } from "lucide-react";
import { setActiveBranch } from "@/lib/auth/actions";
import { PageHeader } from "@/components/ui/page-header";

/** First step of a create page for users with several branches: pick the branch, then the page opens. */
export function BranchChoice({ title, branches, current }: {
  title: string; branches: { id: string; code: string; name: string }[]; current: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function choose(id: string) {
    setBusy(id);
    // Open the page for that branch at once; the header branch follows in the background.
    const p = new URLSearchParams(sp.toString());
    p.set("branch", id);
    router.push(`${pathname}?${p.toString()}`);
    setActiveBranch(id).then(() => router.refresh()).catch((e) => toast.error(e instanceof Error ? e.message : "Could not switch the header branch."));
  }

  return (
    <div>
      <PageHeader title={title} description="Choose the branch first." />
      <div className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
        {branches.map((b) => (
          <button key={b.id} type="button" onClick={() => choose(b.id)} disabled={busy !== null}
            className={`flex items-center gap-4 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-60 ${b.id === current ? "border-primary/50" : "border-border"}`}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Building2 className="h-5 w-5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{b.name}</span>
              <span className="block font-mono text-xs text-muted-foreground">{b.code}{b.id === current ? " · current branch" : ""}</span>
            </span>
            {busy === b.id ? <span className="text-xs text-muted-foreground">Opening…</span> : b.id === current ? <Check className="h-4 w-4 text-primary" /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Branch: BUN — Bunju B · Change branch" shown on a create page opened for a branch. */
export function ChosenBranch({ branch, canChange }: { branch: { code: string; name: string } | undefined; canChange: boolean }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const p = new URLSearchParams(sp.toString());
  p.delete("branch");
  const q = p.toString();
  return (
    <span>
      Branch: <span className="font-medium text-foreground">{branch ? `${branch.code} — ${branch.name}` : "—"}</span>
      {canChange && <> · <Link href={`${pathname}${q ? `?${q}` : ""}`} className="underline hover:text-foreground">Change branch</Link></>}
    </span>
  );
}
