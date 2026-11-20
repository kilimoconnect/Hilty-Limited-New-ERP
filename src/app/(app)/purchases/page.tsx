import { redirect } from "next/navigation";

/** Purchases opens Purchase History. */
export default function Page() {
  redirect("/purchases/history");
}
