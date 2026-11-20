import { redirect } from "next/navigation";

/** A transfer's trips are shown on the transfer itself. */
export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/inventory/transfers/${id}`);
}
