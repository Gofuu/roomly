import { z } from 'zod';
import type { PlanUsage } from './spaces.js';

export const checkoutSchema = z.object({ planId: z.enum(['pro', 'enterprise']) });
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export interface PlanInfo {
  id: string;
  name: string;
  roomLimit: number | null;
  monthlyPriceCents: number;
  /** A Stripe price is configured for it, so it can be bought. */
  purchasable: boolean;
}

export interface BillingOverview {
  /** False until the server has Stripe keys; the UI then explains how to set them. */
  configured: boolean;
  plans: PlanInfo[];
  usage: PlanUsage;
  subscription: {
    status: string;
    planId: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  hasCustomer: boolean;
}
