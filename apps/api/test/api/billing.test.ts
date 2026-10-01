import { afterAll, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { closeDb } from '../../src/db/index.js';
import { billing } from '../../src/billing/stripe.js';
import { addMember, api, bearer, signupOrg, type TestSession } from '../helpers/api.js';

afterAll(closeDb);

// Stripe is never called. Webhook events are signed here with the test secret,
// the same way Stripe signs real ones.
const stripe = new Stripe('sk_test_offline');
const SECRET = 'whsec_test_secret';

function postEvent(event: object, secret = SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return api().post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
}

const checkoutCompleted = (orgId: string, planId: string, subscription: string) => ({
  id: `evt_${subscription}`,
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_1', customer: 'cus_test_1', subscription, metadata: { orgId, planId } } },
});

const planOf = async (s: TestSession) =>
  (await api().get('/api/plan-usage').set('Authorization', bearer(s))).body.planId as string;

describe('billing', () => {
  it('shows plans and usage to admins only', async () => {
    const admin = await signupOrg();
    const employee = await addMember(admin);
    const res = await api().get('/api/billing').set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'pro', 'enterprise']);
    expect(res.body.usage).toMatchObject({ planId: 'free', roomLimit: 3 });
    expect((await api().get('/api/billing').set('Authorization', bearer(employee))).status).toBe(403);
  });

  it('checkout returns the Stripe page to go to, and does not change the plan by itself', async () => {
    const admin = await signupOrg();
    const off = await api().post('/api/billing/checkout').set('Authorization', bearer(admin)).send({ planId: 'pro' });
    expect(off.status).toBe(503); // no Stripe key in tests

    billing.configured = true;
    const createCheckout = vi.spyOn(billing, 'createCheckout').mockResolvedValue('https://checkout.stripe.test/session');
    try {
      const res = await api().post('/api/billing/checkout').set('Authorization', bearer(admin)).send({ planId: 'pro' });
      expect(res.body).toEqual({ url: 'https://checkout.stripe.test/session' });
      expect(createCheckout).toHaveBeenCalledWith({
        orgId: admin.org.id, planId: 'pro', priceId: 'price_test_pro', email: admin.email,
      });
      expect(await planOf(admin)).toBe('free');
    } finally {
      billing.configured = false;
      createCheckout.mockRestore();
    }
  });
});

describe('Stripe webhook', () => {
  it('rejects an event that is not signed with our secret', async () => {
    const admin = await signupOrg();
    const res = await postEvent(checkoutCompleted(admin.org.id, 'pro', 'sub_forged'), 'whsec_wrong');
    expect(res.status).toBe(400);
    expect(await planOf(admin)).toBe('free');
  });

  it('a completed checkout switches the company to the plan it paid for; a cancelled subscription puts it back on Free', async () => {
    const admin = await signupOrg();
    const subscription = `sub_${admin.org.id.slice(0, 8)}`;

    expect((await postEvent(checkoutCompleted(admin.org.id, 'pro', subscription))).status).toBe(200);
    expect(await planOf(admin)).toBe('pro');

    const deleted = { id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { id: subscription } } };
    expect((await postEvent(deleted)).status).toBe(200);
    expect(await planOf(admin)).toBe('free');
  });
});
