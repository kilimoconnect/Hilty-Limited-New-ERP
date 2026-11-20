"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Home, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HiltyMark } from "@/components/ui/hilty-loader";

/**
 * Shown when a page is missing or fails: says what happened in plain words
 * and always offers a way on - back to where the user was, or the dashboard.
 */
export function ProblemPage({ title, message, onRetry, reference }: {
  title: string; message: string; onRetry?: () => void; reference?: string;
}) {
  const router = useRouter();
  function goBack() {
    // Back to the previous page of this system when there is one, else the dashboard.
    if (window.history.length > 1) router.back();
    else router.push("/dashboard");
  }
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <HiltyMark size={56} />
      <h1 className="mt-6 text-xl font-semibold text-foreground">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{message}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="outline" onClick={goBack}><ArrowLeft className="h-4 w-4" /> Go back</Button>
        {onRetry && <Button variant="outline" onClick={onRetry}><RotateCcw className="h-4 w-4" /> Try again</Button>}
        <Button asChild><Link href="/dashboard"><Home className="h-4 w-4" /> Dashboard</Link></Button>
      </div>
      {reference && <p className="mt-6 font-mono text-[11px] text-muted-foreground">Reference: {reference}</p>}
    </div>
  );
}
