import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/** "← Back to …" at the top of a page, to the page it was opened from. */
export function BackButton({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="print-hide mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> Back to {label}
    </Link>
  );
}
