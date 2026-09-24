import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { closeDb, systemPool } from '../../src/db/index.js';
import { billing, type BillingGateway } from '../../src/billing/gateway.js';
import { closePools, pgCode, withOrg } from '../helpers/db.js';
import { addMember, api, bearer, signupOrg, type TestSession } from '../helpers/api.js';

afterAll(async () => {
  await closeDb();
  await closePools();
});

const stripe = new Stripe('sk_test_offline');
const SECRET = 'whsec_test_secret';

function postEvent(event: object, secret = SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return api().post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
}

let eventClock = 1_900_000_000;
function subscriptionEvent(p: {
  type?: 'created' | 'updated' | 'deleted'; customer: string; subId?: string; price?: string;
  status?: string; created?: number; id?: string;
}) {
  const created = p.created ?? eventClock++;
  return {
    id: p.id ?? `evt_${randomUUID()}`,
    object: 'event',
    type: `customer.subscription.${p.type ?? 'updated'}`,
    created,
    data: {
      object: {
        id: p.subId ?? `sub_for_${p.customer}`,
        object: 'subscription',
        customer: p.customer,
        status: p.status ?? 'active',
        cancel_at_period_end: false,
        metadata: {},
        items: { data: [{ price: { id: p.price ?? 'price_test_pro' }, current_period_end: created + 30 * 86400 }] },
      },
    },
  };
}

async function orgWithCustomer(): Promise<{ admin: TestSession; customer: string }> {
  const admin = await signupOrg();
  const customer = `cus_${randomUUID().slice(0, 12)}`;
  await systemPool.query('UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2', [customer, admin.org.id]);
  return { admin, customer };
}

const planOf = async (orgId: string) =>
  (await systemPool.query('SELECT plan_id FROM organizations WHERE id = $1', [orgId])).rows[0].plan_id as string;

