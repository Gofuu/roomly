import { hash, verify } from '@node-rs/argon2';

// argon2id with OWASP-recommended parameters (19 MiB memory, 2 iterations).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password).catch(() => false);
}

// Verified against when the email is unknown, so "no such user" and "wrong
// password" take the same time and cannot be told apart by timing.
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  return (dummyHash ??= hashPassword('not-a-real-password'));
}
