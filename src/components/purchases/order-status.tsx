import { Badge } from "@/components/ui/badge";

const LABEL: Record<string, [string, "muted" | "default" | "warning" | "success" | "secondary" | "destructive"]> = {
  draft: ["Draft", "muted"],
  confirmed: ["Pending delivery", "default"],
  partially_received: ["Partly received", "warning"],
  received: ["Received", "success"],
  closed: ["Closed", "secondary"],
  cancelled: ["Cancelled", "destructive"],
};

export function OrderStatusBadge({ status }: { status: string }) {
  const [label, variant] = LABEL[status] ?? [status, "muted"];
  return <Badge variant={variant}>{label}</Badge>;
}

/** Whole days left before a pending order expires (0 = today). */
export function daysLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000));
}
