import { redirect } from "next/navigation";

/** Edit an expense draft: the Record Expense form, loaded with the draft. */
export default async function EditExpenseDraftPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/expenses/new?draft=${id}`);
}
