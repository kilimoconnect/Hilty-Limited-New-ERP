import { FullScreenLoader } from "@/components/ui/hilty-loader";

/** First load of any page (sign-in, printouts...): the full-screen Hilty loader. */
export default function RootLoading() {
  return <FullScreenLoader />;
}
