/**
 * Password hashing with bcrypt + the configurable password policy (R9).
 */
import bcrypt from "bcrypt";
import { loadConfig } from "../config.ts";

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface PasswordPolicy {
  minLength: number;
  requireComplexity: boolean;
}

/** The active policy, read through loadConfig (env-configurable). */
export function activePasswordPolicy(): PasswordPolicy {
  const c = loadConfig();
  return { minLength: c.passwordPolicy.minLength, requireComplexity: c.passwordPolicy.requireComplexity };
}

/**
 * Validate a plaintext password against the policy. Returns null when the
 * password is acceptable, otherwise a human-readable violation message.
 */
export function validatePasswordPolicy(
  password: string,
  policy: PasswordPolicy = activePasswordPolicy(),
): string | null {
  if (password.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters long`;
  }
  if (policy.requireComplexity) {
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    if (!hasLower || !hasUpper || !hasDigit) {
      return "Password must mix upper-case, lower-case, and digits";
    }
  }
  return null;
}
