import crypto from "crypto";

/**
 * Generates a cryptographically secure random token for email links.
 * Returns both the raw token (sent to the user) and its SHA-256 hash
 * (stored in DB). We never store the raw token — same principle as
 * password hashing, so a DB leak can't be used to verify/reset accounts.
 */
export function generateToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = hashToken(raw);
  return { raw, hash };
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Generates a 6-digit numeric OTP plus its hash for storage.
 */
export function generateOtp(): { raw: string; hash: string } {
  const raw = crypto.randomInt(100000, 1000000).toString();
  const hash = hashToken(raw);
  return { raw, hash };
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function isExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return true;
  return new Date() > expiresAt;
}
