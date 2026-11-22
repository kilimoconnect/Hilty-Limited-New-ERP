"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { createRole, updateRole } from "@/lib/admin/roles-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const BLANK = "__blank__";

/** "New role": a name, an optional description, and optionally the permissions of an existing role to start from. */
export function NewRoleButton({ roles, onCreated }: { roles: { id: string; name: string; code: string }[]; onCreated: (id: string) => void }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [copyFrom, setCopyFrom] = React.useState(BLANK);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null); setPending(true);
    const res = await createRole({ name, description, copyFromRoleId: copyFrom === BLANK ? null : copyFrom });
    setPending(false);
    if (!res.ok || !res.id) { setError(res.error ?? "Could not create the role."); return; }
    toast.success(`Role "${name.trim()}" created. Tick its permissions and save.`);
    setOpen(false); setName(""); setDescription(""); setCopyFrom(BLANK);
    onCreated(res.id);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild><Button size="sm" className="w-full"><Plus className="h-4 w-4" /> New role</Button></DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New role</DialogTitle>
          <DialogDescription>Give the role a name. You then choose what it can do.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label htmlFor="role-name">Name <span className="text-destructive">*</span></Label>
            <Input id="role-name" placeholder="e.g. Branch Supervisor" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></div>
          <div className="space-y-1.5"><Label htmlFor="role-desc">Description</Label>
            <Textarea id="role-desc" placeholder="What this role is for (optional)" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Start with the permissions of</Label>
            <Select value={copyFrom} onValueChange={setCopyFrom}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={BLANK}>No permissions (start empty)</SelectItem>
                {roles.filter((r) => r.code !== "OWNER").map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select></div>
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button onClick={submit} disabled={pending || name.trim().length < 2}>{pending ? "Creating..." : "Create role"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Edit name": rename a role and change its description. */
export function EditRoleButton({ role }: { role: { id: string; name: string; description: string | null } }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(role.name);
  const [description, setDescription] = React.useState(role.description ?? "");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null); setPending(true);
    const res = await updateRole(role.id, { name, description });
    setPending(false);
    if (!res.ok) { setError(res.error ?? "Could not save."); return; }
    toast.success("Role updated.");
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); if (o) { setName(role.name); setDescription(role.description ?? ""); } }}>
      <DialogTrigger asChild><Button variant="outline" size="sm"><Pencil className="h-4 w-4" /> Edit name</Button></DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit role</DialogTitle>
          <DialogDescription>Users with this role keep it; only the name and description change.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label htmlFor="edit-role-name">Name <span className="text-destructive">*</span></Label>
            <Input id="edit-role-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></div>
          <div className="space-y-1.5"><Label htmlFor="edit-role-desc">Description</Label>
            <Textarea id="edit-role-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button onClick={submit} disabled={pending || name.trim().length < 2}>{pending ? "Saving..." : "Save"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
