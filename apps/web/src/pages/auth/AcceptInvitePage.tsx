import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { InvitationPreview } from '@roomly/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Alert, Button, Field, Input, Spinner, errorMessage } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const { acceptInvitation } = useAuth();
  const navigate = useNavigate();
  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.get<InvitationPreview>(`/auth/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await acceptInvitation({ token, name, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (preview.isPending) {
    return <AuthLayout title="Checking your invitation…"><Spinner /></AuthLayout>;
  }
  if (preview.isError) {
    return (
      <AuthLayout title="Invitation unavailable" footer={<Link to="/login" className="text-indigo-600">Go to sign in</Link>}>
        <Alert>{errorMessage(preview.error)}</Alert>
      </AuthLayout>
    );
  }

  const inv = preview.data;
  return (
    <AuthLayout
      title={`Join ${inv.orgName}`}
      subtitle={<>You've been invited as {inv.role === 'admin' ? 'an admin' : 'a team member'}.</>}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Email">
          <Input value={inv.email} disabled />
        </Field>
        <Field label="Your name">
          <Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Choose a password" hint="At least 8 characters">
          <Input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" loading={busy} className="w-full">Accept invitation</Button>
      </form>
    </AuthLayout>
  );
}
