import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Alert, Badge, Button, Card, PageHeader, Spinner, errorMessage } from '../components/ui';

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  pendingSyncs: number;
  recentFailures: number;
}

const RESULT_MESSAGES: Record<string, { tone: 'success' | 'warning' | 'error'; text: string }> = {
  connected: { tone: 'success', text: 'Google Calendar connected. Your upcoming bookings are being added to your calendar.' },
  denied: { tone: 'warning', text: 'Google access was not granted. Nothing was connected.' },
  error: { tone: 'error', text: 'Something went wrong connecting Google Calendar. Please try again.' },
};

export function SettingsPage() {
  const { user, org } = useSession();
  const [params, setParams] = useSearchParams();
  const result = RESULT_MESSAGES[params.get('google') ?? ''];
  const qc = useQueryClient();

  const status = useQuery({
    queryKey: ['google-status'],
    queryFn: () => api.get<GoogleStatus>('/integrations/google'),
    refetchInterval: (q) => (q.state.data?.pendingSyncs ? 2000 : false),
  });
  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>('/integrations/google/connect'),
    onSuccess: ({ url }) => { window.location.href = url; },
  });
  const disconnect = useMutation({
    mutationFn: () => api.delete('/integrations/google'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['google-status'] }),
  });

  return (
    <div className="max-w-2xl">
      <PageHeader title="Settings" />

      <Card className="mb-6 p-6">
        <h2 className="font-semibold text-slate-900">Profile</h2>
        <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">Name</dt><dd className="text-slate-900">{user.name}</dd>
          <dt className="text-slate-500">Email</dt><dd className="text-slate-900">{user.email}</dd>
          <dt className="text-slate-500">Organization</dt><dd className="text-slate-900">{org.name}</dd>
          <dt className="text-slate-500">Role</dt><dd className="capitalize text-slate-900">{user.role}</dd>
        </dl>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-slate-900">Google Calendar</h2>
            <p className="mt-1 text-sm text-slate-500">
              Rooms you book appear on your Google Calendar automatically, and are updated or removed when you change or cancel them.
            </p>
          </div>
          {status.data?.connected && <Badge tone="green">Connected</Badge>}
        </div>

        <div className="mt-4 space-y-3">
          {result && (
            <Alert tone={result.tone}>
              {result.text} <button className="underline" onClick={() => setParams({}, { replace: true })}>Dismiss</button>
            </Alert>
          )}
          {status.isPending ? <Spinner /> : status.isError ? <Alert>{errorMessage(status.error)}</Alert> : !status.data.configured ? (
            <Alert tone="info">
              Google Calendar isn't configured on this server yet. Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> (see <code>.env.example</code>).
            </Alert>
          ) : status.data.connected ? (
            <>
              <p className="text-sm text-slate-700">
                Syncing to <span className="font-medium">{status.data.email}</span>
                {status.data.pendingSyncs > 0 && <span className="text-slate-500"> · {status.data.pendingSyncs} update{status.data.pendingSyncs === 1 ? '' : 's'} pending…</span>}
              </p>
              {status.data.recentFailures > 0 && (
                <Alert tone="warning">{status.data.recentFailures} sync{status.data.recentFailures === 1 ? '' : 's'} failed in the last day. Reconnecting usually fixes this.</Alert>
              )}
              <Button variant="danger" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button>
            </>
          ) : (
            <>
              {connect.isError && <Alert>{errorMessage(connect.error)}</Alert>}
              <Button loading={connect.isPending} onClick={() => connect.mutate()}>Connect Google Calendar</Button>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
