import { SectionLoader } from "@/components/ui/hilty-loader";

/** Shown in the content area while a page of the app is loading. */
export default function AppLoading() {
  return <SectionLoader className="min-h-[60vh]" />;
}
