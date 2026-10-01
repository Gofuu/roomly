import { z } from 'zod';
import type { PlanUsage } from './spaces.js';

export const checkoutSchema = z.object({ planId: z.enum(['pro', 'enterprise']) });
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export interface PlanInfo {
  id: string;
  name: string;
  roomLimit: number | null;
  monthlyPriceCents: number;
}

export interface BillingOverview {
  /** False until the server has Stripe keys. The page then explains that upgrades are switched off. */
  configured: boolean;
  plans: PlanInfo[];
  usage: PlanUsage;
}
