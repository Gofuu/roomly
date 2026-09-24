import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@roomly/shared';
import { api } from '../../lib/api';
import { useSession } from '../../lib/auth';
import { keys, useInvitations, useMembers } from '../../lib/queries';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner, errorMessage } from '../../components/ui';

export function TeamPage() {
  const { user: me } = useSession();
  const members = useMembers();
  const invitations = useInvitations();
  const qc = useQueryClient();
  const [error, setError] = useState<string>();

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: Role; isActive?: boolean } }) => api.patch(`/members/${id}`, body),
    onMutate: () => setError(undefined),
    onError: (err) => setError(errorMessage(err)),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.members }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/invitations/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invitations }),
  });

  return (
    <div>
      <PageHeader title="Team" description="Invite colleagues and manage who can administer your organization." />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card>
          <div className="border-b border-slate-100 px-5 py-4"><h2 className="font-semibold text-slate-900">Members</h2></div>
          {error && <div className="px-5 pt-4"><Alert>{error}</Alert></div>}
          {members.isPending ? <div className="p-5"><Spinner /></div> : (
            <ul className="divide-y divide-slate-100">
              {members.data?.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium text-slate-900">
                      {m.name} {m.id === me.id && <Badge tone="indigo">You</Badge>} {!m.isActive && <Badge tone="red">Deactivated</Badge>}
                    </div>
                    <div className="truncate text-sm text-slate-500">{m.email}</div>
                  </div>
                  <div className="w-32">
                    <Select
                      value={m.role}
                      disabled={!m.isActive}
                      onChange={(e) => update.mutate({ id: m.id, body: { role: e.target.value as Role } })}
                    >
                      <option value="employee">Employee</option>
                      <option value="admin">Admin</option>
                    </Select>
                  </div>
                  <Button
                    variant={m.isActive ? 'danger' : 'secondary'}
                    onClick={() => {
                      if (!m.isActive || confirm(`Deactivate ${m.name}? Their upcoming bookings will be cancelled.`)) {
                        update.mutate({ id: m.id, body: { isActive: !m.isActive } });
                      }
                    }}
                  >
                    {m.isActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-6">
          <InviteCard />
          <Card>
            <div className="border-b border-slate-100 px-5 py-4"><h2 className="font-semibold text-slate-900">Pending invitations</h2></div>
            {invitations.data?.length === 0 && <p className="px-5 py-4 text-sm text-slate-500">None.</p>}
            <ul className="divide-y divide-slate-100">
              {invitations.data?.map((i) => (
                <li key={i.id} className="flex items-center gap-2 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900">{i.email}</div>
                    <div className="text-xs text-slate-500">
                      {i.role} · expires {new Date(i.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Button variant="ghost" className="text-xs" onClick={() => revoke.mutate(i.id)}>Revoke</Button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function InviteCard() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [link, setLink] = useState<string>();
  const [copied, setCopied] = useState(false);
  const invite = useMutation({
    mutationFn: () => api.post<{ inviteUrl: string }>('/invitations', { email, role }),
    onSuccess: (res) => {
      setLink(res.inviteUrl);
      setEmail('');
      setCopied(false);
      qc.invalidateQueries({ queryKey: keys.invitations });
    },
  });

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-slate-900">Invite someone</h2>
      <form className="mt-4 space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); invite.mutate(); }}>
        {invite.isError && <Alert>{errorMessage(invite.error)}</Alert>}
        <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="employee">Employee: can book rooms</option>
            <option value="admin">Admin: manages spaces, team and billing</option>
          </Select>
        </Field>
        <Button type="submit" loading={invite.isPending} className="w-full">Create invite link</Button>
      </form>
      {link && (
        <div className="mt-4 space-y-2">
          <Alert tone="success">Invite created. Send this one-time link to your colleague:</Alert>
          <div className="flex gap-2">
            <Input readOnly value={link} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
            <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(link); setCopied(true); }}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
