import express, { Router } from 'express';
import type Stripe from 'stripe';
import { checkoutSchema, type BillingOverview } from '@roomly/shared';
import { config } from '../config.js';
import { withDb, withTenant } from '../db/index.js';
import { auth, requireAdmin } from '../auth/middleware.js';
import { HttpError } from '../http/errors.js';
import { getPlanUsage } from '../spaces/plan-limits.js';
import { billing, verifyWebhook } from './stripe.js';

/** Admin-only billing. Regular employees never see it. Mounted behind requireAuth. */
export const billingRouter = Router();
billingRouter.use(requireAdmin);

billingRouter.get('/', async (req, res) => {
  const { orgId } = auth(req);
  const body = await withTenant(orgId, async (tx): Promise<BillingOverview> => {
    const plans = await tx.selectFrom('plans').selectAll().orderBy('sort_order').execute();
    return {
      configured: billing.configured,
      plans: plans.map((p) => ({
        id: p.id, name: p.name, roomLimit: p.room_limit, monthlyPriceCents: p.monthly_price_cents,
      })),
      usage: await getPlanUsage(tx, orgId),
    };
  });
  res.json(body);
});

/**
 * Sends the admin to Stripe's checkout page for a paid plan. The plan does not
 * change here: it changes when Stripe's webhook confirms the payment.
 */
billingRouter.post('/checkout', async (req, res) => {
  const { orgId, userId } = auth(req);
  const { planId } = checkoutSchema.parse(req.body);
  const priceId = config.stripe.prices[planId];
  if (!billing.configured || !priceId) {
    throw new HttpError(503, 'BILLING_NOT_CONFIGURED', 'Upgrades are not switched on for this server');
  }
  const user = await withDb((tx) =>
    tx.selectFrom('users').select('email').where('id', '=', userId).where('org_id', '=', orgId).executeTakeFirstOrThrow(),
  );
  res.json({ url: await billing.createCheckout({ orgId, planId, priceId, email: user.email }) });
});

/**
 * Stripe calls this when something happens on its side. Mounted before
 * express.json(), because the signature is checked against the raw body.
 *
 *   checkout.session.completed    → the company paid: switch it to the plan it bought
 *   customer.subscription.deleted → the subscription ended: back to the Free plan
 *
 * Both updates just set a value, so receiving the same event twice does no harm.
 */
export const stripeWebhookRouter = Router();

stripeWebhookRouter.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  let event: Stripe.Event;
  try {
    event = verifyWebhook(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''));
  } catch {
    res.status(400).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid Stripe signature' } });
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { orgId, planId } = session.metadata ?? {};
    if (orgId && planId && config.stripe.prices[planId]) {
      await withDb((tx) =>
        tx.updateTable('organizations')
          .set({
            plan_id: planId,
            stripe_customer_id: String(session.customer),
            stripe_subscription_id: String(session.subscription),
          })
          .where('id', '=', orgId)
          .execute(),
      );
    }
  } else if (event.type === 'customer.subscription.deleted') {
    await withDb((tx) =>
      tx.updateTable('organizations')
        .set({ plan_id: 'free', stripe_subscription_id: null })
        .where('stripe_subscription_id', '=', event.data.object.id)
        .execute(),
    );
  }
  res.json({ received: true });
});