describe('Stripe webhook', () => {
  it('rejects unsigned or wrongly signed requests', async () => {
    const { customer } = await orgWithCustomer();
    const event = subscriptionEvent({ customer });
    expect((await postEvent(event, 'whsec_wrong')).status).toBe(400);
    const unsigned = await api().post('/api/webhooks/stripe').set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(unsigned.status).toBe(400);
  });

  it('an active Pro subscription upgrades the org and lifts the room cap', async () => {
    const { admin, customer } = await orgWithCustomer();
    const res = await postEvent(subscriptionEvent({ type: 'created', customer }));
    expect(res.body).toEqual({ received: true, outcome: 'applied' });
    expect(await planOf(admin.org.id)).toBe('pro');

    const overview = await api().get('/api/billing').set('Authorization', bearer(admin));
    expect(overview.body.subscription).toMatchObject({ status: 'active', planId: 'pro', cancelAtPeriodEnd: false });
    expect(overview.body.usage).toMatchObject({ planId: 'pro', roomLimit: 25 });
  });

  it('processes a redelivered event only once', async () => {
    const { admin, customer } = await orgWithCustomer();
    const event = subscriptionEvent({ customer, price: 'price_test_enterprise' });
    expect((await postEvent(event)).body.outcome).toBe('applied');
    // Something else changes the plan afterwards; the redelivery must not re-apply the old event.
    await systemPool.query("UPDATE organizations SET plan_id = 'pro' WHERE id = $1", [admin.org.id]);
    expect((await postEvent(event)).body.outcome).toBe('duplicate');
    expect(await planOf(admin.org.id)).toBe('pro');
  });

  it('ignores events that arrive out of order', async () => {
    const { admin, customer } = await orgWithCustomer();
    await postEvent(subscriptionEvent({ customer, status: 'active', created: 2_000_000_200 }));
    const stale = await postEvent(subscriptionEvent({ customer, status: 'incomplete', created: 2_000_000_100 }));
    expect(stale.body.outcome).toBe('ignored');
    expect(await planOf(admin.org.id)).toBe('pro');
  });

  it('keeps the plan while past_due (grace period) and drops to Free when unpaid or deleted', async () => {
    const { admin, customer } = await orgWithCustomer();
    await postEvent(subscriptionEvent({ customer, status: 'active' }));
    await postEvent(subscriptionEvent({ customer, status: 'past_due' }));
    expect(await planOf(admin.org.id)).toBe('pro');
    await postEvent(subscriptionEvent({ customer, status: 'unpaid' }));
    expect(await planOf(admin.org.id)).toBe('free');
    await postEvent(subscriptionEvent({ customer, status: 'active' }));
    await postEvent(subscriptionEvent({ type: 'deleted', customer, status: 'canceled' }));
    expect(await planOf(admin.org.id)).toBe('free');
    const overview = await api().get('/api/billing').set('Authorization', bearer(admin));
    expect(overview.body.subscription.status).toBe('canceled');
  });

  it("the end of an old, replaced subscription doesn't downgrade the new one", async () => {
    const { admin, customer } = await orgWithCustomer();
    await postEvent(subscriptionEvent({ type: 'created', customer, subId: `sub_new_${customer}`, price: 'price_test_enterprise' }));
    const old = await postEvent(subscriptionEvent({ type: 'deleted', customer, subId: `sub_old_${customer}`, status: 'canceled' }));
    expect(old.body.outcome).toBe('ignored');
    expect(await planOf(admin.org.id)).toBe('enterprise');
  });

  it('ignores unknown customers and unknown prices', async () => {
    expect((await postEvent(subscriptionEvent({ customer: 'cus_nobody' }))).body.outcome).toBe('ignored');
    const { admin, customer } = await orgWithCustomer();
    expect((await postEvent(subscriptionEvent({ customer, price: 'price_mystery' }))).body.outcome).toBe('ignored');
    expect(await planOf(admin.org.id)).toBe('free');
  });

  it('downgrading keeps existing rooms but blocks adding more', async () => {
    const { admin, customer } = await orgWithCustomer();
    await postEvent(subscriptionEvent({ customer }));
    const b = await api().post('/api/buildings').set('Authorization', bearer(admin)).send({ name: 'HQ', timezone: 'UTC' });
    const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', bearer(admin)).send({ name: 'G', level: 0 });
    for (let i = 0; i < 5; i++) {
      expect((await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', bearer(admin)).send({ name: `R${i}`, capacity: 4 })).status).toBe(201);
    }
    await postEvent(subscriptionEvent({ type: 'deleted', customer, status: 'canceled' }));
    const usage = await api().get('/api/plan-usage').set('Authorization', bearer(admin));
    expect(usage.body).toMatchObject({ planId: 'free', activeRooms: 5, roomLimit: 3 });
    expect((await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', bearer(admin)).send({ name: 'R9', capacity: 4 })).status).toBe(402);
  });
});

describe('plan changes are webhook-only', () => {
  it("the tenant database role cannot change its own org's plan", async () => {
    const admin = await signupOrg();
    const err = await withOrg(admin.org.id, (c) =>
      c.query("UPDATE organizations SET plan_id = 'enterprise' WHERE id = $1", [admin.org.id]),
    ).catch((e) => e);
    expect(pgCode(err)).toBe('42501');
  });
});

describe('checkout and portal', () => {
  const calls: string[] = [];
  const stub: BillingGateway = {
    createCustomer: async ({ orgId }) => { calls.push(`customer:${orgId}`); return `cus_stub_${orgId.slice(0, 8)}`; },
    createCheckoutSession: async ({ customerId, priceId }) => {
      calls.push(`checkout:${customerId}:${priceId}`);
      return 'https://checkout.stripe.test/session';
    },
    createPortalSession: async ({ customerId }) => { calls.push(`portal:${customerId}`); return 'https://billing.stripe.test/portal'; },
  };
  let original: BillingGateway | null;
  beforeEach(() => { original = billing.gateway; billing.gateway = stub; calls.length = 0; });
  afterEach(() => { billing.gateway = original; });

  it('answers 503 when Stripe is not configured', async () => {
    billing.gateway = null;
    const admin = await signupOrg();
    const res = await api().post('/api/billing/checkout').set('Authorization', bearer(admin)).send({ planId: 'pro' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BILLING_NOT_CONFIGURED');
    expect((await api().get('/api/billing').set('Authorization', bearer(admin))).body.configured).toBe(false);
  });

  it('creates the Stripe customer once, then a checkout session for the right price', async () => {
    const admin = await signupOrg();
    const first = await api().post('/api/billing/checkout').set('Authorization', bearer(admin)).send({ planId: 'pro' });
    expect(first.body).toEqual({ url: 'https://checkout.stripe.test/session' });
    await api().post('/api/billing/checkout').set('Authorization', bearer(admin)).send({ planId: 'enterprise' });
    const customer = `cus_stub_${admin.org.id.slice(0, 8)}`;
    expect(calls).toEqual([
      `customer:${admin.org.id}`,
      `checkout:${customer}:price_test_pro`,
      `checkout:${customer}:price_test_enterprise`,
    ]);
    // Checkout alone never changes the plan; only the webhook does.
    expect(await planOf(admin.org.id)).toBe('free');
  });

  it('refuses a second subscription and sends admins to the portal instead', async () => {
    const { admin, customer } = await orgWithCustomer();
    await postEvent(subscriptionEvent({ customer }));
    const res = await api().post('/api/billing/checkout').set('Authorization', bearer(admin)).send({ planId: 'enterprise' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBSCRIBED');
    const portal = await api().post('/api/billing/portal').set('Authorization', bearer(admin));
    expect(portal.body).toEqual({ url: 'https://billing.stripe.test/portal' });
    expect(calls).toEqual([`portal:${customer}`]);
  });

  it('is invisible to employees', async () => {
    const admin = await signupOrg();
    const employee = await addMember(admin);
    expect((await api().get('/api/billing').set('Authorization', bearer(employee))).status).toBe(403);
    expect((await api().post('/api/billing/checkout').set('Authorization', bearer(employee)).send({ planId: 'pro' })).status).toBe(403);
  });
});
