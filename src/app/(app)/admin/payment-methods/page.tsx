import type { Metadata } from "next";
import Link from "next/link";
import { requireOwnerPage } from "@/lib/auth/guards";
import { getPrimaryCompanyId } from "@/lib/admin/queries";
import { loadPaymentMethods } from "@/lib/admin/payment-method-queries";
import { PageHeader } from "@/components/ui/page-header";
import { PaymentMethodsManager, BranchPaymentMethods } from "@/components/admin/payment-methods";

export const metadata: Metadata = { title: "Payment Methods & Banks" };

export default async function PaymentMethodsPage() {
  const user = await requireOwnerPage();
  const companyId = await getPrimaryCompanyId(user.defaultCompanyId);
  const { methods, branches } = await loadPaymentMethods(companyId);
  return (
    <div className="space-y-6">
      <PageHeader title="Payment Methods & Banks"
        description="The ways money is paid and received. Assign them to each branch; cash and mobile money keep their own balance per branch, banks are shared." />
      <PaymentMethodsManager methods={methods} branches={branches} />
      <BranchPaymentMethods methods={methods} branches={branches} />
      <p className="text-xs text-muted-foreground">
        The accounts behind the methods (one per branch for cash and mobile money) and their balances are under{" "}
        <Link href="/cash-and-banks" className="underline">Cash &amp; Banks</Link>; their ledger links are in{" "}
        <Link href="/admin/payment-accounts" className="underline">Payment Accounts</Link>.
      </p>
    </div>
  );
}
