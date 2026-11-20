import Link from "next/link";
import { HiltyMark } from "@/components/ui/hilty-loader";

/** Missing page outside the system (e.g. a mistyped address before signing in). */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-sidebar px-4 text-center">
      <HiltyMark size={56} onDark />
      <h1 className="mt-6 text-xl font-semibold text-white">We couldn&apos;t find that page</h1>
      <p className="mt-2 max-w-md text-sm text-white/70">The link may be incomplete or the page may have moved.</p>
      <Link href="/dashboard" className="mt-6 rounded-md bg-white px-4 py-2 text-sm font-medium text-[#1E2641] hover:bg-white/90">Open Hilty ERP</Link>
    </div>
  );
}
