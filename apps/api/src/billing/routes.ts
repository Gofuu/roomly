import { Router } from 'express';
import { checkoutSchema, type BillingOverview } from '@roomly/shared';
import { config } from '../config.js';
import { withTenant } from '../db/index.js';
import { auth, requireAdmin } from '../auth/middleware.js';
import { HttpError, conflict } from '../http/errors.js';
import { getPlanUsage } from '../spaces/plan-limits.js';
import { billing } from './gateway.js';

/** Admin-only billing. Regular employees never see or touch it. */
export const billingRouter = Router();
billingRouter.use(requireAdmin);

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

function gatewayOrThrow() {
  if (!billing.gateway) {
    throw new HttpError(503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured on this server (missing STRIPE_SECRET_KEY)');
  }
  return billing.gateway;
}

billingRouter.get('/', async (req, res) => {
  const { orgId } = auth(req);
  const body = await withTenant(orgId, async (tx): Promise<BillingOverview> => {
    const [plans, usage, sub, org] = await Promise.all([
      tx.selectFrom('plans').selectAll().orderBy('sort_order').execute(),
      getPlanUsage(tx, orgId),
      tx.selectFrom('subscriptions').selectAll().executeTakeFirst(),
      tx.selectFrom('organizations').select('stripe_customer_id').executeTakeFirstOrThrow(),
    ]);
    return {
      configured: !!billing.gateway,
      plans: plans.map((p) => ({
        id: p.id, name: p.name, roomLimit: p.room_limit, monthlyPriceCents: p.monthly_price_cents,
        purchasable: !!config.stripe.prices[p.id],
      })),
      usage,
      subscription: sub ? {
        status: sub.status,
        planId: sub.plan_id,
        currentPeriodEnd: sub.current_period_end?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      } : null,
      hasCustomer: !!org.stripe_customer_id,
    };
  });
  res.json(body);
});

/**
 * Starts a Stripe Checkout for a paid plan and returns its URL. The plan does
 * not change here. It changes when Stripe's subscription webhook arrives,
 * because only Stripe knows whether the payment succeeded.
 */
billingRouter.post('/checkout', async (req, res) => {
  const me = auth(req);
  const { planId } = checkoutSchema.parse(req.body);
  const gateway = gatewayOrThrow();
  const priceId = config.stripe.prices[planId];
  if (!priceId) throw new HttpError(503, 'BILLING_NOT_CONFIGURED', `No Stripe price configured for the ${planId} plan`);

  const org = await withTenant(me.orgId, async (tx) => {
    const sub = await tx.selectFrom('subscriptions').select('status').executeTakeFirst();
    if (sub && LIVE_STATUSES.has(sub.status)) {
      throw conflict('ALREADY_SUBSCRIBED', 'You already have a subscription. Use "Manage billing" to change plans.');
    }
    const row = await tx.selectFrom('organizations').select(['name', 'stripe_customer_id']).executeTakeFirstOrThrow();
    const user = await tx.selectFrom('users').select('email').where('id', '=', me.userId).executeTakeFirstOrThrow();
    return { ...row, email: user.email };
  });

  // Network calls happen outside any database transaction.
  let customerId = org.stripe_customer_id;
  if (!customerId) {
    const created = await gateway.createCustomer({ orgId: me.orgId, orgName: org.name, email: org.email });
    // Only set it if still unset; if a concurrent checkout won, use theirs.
    customerId = await withTenant(me.orgId, async (tx) => {
      await tx.updateTable('organizations').set({ stripe_customer_id: created })
        .where('id', '=', me.orgId).where('stripe_customer_id', 'is', null).execute();
      return (await tx.selectFrom('organizations').select('stripe_customer_id').executeTakeFirstOrThrow()).stripe_customer_id!;
    });
  }

  const url = await gateway.createCheckoutSession({
    customerId,
    priceId,
    orgId: me.orgId,
    successUrl: `${config.webOrigin}/admin/billing?checkout=success`,
    cancelUrl: `${config.webOrigin}/admin/billing?checkout=cancelled`,
  });
  res.json({ url });
});

/** Stripe's hosted Customer Portal: change plan, update card, cancel, invoices. */
billingRouter.post('/portal', async (req, res) => {
  const { orgId } = auth(req);
  const gateway = gatewayOrThrow();
  const org = await withTenant(orgId, (tx) =>
    tx.selectFrom('organizations').select('stripe_customer_id').executeTakeFirstOrThrow(),
  );
  if (!org.stripe_customer_id) throw conflict('NO_CUSTOMER', 'Subscribe to a plan first');
  const url = await gateway.createPortalSession({
    customerId: org.stripe_customer_id,
    returnUrl: `${config.webOrigin}/admin/billing`,
  });
  res.json({ url });
});
