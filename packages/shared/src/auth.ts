import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');
export const personNameSchema = z.string().trim().min(1).max(120);

export const signupSchema = z.object({
  orgName: z.string().trim().min(1).max(120),
  name: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const roleSchema = z.enum(['admin', 'employee']);
export type Role = z.infer<typeof roleSchema>;

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: roleSchema.default('employee'),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  name: personNameSchema,
  password: passwordSchema,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuthOrg {
  id: string;
  name: string;
  slug: string;
  planId: string;
}

/** Returned by signup, login, refresh and invite acceptance. */
export interface AuthSession {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: AuthUser;
  org: AuthOrg;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  invitedBy: string;
}

export interface InvitationPreview {
  email: string;
  orgName: string;
  role: Role;
}

/** Error body shape for every non-2xx API response. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
