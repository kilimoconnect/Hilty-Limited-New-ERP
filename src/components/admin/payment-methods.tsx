"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { savePaymentMethod, setPaymentMethodActive, setBranchPaymentMethods } from "@/lib/admin/payment-method-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface MethodItem {
  id: string; code: string; name: string; method_type: "cash" | "bank" | "mobile_money"; per_branch: boolean;
  provider: string | null; account_number: string | null; is_active: boolean; branchIds: string[];
}
export interface BranchItem { id: string; code: string; name: string; address: string | null; is_active: boolean; methodIds: string[] }

const TYPE_LABEL = { cash: "Cash", bank: "Bank", mobile_money: "Mobile money" } as const;

/** Admin -> Payment Methods & Banks. */
export function PaymentMethodsManager({ methods, branches }: { methods: MethodItem[]; branches: BranchItem[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<MethodItem | "new" | null>(null);
  const branchCode = new Map(branches.map((b) => [b.id, b.code]));

  async function toggle(m: MethodItem) {
    const r = await setPaymentMethodActive(m.id, !m.is_active);
    if (!r.ok) { toast.error(r.error ?? "Failed."); return; }
    toast.success(m.is_active ? `${m.name} switched off.` : `${m.name} switched on.`);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Create Payment Method</Button></div>
      <Card className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Code</TableHead><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Branches</TableHead>
            <TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {methods.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-mono text-xs">{m.code}</TableCell>
                <TableCell className="font-medium">{m.name}{m.account_number && <span className="block text-xs font-normal text-muted-foreground">A/C {m.account_number}</span>}</TableCell>
                <TableCell className="text-sm">{TYPE_LABEL[m.method_type]}<span className="block text-xs text-muted-foreground">{m.per_branch ? "own balance per branch" : "one account for all branches"}</span></TableCell>
                <TableCell><div className="flex flex-wrap gap-1">{m.branchIds.length === 0 ? <span className="text-xs text-muted-foreground">No branch yet</span>
                  : m.branchIds.map((id) => <Badge key={id} variant="secondary">{branchCode.get(id) ?? "?"}</Badge>)}</div></TableCell>
                <TableCell>{m.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Inactive</Badge>}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditing(m)}>Edit</Button>
                    <Button variant="outline" size="sm" onClick={() => toggle(m)}>{m.is_active ? "Deactivate" : "Activate"}</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {editing && <MethodDialog method={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MethodDialog({ method, onClose }: { method: MethodItem | null; onClose: () => void }) {
  const router = useRouter();
  const [code, setCode] = React.useState(method?.code ?? "");
  const [name, setName] = React.useState(method?.name ?? "");
  const [type, setType] = React.useState<MethodItem["method_type"]>(method?.method_type ?? "mobile_money");
  const [provider, setProvider] = React.useState(method?.provider ?? "");
  const [accountNo, setAccountNo] = React.useState(method?.account_number ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const isBank = (method?.method_type ?? type) === "bank";

  async function save() {
    setBusy(true); setError(null);
    const r = await savePaymentMethod({ id: method?.id, code, name, type, provider, accountNumber: isBank ? accountNo : undefined });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "Failed."); return; }
    toast.success(method ? "Payment method saved." : "Payment method created. Assign it to branches below.");
    onClose(); router.refresh();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{method ? `Edit ${method.name}` : "Create Payment Method"}</DialogTitle>
          <DialogDescription>{method ? "Balances are not affected." : "Cash and mobile money keep a separate balance in each branch; a bank is one account shared by all branches."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label htmlFor="pm-code">Code</Label>
              <Input id="pm-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={!!method} placeholder="e.g. AIRTEL" /></div>
            <div className="space-y-1.5"><Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as MethodItem["method_type"])} disabled={!!method}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="cash">Cash</SelectItem><SelectItem value="mobile_money">Mobile money</SelectItem><SelectItem value="bank">Bank</SelectItem></SelectContent>
              </Select></div>
          </div>
          <div className="space-y-1.5"><Label htmlFor="pm-name">Name</Label><Input id="pm-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Airtel Money" /></div>
          <div className="space-y-1.5"><Label htmlFor="pm-provider">{isBank ? "Bank" : "Provider"}</Label><Input id="pm-provider" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Optional" /></div>
          {isBank && <div className="space-y-1.5"><Label htmlFor="pm-acc">Account number</Label><Input id="pm-acc" value={accountNo} onChange={(e) => setAccountNo(e.target.value)} placeholder="Optional" /></div>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={busy || !name.trim() || (!method && !code.trim())}>{busy ? "Saving..." : "Save"}</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Branches with their payment methods and "Assign Methods" (as in the old system). */
export function BranchPaymentMethods({ methods, branches }: { methods: MethodItem[]; branches: BranchItem[] }) {
  const [assigning, setAssigning] = React.useState<BranchItem | null>(null);
  const mMap = new Map(methods.map((m) => [m.id, m]));
  return (
    <Card className="overflow-x-auto">
      <div className="border-b border-border px-4 py-3">
        <h3 className="font-semibold">Payment methods by branch</h3>
        <p className="text-xs text-muted-foreground">Only the methods assigned to a branch can be used there (sales, purchases, expenses, payments and transfers).</p>
      </div>
      <Table>
        <TableHeader><TableRow>
          <TableHead>Code</TableHead><TableHead>Name</TableHead><TableHead>Address</TableHead><TableHead>Payment Methods</TableHead>
          <TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {branches.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="font-mono text-xs">{b.code}</TableCell>
              <TableCell className="font-medium">{b.name}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{b.address ?? "—"}</TableCell>
              <TableCell><div className="flex flex-wrap gap-1">{b.methodIds.length === 0 ? <span className="text-xs text-muted-foreground">None</span>
                : b.methodIds.map((id) => mMap.get(id)).filter(Boolean).sort((x, y) => x!.code.localeCompare(y!.code))
                  .map((m) => <Badge key={m!.id} variant={m!.is_active ? "secondary" : "muted"}>{m!.code}</Badge>)}</div></TableCell>
              <TableCell>{b.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Inactive</Badge>}</TableCell>
              <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => setAssigning(b)} disabled={!b.is_active}>Assign Methods</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {assigning && <AssignDialog branch={assigning} methods={methods} onClose={() => setAssigning(null)} />}
    </Card>
  );
}

function AssignDialog({ branch, methods, onClose }: { branch: BranchItem; methods: MethodItem[]; onClose: () => void }) {
  const router = useRouter();
  const [picked, setPicked] = React.useState<Set<string>>(new Set(branch.methodIds));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const flip = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const added = methods.filter((m) => picked.has(m.id) && !branch.methodIds.includes(m.id) && m.per_branch);

  async function save() {
    setBusy(true); setError(null);
    const r = await setBranchPaymentMethods(branch.id, Array.from(picked));
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "Failed."); return; }
    toast.success(`Payment methods for ${branch.name} saved.`);
    onClose(); router.refresh();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Methods — {branch.code} {branch.name}</DialogTitle>
          <DialogDescription>Tick the payment methods this branch uses. Removing one hides it from the branch&apos;s forms; its balance and history stay.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {methods.filter((m) => m.is_active || picked.has(m.id)).map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border px-3 py-2 hover:bg-muted/40">
              <span className="flex items-center gap-3">
                <input type="checkbox" checked={picked.has(m.id)} onChange={() => flip(m.id)} />
                <span><span className="font-medium">{m.name}</span> <span className="font-mono text-xs text-muted-foreground">{m.code}</span></span>
              </span>
              <span className="text-xs text-muted-foreground">{TYPE_LABEL[m.method_type]}</span>
            </label>
          ))}
          {added.length > 0 && <p className="text-xs text-muted-foreground">A {added.map((m) => m.name).join(", ")} account for {branch.name} will be created (starting at zero).</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={busy}>{busy ? "Saving..." : "Save"}</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
