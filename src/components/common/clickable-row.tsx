"use client";

import { useRouter } from "next/navigation";
import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const INTERACTIVE = "a, button, input, select, textarea, label, [role='menuitem'], [role='menu'], [role='dialog'], [data-row-ignore]";

/**
 * A table row that opens `href` when clicked anywhere on it. Clicks on links,
 * buttons, menus and dialogs inside the row keep their own behaviour, and so do
 * clicks that come from portalled content (dropdowns, confirm dialogs) or that
 * finish a text selection. Ctrl/Cmd/middle click opens a new tab.
 */
export function ClickableRow({
  href, className, children, ...props
}: React.ComponentProps<"tr"> & { href: string }) {
  const router = useRouter();

  function ignored(e: React.MouseEvent<HTMLTableRowElement>) {
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target)) return true; // portalled menu/dialog
    if (target.closest(INTERACTIVE) && e.currentTarget.contains(target.closest(INTERACTIVE))) return true;
    return (window.getSelection()?.toString() ?? "") !== "";
  }

  return (
    <TableRow
      {...props}
      className={cn("cursor-pointer", className)}
      tabIndex={0}
      onClick={(e) => {
        if (ignored(e)) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey) window.open(href, "_blank", "noopener");
        else router.push(href);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && !ignored(e)) window.open(href, "_blank", "noopener");
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) router.push(href);
      }}
      onMouseEnter={() => router.prefetch(href)}
    >
      {children}
    </TableRow>
  );
}
