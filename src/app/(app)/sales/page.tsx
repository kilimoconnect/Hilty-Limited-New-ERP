import { redirect } from "next/navigation";

/** Sales opens Sales History (breadcrumbs and typed addresses land here). */
export default function Page() {
  redirect("/sales/history");
}
