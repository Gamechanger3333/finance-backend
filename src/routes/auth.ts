import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { db, usersTable } from "../db/index.js";
import { eq } from "drizzle-orm";
import { signToken, requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ─── Rate Limiters ────────────────────────────────────────────────────────────

// Strict limiter for login/register: 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many attempts, please try again after 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Looser limiter for /me and profile: 60 requests per minute
const profileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, slow down" },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isStrongPassword(password: string): boolean {
  // Min 8 chars, at least one uppercase, one lowercase, one digit, one special char
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/.test(password);
}

function sanitizeUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    userType: user.userType,
    currency: user.currency,
    monthlyIncomeGoal: user.monthlyIncomeGoal,
    financialHealthScore: user.financialHealthScore,
    createdAt: user.createdAt.toISOString(),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/auth/register
router.post("/register", authLimiter, async (req, res) => {
  try {
    const { name, email, password, userType } = req.body;

    // Presence check
    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email and password are required" });
      return;
    }

    // Name length
    if (typeof name !== "string" || name.trim().length < 2) {
      res.status(400).json({ error: "Name must be at least 2 characters" });
      return;
    }

    // Email format
    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    // Strong password
    if (!isStrongPassword(password)) {
      res.status(400).json({
        error:
          "Password must be at least 8 characters and include uppercase, lowercase, number, and special character",
      });
      return;
    }

    // Duplicate email
    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email.trim().toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      res.status(400).json({ error: "Email already registered" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [user] = await db
      .insert(usersTable)
      .values({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        passwordHash,
        userType: userType || "individual",
        currency: "USD",
      })
      .returning();

    const token = signToken(user.id);
    res.status(201).json({ user: sanitizeUser(user), token });
  } catch (err) {
    logger.error({ err }, "Register error");
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/auth/login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    if (!isValidEmail(email)) {
      // Generic message — don't leak whether email exists
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email.trim().toLowerCase()))
      .limit(1);

    // Constant-time compare even when user not found (prevents timing attacks)
    const dummyHash =
      "$2a$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const valid = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, dummyHash);

    if (!user || !valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = signToken(user.id);
    res.json({ user: sanitizeUser(user), token });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/auth/logout
// JWT is stateless — client must delete the token.
// We return 200 so the frontend can clear its state cleanly.
router.post("/logout", requireAuth, (_req, res) => {
  res.json({ success: true, message: "Logged out successfully" });
});

// GET /api/auth/me
router.get("/me", profileLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.userId!))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    res.json(sanitizeUser(user));
  } catch (err) {
    logger.error({ err }, "Get me error");
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// PUT /api/auth/profile
router.put("/profile", profileLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, currency, monthlyIncomeGoal } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 2) {
        res.status(400).json({ error: "Name must be at least 2 characters" });
        return;
      }
      updates.name = name.trim();
    }

    if (currency !== undefined) updates.currency = currency;
    if (monthlyIncomeGoal !== undefined) updates.monthlyIncomeGoal = monthlyIncomeGoal;

    const [user] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, req.userId!))
      .returning();

    res.json(sanitizeUser(user));
  } catch (err) {
    logger.error({ err }, "Update profile error");
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// PATCH /api/auth/profile (alias)
router.patch("/profile", profileLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, currency, monthlyIncomeGoal } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 2) {
        res.status(400).json({ error: "Name must be at least 2 characters" });
        return;
      }
      updates.name = name.trim();
    }

    if (currency !== undefined) updates.currency = currency;
    if (monthlyIncomeGoal !== undefined) updates.monthlyIncomeGoal = monthlyIncomeGoal;

    const [user] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, req.userId!))
      .returning();

    res.json(sanitizeUser(user));
  } catch (err) {
    logger.error({ err }, "Update profile error");
    res.status(500).json({ error: "Failed to update profile" });
  }
});

export default router;