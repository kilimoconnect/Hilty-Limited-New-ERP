import { redirect } from "next/navigation";

/** Edit a cash transfer draft: the Cash Transfer form, loaded with the draft. */
export default async function EditTransferDraftPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/cash-and-banks/transfer?draft=${id}`);
}
