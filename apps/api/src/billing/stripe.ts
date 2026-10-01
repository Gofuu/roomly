/**
 * The only file that talks to Stripe. `billing.createCheckout` is replaceable
 * so tests can run without calling Stripe.
 */
import Stripe from 'stripe';
import { config } from '../config.js';

const stripe = new Stripe(config.stripe.secretKey ?? 'sk_test_not_configured');

export const billing = {
  /** True once STRIPE_SECRET_KEY is set. */
  configured: !!config.stripe.secretKey,

  /** Starts a Stripe-hosted checkout for a plan and returns the page's URL. */
  async createCheckout(p: { orgId: string; planId: string; priceId: string; email: string }): Promise<string> {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: p.email,
      line_items: [{ price: p.priceId, quantity: 1 }],
      // Read back by the webhook to know which company bought which plan.
      metadata: { orgId: p.orgId, planId: p.planId },
      success_url: `${config.webOrigin}/admin/billing?checkout=success`,
      cancel_url: `${config.webOrigin}/admin/billing?checkout=cancelled`,
    });
    return session.url!;
  },
};

/**
 * Checks that a webhook really came from Stripe: the Stripe-Signature header is
 * an HMAC of the exact request body, made with a secret only Stripe and we know.
 * Throws if it does not match.
 */
export function verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  if (!config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
