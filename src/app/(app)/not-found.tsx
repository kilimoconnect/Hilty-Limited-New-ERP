import { ProblemPage } from "@/components/layout/problem-page";

/** Any missing page or record inside the system (keeps the menu and header). */
export default function NotFound() {
  return (
    <ProblemPage
      title="We couldn't find that page"
      message="The page or record may have been moved or deleted, or the link was incomplete. Go back to where you were, or open the Dashboard."
    />
  );
}
