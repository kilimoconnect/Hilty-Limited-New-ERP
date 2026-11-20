import { redirect } from "next/navigation";

/** Edit a purchase draft: the Create Purchase form, loaded with the draft. */
export default async function EditPurchaseDraftPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/purchases/new?draft=${id}`);
}
