import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingOverview, PlanInfo } from '@roomly/shared';
import { api } from '../../lib/api';
import { keys } from '../../lib/queries';
import { Alert, Badge, Button, Card, PageHeader, Spinner, cx, errorMessage } from '../../components/ui';

const money = (cents: number) => (cents === 0 ? 'Free' : `$${(cents / 100).toFixed(0)}/mo`);
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  active: 'green', trialing: 'green', past_due: 'amber', unpaid: 'red', canceled: 'slate', incomplete: 'amber',
};

export function BillingPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const returnedFromCheckout = params.get('checkout') === 'success';
  const startPlan = useRef<string | null>(null);

  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: () => api.get<BillingOverview>('/billing'),
    // After checkout, poll until Stripe's webhook has updated the plan.
    refetchInterval: (q) => (returnedFromCheckout && q.state.data?.usage.planId === (startPlan.current ?? 'free') ? 2000 : false),
  });
  useEffect(() => {
    if (billing.data && startPlan.current === null) startPlan.current = billing.data.usage.planId;
  }, [billing.data]);

  const [pending, setPending] = useState<string | null>(null);
  const redirect = useMutation({
    mutationFn: (req: { path: string; body?: unknown }) => api.post<{ url: string }>(req.path, req.body),
    onSuccess: ({ url }) => { window.location.href = url; },
    onSettled: () => setPending(null),
  });
  const checkout = (plan: PlanInfo) => { setPending(plan.id); redirect.mutate({ path: '/billing/checkout', body: { planId: plan.id } }); };
  const portal = () => { setPending('portal'); redirect.mutate({ path: '/billing/portal' }); };

  const upgraded = returnedFromCheckout && billing.data && billing.data.usage.planId !== 'free';
  useEffect(() => {
    if (upgraded) void qc.invalidateQueries({ queryKey: keys.planUsage });
  }, [upgraded, qc]);

  if (billing.isPending) return <Spinner />;
  if (billing.isError) return <Alert>{errorMessage(billing.error)}</Alert>;
  const b = billing.data;
  const current = b.plans.find((p) => p.id === b.usage.planId)!;
  const liveSub = b.subscription && b.subscription.status !== 'canceled';
  const overLimit = b.usage.roomLimit !== null && b.usage.activeRooms > b.usage.roomLimit;

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Your organization's plan. Only admins can see this page."
        actions={b.hasCustomer && b.configured ? <Button variant="secondary" loading={pending === 'portal'} onClick={portal}>Manage billing</Button> : undefined}
      />

      <div className="mb-6 space-y-3">
        {!b.configured && (
          <Alert tone="info">
            Stripe isn't configured on this server yet. Add <code>STRIPE_SECRET_KEY</code>, the price ids and the webhook secret to <code>.env</code> (see <code>.env.example</code>) to enable checkout.
          </Alert>
        )}
        {params.get('checkout') === 'cancelled' && <Alert tone="warning">Checkout was cancelled. Nothing was charged.</Alert>}
        {returnedFromCheckout && !upgraded && (
          <Alert tone="info"><span className="inline-flex items-center gap-2"><Spinner className="size-4" /> Payment received. Waiting for Stripe to confirm your subscription…</span></Alert>
        )}
        {upgraded && (
          <Alert tone="success">
            You're on the {current.name} plan. <button className="underline" onClick={() => setParams({}, { replace: true })}>Dismiss</button>
          </Alert>
        )}
        {b.subscription?.status === 'past_due' && (
          <Alert tone="warning">Your last payment failed. Stripe is retrying. Update your card via "Manage billing" to keep your plan.</Alert>
        )}
        {overLimit && (
          <Alert tone="warning">
            You have {b.usage.activeRooms} active rooms but the {current.name} plan includes {b.usage.roomLimit}. Existing rooms keep working, but you can't add or reactivate rooms until you upgrade or deactivate some.
          </Alert>
        )}
        {redirect.isError && <Alert>{errorMessage(redirect.error)}</Alert>}
      </div>

      <Card className="mb-8 flex flex-wrap items-center gap-6 px-6 py-5">
        <div>
          <div className="text-sm text-slate-500">Current plan</div>
          <div className="mt-0.5 flex items-center gap-2 text-xl font-semibold text-slate-900">
            {current.name}
            {b.subscription && <Badge tone={STATUS_TONE[b.subscription.status] ?? 'slate'}>{b.subscription.status.replace('_', ' ')}</Badge>}
          </div>
        </div>
        <div>
          <div className="text-sm text-slate-500">Active rooms</div>
          <div className="mt-0.5 text-xl font-semibold text-slate-900">{b.usage.activeRooms} / {b.usage.roomLimit ?? '∞'}</div>
        </div>
        {liveSub && b.subscription?.currentPeriodEnd && (
          <div>
            <div className="text-sm text-slate-500">{b.subscription.cancelAtPeriodEnd ? 'Ends on' : 'Renews on'}</div>
            <div className="mt-0.5 text-xl font-semibold text-slate-900">{new Date(b.subscription.currentPeriodEnd).toLocaleDateString()}</div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {b.plans.map((p) => {
          const isCurrent = p.id === current.id;
          return (
            <Card key={p.id} className={cx('flex flex-col p-6', isCurrent && 'ring-2 ring-indigo-600')}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-900">{p.name}</h3>
                {isCurrent && <Badge tone="indigo">Current</Badge>}
              </div>
              <div className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">{money(p.monthlyPriceCents)}</div>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-slate-600">
                <li>{p.roomLimit === null ? 'Unlimited rooms' : `Up to ${p.roomLimit} active rooms`}</li>
                <li>Unlimited employees and bookings</li>
                <li>Live calendars and Google Calendar sync</li>
              </ul>
              <div className="mt-6">
                {isCurrent ? (
                  <Button variant="secondary" disabled className="w-full">Your plan</Button>
                ) : p.id === 'free' ? (
                  liveSub ? <Button variant="secondary" className="w-full" onClick={portal} disabled={!b.configured}>Downgrade in portal</Button> : null
                ) : liveSub ? (
                  <Button variant="secondary" className="w-full" onClick={portal} loading={pending === 'portal'} disabled={!b.configured}>Change in portal</Button>
                ) : (
                  <Button className="w-full" onClick={() => checkout(p)} loading={pending === p.id} disabled={!b.configured || !p.purchasable}>
                    Upgrade to {p.name}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-slate-400">Payments are processed by Stripe (test mode). Use card 4242 4242 4242 4242.</p>
    </div>
  );
}
