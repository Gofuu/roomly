/**
 * The only module that talks to Stripe's API. Everything else depends on this
 * small interface, so tests swap in a stub and run fully offline.
 */
import Stripe from 'stripe';
import { config } from '../config.js';

export interface BillingGateway {
  createCustomer(p: { orgId: string; orgName: string; email: string }): Promise<string>;
  createCheckoutSession(p: {
    customerId: string; priceId: string; orgId: string; successUrl: string; cancelUrl: string;
  }): Promise<string>;
  createPortalSession(p: { customerId: string; returnUrl: string }): Promise<string>;
}

function stripeGateway(stripe: Stripe): BillingGateway {
  return {
    async createCustomer({ orgId, orgName, email }) {
      const customer = await stripe.customers.create({ name: orgName, email, metadata: { orgId } });
      return customer.id;
    },
    async createCheckoutSession({ customerId, priceId, orgId, successUrl, cancelUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: orgId,
        subscription_data: { metadata: { orgId } },
        success_url: successUrl,
        cancel_url: cancelUrl,
        allow_promotion_codes: true,
      });
      if (!session.url) throw new Error('Stripe returned a checkout session without a URL');
      return session.url;
    },
    async createPortalSession({ customerId, returnUrl }) {
      const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
      return session.url;
    },
  };
}

/** Null when STRIPE_SECRET_KEY is not set. Mutable so tests can install a stub. */
export const billing: { gateway: BillingGateway | null } = {
  gateway: config.stripe.secretKey ? stripeGateway(new Stripe(config.stripe.secretKey)) : null,
};

// Signature verification is local crypto (HMAC), so it works without an API key.
const verifier = new Stripe(config.stripe.secretKey ?? 'sk_test_signature_verification_only');

/** Parses a webhook body, throwing if the Stripe-Signature header does not match. */
export function verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  if (!config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return verifier.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

export function planForPrice(priceId: string | undefined): string | null {
  const match = Object.entries(config.stripe.prices).find(([, p]) => p && p === priceId);
  return match ? match[0] : null;
}
