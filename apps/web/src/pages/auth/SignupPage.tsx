import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { Alert, Button, Field, Input, errorMessage } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await signup(form);
      navigate('/admin/spaces', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your organization"
      subtitle="You'll be its first admin. Start free with up to 3 rooms."
      footer={<>Already have an account? <Link to="/login" className="font-medium text-indigo-600 hover:text-indigo-500">Sign in</Link></>}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Company name">
          <Input required value={form.orgName} onChange={set('orgName')} placeholder="Acme Inc." />
        </Field>
        <Field label="Your name">
          <Input required autoComplete="name" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Work email">
          <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <Input type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>
        <Button type="submit" loading={busy} className="w-full">Create organization</Button>
      </form>
    </AuthLayout>
  );
}
