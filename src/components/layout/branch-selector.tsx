"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { setActiveBranch } from "@/lib/auth/actions";
import { announceBranch, pageHasBranchFilter, useBranchFollow } from "@/lib/branch-sync";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface BranchOption {
  id: string;
  name: string;
  code: string;
}

export function BranchSelector({
  branches,
  activeBranchId,
}: {
  branches: BranchOption[];
  activeBranchId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  // Follows the active branch (it can also change on a create page's branch step);
  // `picked` only holds the user's choice while it is being saved.
  const [picked, setPicked] = React.useState<{ id: string; from: string | null } | null>(null);
  const value = (picked && picked.from === activeBranchId ? picked.id : activeBranchId) ?? undefined;
  const pathname = usePathname();
  const sp = useSearchParams();
  // A branch chosen on the page shows here at once (the server confirms it after).
  useBranchFollow((id) => setPicked({ id, from: activeBranchId }));

  if (branches.length === 0) {
    return (
      <span className="text-sm text-muted-foreground">No branch assigned</span>
    );
  }

  async function onChange(next: string) {
    setPicked({ id: next, from: activeBranchId });
    setPending(true);
    announceBranch(next);
    try {
      await setActiveBranch(next);
      // The page's own branch filter (?branch=) follows the header.
      if (pageHasBranchFilter()) {
        const p = new URLSearchParams(sp.toString());
        p.set("branch", next);
        p.delete("page");
        router.replace(`${pathname}?${p.toString()}`);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch branch");
      setPicked(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={pending}>
      <SelectTrigger className="h-8 w-[190px] text-sm">
        <SelectValue placeholder="Select branch" />
      </SelectTrigger>
      <SelectContent>
        {branches.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            {b.name} ({b.code})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
