import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import prisma from "../db/index.js";
import { signToken, requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../lib/email.js";
import { generateToken, generateOtp, hashToken, minutesFromNow, isExpired } from "../lib/tokens.js";

const router = Router();

const VERIFICATION_TTL_MIN = 15;
const RESET_TTL_MIN = 15;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many attempts, please try again after 15 minutes" }, standardHeaders: true, legacyHeaders: false });
const profileLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: "Too many requests" }, standardHeaders: true, legacyHeaders: false });
const emailSendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: "Too many email requests, please try again later" }, standardHeaders: true, legacyHeaders: false });

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isStrongPassword(password: string): boolean {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/.test(password);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sanitizeUser(user: any) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    userType: user.userType,
    currency: user.currency,
    monthlyIncomeGoal: user.monthlyIncomeGoal,
    financialHealthScore: user.financialHealthScore,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt,
  };
}

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

async function issueVerificationChallenge(user: any) {
  const { raw: rawToken, hash: tokenHash } = generateToken();
  const { raw: rawOtp, hash: otpHash } = generateOtp();
  const expiresAt = minutesFromNow(VERIFICATION_TTL_MIN);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationTokenHash: tokenHash,
      verificationOtpHash: otpHash,
      verificationExpiresAt: expiresAt,
      verificationAttempts: 0,
      lastVerificationSentAt: new Date(),
    },
  });

  const verifyUrl = `${FRONTEND_URL}/verify-email?token=${rawToken}&email=${encodeURIComponent(user.email)}`;
  await sendVerificationEmail({ to: user.email, name: user.name, otp: rawOtp, verifyUrl });
}

