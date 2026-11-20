"use client";

import { ProblemPage } from "@/components/layout/problem-page";

/** A page of the system failed to load: try again, go back, or open the Dashboard. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ProblemPage
      title="Something went wrong on this page"
      message="Nothing was saved or changed by this error. Try again; if it keeps happening, go back and tell the administrator the reference below."
      onRetry={reset}
      reference={error.digest}
    />
  );
}
