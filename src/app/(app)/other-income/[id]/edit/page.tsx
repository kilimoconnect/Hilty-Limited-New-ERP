import { redirect } from "next/navigation";

/** Edit an income draft: the Record Other Income form, loaded with the draft. */
export default async function EditIncomeDraftPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/other-income/new?draft=${id}`);
}
