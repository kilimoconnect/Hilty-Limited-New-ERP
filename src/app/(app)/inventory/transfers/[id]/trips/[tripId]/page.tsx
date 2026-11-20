import { redirect } from "next/navigation";

/** A trip is shown on its transfer. */
export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/inventory/transfers/${id}`);
}