async function issueResetChallenge(user: any) {
  const { raw: rawToken, hash: tokenHash } = generateToken();
  const { raw: rawOtp, hash: otpHash } = generateOtp();
  const expiresAt = minutesFromNow(RESET_TTL_MIN);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetTokenHash: tokenHash,
      resetOtpHash: otpHash,
      resetExpiresAt: expiresAt,
      resetAttempts: 0,
      lastResetSentAt: new Date(),
    },
  });

  const resetUrl = `${FRONTEND_URL}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;
  await sendPasswordResetEmail({ to: user.email, name: user.name, otp: rawOtp, resetUrl });
}

// POST /api/auth/register
router.post("/register", authLimiter, async (req, res) => {
  try {
    const { name, email, password, userType } = req.body;
    if (!name || !email || !password) { res.status(400).json({ error: "name, email and password are required" }); return; }
    if (typeof name !== "string" || name.trim().length < 2) { res.status(400).json({ error: "Name must be at least 2 characters" }); return; }
    if (!isValidEmail(email)) { res.status(400).json({ error: "Invalid email address" }); return; }
    if (!isStrongPassword(password)) {
      res.status(400).json({ error: "Password must be at least 8 characters and include uppercase, lowercase, number, and special character" });
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
    if (existing) { res.status(400).json({ error: "Email already registered" }); return; }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { name: name.trim(), email: normalizedEmail, passwordHash, userType: userType || "individual", currency: "USD", emailVerified: false },
    });

    try { await issueVerificationChallenge(user); } catch (emailErr) {
      logger.error({ err: emailErr }, "Failed to send verification email on register");
    }

    res.status(201).json({ message: "Account created. Please check your email for a verification code.", email: user.email, requiresVerification: true });
  } catch (err) {
    logger.error({ err }, "Register error");
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/auth/login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) { res.status(400).json({ error: "email and password are required" }); return; }
    if (!isValidEmail(email)) { res.status(401).json({ error: "Invalid email or password" }); return; }

    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    const dummyHash = "$2a$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const valid = user ? await bcrypt.compare(password, user.passwordHash) : await bcrypt.compare(password, dummyHash);

    if (!user || !valid) { res.status(401).json({ error: "Invalid email or password" }); return; }
    if (!user.emailVerified) {
      res.status(403).json({ error: "Please verify your email before logging in", requiresVerification: true, email: user.email });
      return;
    }

    const token = signToken(user.id);
    res.json({ user: sanitizeUser(user), token });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/auth/verify-email
router.post("/verify-email", authLimiter, async (req, res) => {
  try {
    const { email, otp, token } = req.body;
    let user: any;

    if (token) {
      const tokenHash = hashToken(token);
      user = await prisma.user.findFirst({ where: { verificationTokenHash: tokenHash } });
    } else if (email && otp) {
      user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    } else {
      res.status(400).json({ error: "Provide either a token or an email + OTP code" }); return;
    }

    if (!user) { res.status(400).json({ error: "Invalid or expired verification request" }); return; }
    if (user.emailVerified) { res.json({ message: "Email already verified", alreadyVerified: true }); return; }
    if (isExpired(user.verificationExpiresAt)) { res.status(400).json({ error: "Verification code expired. Please request a new one." }); return; }
    if (user.verificationAttempts >= MAX_OTP_ATTEMPTS) { res.status(429).json({ error: "Too many attempts. Please request a new verification code." }); return; }

    if (!token) {
      const otpHash = hashToken(String(otp));
      if (otpHash !== user.verificationOtpHash) {
        await prisma.user.update({ where: { id: user.id }, data: { verificationAttempts: user.verificationAttempts + 1 } });
        res.status(400).json({ error: "Invalid verification code" }); return;
      }
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, verificationTokenHash: null, verificationOtpHash: null, verificationExpiresAt: null, verificationAttempts: 0 },
    });

    const authToken = signToken(user.id);
    res.json({ message: "Email verified successfully", user: sanitizeUser(updated), token: authToken });
  } catch (err) {
    logger.error({ err }, "Verify email error");
    res.status(500).json({ error: "Verification failed" });
  }
});

// POST /api/auth/resend-verification
router.post("/resend-verification", emailSendLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) { res.status(400).json({ error: "Valid email is required" }); return; }

    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    const generic = { message: "If an account with that email exists and is unverified, a new code has been sent." };

    if (!user || user.emailVerified) { res.json(generic); return; }
    if (user.lastVerificationSentAt && Date.now() - user.lastVerificationSentAt.getTime() < RESEND_COOLDOWN_MS) {
      res.status(429).json({ error: "Please wait a moment before requesting another code" }); return;
    }

    await issueVerificationChallenge(user);
    res.json(generic);
  } catch (err) {
    logger.error({ err }, "Resend verification error");
    res.status(500).json({ error: "Failed to resend verification email" });
  }
});

// POST /api/auth/forgot-password
router.post("/forgot-password", emailSendLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) { res.status(400).json({ error: "Valid email is required" }); return; }

    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    const generic = { message: "If an account with that email exists, a password reset code has been sent." };

    if (!user) { res.json(generic); return; }
    if (user.lastResetSentAt && Date.now() - user.lastResetSentAt.getTime() < RESEND_COOLDOWN_MS) { res.json(generic); return; }

    await issueResetChallenge(user);
    res.json(generic);
  } catch (err) {
    logger.error({ err }, "Forgot password error");
    res.status(500).json({ error: "Failed to process request" });
  }
});

// POST /api/auth/reset-password
router.post("/reset-password", authLimiter, async (req, res) => {
  try {
    const { email, otp, token, newPassword } = req.body;
    if (!newPassword) { res.status(400).json({ error: "New password is required" }); return; }
    if (!isStrongPassword(newPassword)) {
      res.status(400).json({ error: "Password must be at least 8 characters and include uppercase, lowercase, number, and special character" }); return;
    }

    let user: any;
    if (token) {
      user = await prisma.user.findFirst({ where: { resetTokenHash: hashToken(token) } });
    } else if (email && otp) {
      user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    } else {
      res.status(400).json({ error: "Provide either a token or an email + OTP code" }); return;
    }

    if (!user || !user.resetTokenHash) { res.status(400).json({ error: "Invalid or expired reset request" }); return; }
    if (isExpired(user.resetExpiresAt)) { res.status(400).json({ error: "Reset code expired. Please request a new one." }); return; }
    if (user.resetAttempts >= MAX_OTP_ATTEMPTS) { res.status(429).json({ error: "Too many attempts. Please request a new reset code." }); return; }

    if (!token) {
      const otpHash = hashToken(String(otp));
      if (otpHash !== user.resetOtpHash) {
        await prisma.user.update({ where: { id: user.id }, data: { resetAttempts: user.resetAttempts + 1 } });
        res.status(400).json({ error: "Invalid reset code" }); return;
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetTokenHash: null, resetOtpHash: null, resetExpiresAt: null, resetAttempts: 0 },
    });

    res.json({ message: "Password reset successfully. You can now log in." });
  } catch (err) {
    logger.error({ err }, "Reset password error");
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// POST /api/auth/logout
router.post("/logout", requireAuth, (_req, res) => {
  res.json({ success: true, message: "Logged out successfully" });
});

// GET /api/auth/me
router.get("/me", profileLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) { res.status(401).json({ error: "User not found" }); return; }
    res.json(sanitizeUser(user));
  } catch (err) {
    logger.error({ err }, "Get me error");
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// PUT + PATCH /api/auth/profile
async function updateProfileHandler(req: AuthRequest, res: any) {
  try {
    const { name, currency, monthlyIncomeGoal } = req.body;
    const data: Record<string, any> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 2) { res.status(400).json({ error: "Name must be at least 2 characters" }); return; }
      data.name = name.trim();
    }
    if (currency !== undefined) data.currency = currency;
    if (monthlyIncomeGoal !== undefined) data.monthlyIncomeGoal = monthlyIncomeGoal;

    const user = await prisma.user.update({ where: { id: req.userId! }, data });
    res.json(sanitizeUser(user));
  } catch (err) {
    logger.error({ err }, "Update profile error");
    res.status(500).json({ error: "Failed to update profile" });
  }
}

router.put("/profile", profileLimiter, requireAuth, updateProfileHandler);
router.patch("/profile", profileLimiter, requireAuth, updateProfileHandler);

export default router;
