/**
 * Stripe → our database. Stripe is the source of truth for billing; this handler
 * mirrors subscription state into `subscriptions` and sets the org's plan.
 *
 * Three properties matter, and each is tested:
 *  1. Authentic — the Stripe-Signature HMAC is verified over the raw body.
 *  2. Idempotent — each event id is recorded in the same transaction as its effects.
 *  3. Order-tolerant — an event older than the last one applied is ignored.
 */
import express, { Router } from 'express';
import type Stripe from 'stripe';
import { sql } from 'kysely';
import { withSystem, type Tx } from '../db/index.js';
import { planForPrice, verifyWebhook } from './gateway.js';

/** Subscription statuses that keep the paid plan. past_due is a grace period while Stripe retries the card. */
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

type Outcome = 'applied' | 'duplicate' | 'ignored';

async function applySubscription(tx: Tx, event: Stripe.Event, sub: Stripe.Subscription): Promise<Outcome> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  // FOR UPDATE: a plan change serializes with room creation, which takes the same lock.
  const org = await tx
    .selectFrom('organizations')
    .select(['id'])
    .where((eb) => eb.or([
      eb('stripe_customer_id', '=', customerId),
      ...(sub.metadata?.orgId ? [eb('id', '=', sub.metadata.orgId)] : []),
    ]))
    .forUpdate()
    .executeTakeFirst();
  if (!org) return 'ignored'; // a customer we don't know (e.g. from another environment)

  const eventAt = new Date(event.created * 1000);
  const current = await tx.selectFrom('subscriptions').selectAll().where('org_id', '=', org.id).executeTakeFirst();
  if (current && eventAt < current.last_event_at) return 'ignored'; // stale, out-of-order delivery
  // The end of an older, replaced subscription must not downgrade the org's current one.
  if (event.type === 'customer.subscription.deleted' && current && current.stripe_subscription_id !== sub.id) {
    return 'ignored';
  }

  const item = sub.items.data[0];
  const plan = planForPrice(item?.price.id);
  if (!plan) {
    console.warn(`[stripe] subscription ${sub.id} has unrecognised price ${item?.price.id}; ignoring`);
    return 'ignored';
  }
  const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
  const row = {
    stripe_subscription_id: sub.id,
    plan_id: plan,
    status,
    current_period_end: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancel_at_period_end: sub.cancel_at_period_end,
    last_event_at: eventAt,
    updated_at: sql<Date>`now()`,
  };
  await tx.insertInto('subscriptions')
    .values({ org_id: org.id, ...row })
    .onConflict((oc) => oc.column('org_id').doUpdateSet(row))
    .execute();

  await tx.updateTable('organizations')
    .set({ plan_id: PAID_STATUSES.has(status) ? plan : 'free' })
    .where('id', '=', org.id)
    .execute();
  return 'applied';
}

export async function handleStripeEvent(event: Stripe.Event): Promise<Outcome> {
  return withSystem(async (tx) => {
    const fresh = await tx.insertInto('stripe_events')
      .values({ id: event.id, type: event.type })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!fresh) return 'duplicate';

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return applySubscription(tx, event, event.data.object);
      default:
        // Recorded but not acted on. Checkout completion is covered by subscription.created.
        return 'ignored';
    }
  });
}

/** Mounted before express.json(): signature verification needs the exact raw bytes. */
export const stripeWebhookRouter = Router();

stripeWebhookRouter.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event: Stripe.Event;
  try {
    event = verifyWebhook(req.body as Buffer, String(signature ?? ''));
  } catch {
    res.status(400).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid Stripe signature' } });
    return;
  }
  // A thrown error returns 500, and Stripe retries later. The event id was rolled back too.
  const outcome = await handleStripeEvent(event);
  res.json({ received: true, outcome });
});
