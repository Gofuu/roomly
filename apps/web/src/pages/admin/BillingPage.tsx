import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingOverview } from '@roomly/shared';
import { api } from '../../lib/api';
import { keys } from '../../lib/queries';
import { Alert, Button, Card, PageHeader, Spinner, errorMessage } from '../../components/ui';

const money = (cents: number) => (cents === 0 ? 'Free' : `$${(cents / 100).toFixed(0)}/month`);

export function BillingPage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const outcome = params.get('checkout'); // set when Stripe sends the admin back here

  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: () => api.get<BillingOverview>('/billing'),
    // The plan changes when Stripe's webhook arrives, a moment after the admin
    // is sent back here. Re-read for a short while so the page catches up.
    refetchInterval: outcome === 'success' ? 2000 : false,
  });
  const planId = billing.data?.usage.planId;
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: keys.planUsage });
  }, [planId, qc]);

  const checkout = useMutation({
    mutationFn: (plan: string) => api.post<{ url: string }>('/billing/checkout', { planId: plan }),
    onSuccess: ({ url }) => { window.location.href = url; },
  });

  if (billing.isPending) return <Spinner />;
  if (billing.isError) return <Alert>{errorMessage(billing.error)}</Alert>;
  const { configured, plans, usage } = billing.data;
  const current = plans.find((p) => p.id === usage.planId)!;
  const upgrades = plans.filter((p) => p.monthlyPriceCents > current.monthlyPriceCents);

  return (
    <div className="max-w-2xl">
      <PageHeader title="Billing" description="Your company's plan. Only admins can see this page." />

      <div className="mb-4 space-y-3">
        {!configured && <Alert tone="info">Upgrades are switched off on this server (no Stripe keys are set).</Alert>}
        {outcome === 'cancelled' && <Alert tone="warning">Checkout was cancelled. Nothing was charged.</Alert>}
        {outcome === 'success' && <Alert tone="success">Thanks! Your plan updates as soon as Stripe confirms the payment.</Alert>}
        {checkout.isError && <Alert>{errorMessage(checkout.error)}</Alert>}
      </div>

      <Card className="p-6">
        <div className="flex flex-wrap gap-10">
          <div>
            <div className="text-sm text-slate-500">Current plan</div>
            <div className="mt-0.5 text-xl font-semibold text-slate-900">{current.name}</div>
            <div className="text-sm text-slate-500">{money(current.monthlyPriceCents)}</div>
          </div>
          <div>
            <div className="text-sm text-slate-500">Rooms in use</div>
            <div className="mt-0.5 text-xl font-semibold text-slate-900">{usage.activeRooms} / {usage.roomLimit ?? 'unlimited'}</div>
          </div>
        </div>

        {upgrades.length > 0 && (
          <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
            {upgrades.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium text-slate-900">{p.name} · {money(p.monthlyPriceCents)}</div>
                  <div className="text-sm text-slate-500">{p.roomLimit === null ? 'Unlimited rooms' : `Up to ${p.roomLimit} rooms`}</div>
                </div>
                <Button
                  onClick={() => checkout.mutate(p.id)}
                  loading={checkout.isPending && checkout.variables === p.id}
                  disabled={!configured}
                >
                  Upgrade
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <p className="mt-4 text-xs text-slate-400">Payments go through Stripe in test mode. Use card 4242 4242 4242 4242.</p>
    </div>
  );
}
