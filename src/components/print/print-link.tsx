import Link from "next/link";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Opens the Hilty printout of a document in a new tab (print or save as PDF there). */
export function PrintLink({ kind, id, label = "Print", size }: { kind: string; id: string; label?: string; size?: "sm" | "default" }) {
  return (
    <Button asChild variant="outline" size={size}>
      <Link href={`/print/${kind}/${id}`} target="_blank" rel="noopener"><Printer className="h-4 w-4" /> {label}</Link>
    </Button>
  );
}
