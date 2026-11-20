import { redirect } from "next/navigation";

/** Kept for old links: the document now prints at /print/receipt/<id>. */
export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/print/receipt/${id}`);
}
