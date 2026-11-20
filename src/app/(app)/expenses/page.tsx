import { redirect } from "next/navigation";

/** Expenses opens the expense history. */
export default function Page() {
  redirect("/expenses/history");
}
