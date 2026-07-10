import { Router, Response } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { calculatePayoffPlan } from "../lib/debt-planner.js";

const router = Router();

const DEBT_TYPES = ["credit_card", "student_loan", "auto_loan", "personal_loan", "mortgage", "other"];

function isPositiveNumber(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function isNonNegativeNumber(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

function serializeDebt(debt: any) {
  return {
    ...debt,
    createdAt: debt.createdAt instanceof Date ? debt.createdAt.toISOString() : debt.createdAt,
  };
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const debts = await prisma.debt.findMany({
      where: { userId: req.userId! },
      orderBy: [{ isPaidOff: "asc" }, { balance: "asc" }],
    });
    res.json(debts.map(serializeDebt));
  } catch (err) {
    logger.error({ err }, "List debts error");
    res.status(500).json({ error: "Failed to fetch debts" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, debtType, balance, interestRate, minimumPayment } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (debtType !== undefined && !DEBT_TYPES.includes(debtType)) { res.status(400).json({ error: `debtType must be one of: ${DEBT_TYPES.join(", ")}` }); return; }
    if (!isPositiveNumber(balance)) { res.status(400).json({ error: "balance must be a positive number" }); return; }
    if (interestRate !== undefined && !isNonNegativeNumber(interestRate)) { res.status(400).json({ error: "interestRate must be zero or a positive number" }); return; }
    if (!isPositiveNumber(minimumPayment)) { res.status(400).json({ error: "minimumPayment must be a positive number" }); return; }

    const debt = await prisma.debt.create({
      data: {
        userId: req.userId!,
        name: name.trim(),
        debtType: debtType || "other",
        balance: Number(balance),
        interestRate: interestRate !== undefined ? Number(interestRate) : 0,
        minimumPayment: Number(minimumPayment),
      },
    });
    res.status(201).json(serializeDebt(debt));
  } catch (err) {
    logger.error({ err }, "Create debt error");
    res.status(500).json({ error: "Failed to create debt" });
  }
});

async function updateDebtHandler(req: AuthRequest, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid debt id" }); return; }

    const existing = await prisma.debt.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Debt not found" }); return; }

    const { name, debtType, balance, interestRate, minimumPayment } = req.body;
    const data: Record<string, any> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name cannot be empty" }); return; }
      data.name = name.trim();
    }
    if (debtType !== undefined) {
      if (!DEBT_TYPES.includes(debtType)) { res.status(400).json({ error: `debtType must be one of: ${DEBT_TYPES.join(", ")}` }); return; }
      data.debtType = debtType;
    }
    if (balance !== undefined) {
      if (!isNonNegativeNumber(balance)) { res.status(400).json({ error: "balance must be zero or a positive number" }); return; }
      data.balance = Number(balance);
      data.isPaidOff = Number(balance) <= 0;
    }
    if (interestRate !== undefined) {
      if (!isNonNegativeNumber(interestRate)) { res.status(400).json({ error: "interestRate must be zero or a positive number" }); return; }
      data.interestRate = Number(interestRate);
    }
    if (minimumPayment !== undefined) {
      if (!isPositiveNumber(minimumPayment)) { res.status(400).json({ error: "minimumPayment must be a positive number" }); return; }
      data.minimumPayment = Number(minimumPayment);
    }

    const debt = await prisma.debt.update({ where: { id }, data });
    res.json(serializeDebt(debt));
  } catch (err) {
    logger.error({ err }, "Update debt error");
    res.status(500).json({ error: "Failed to update debt" });
  }
}

router.patch("/:id", requireAuth, updateDebtHandler);
router.put("/:id", requireAuth, updateDebtHandler);

// Logs a payment against a debt: reduces the balance and records an actual
// expense transaction (so it flows into budgets/dashboard like any other
// spend), same pattern as recurring bills' mark-paid.
router.post("/:id/log-payment", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid debt id" }); return; }
    const { amount } = req.body;
    if (!isPositiveNumber(amount)) { res.status(400).json({ error: "amount must be a positive number" }); return; }

    const debt = await prisma.debt.findFirst({ where: { id, userId: req.userId! } });
    if (!debt) { res.status(404).json({ error: "Debt not found" }); return; }

    const fallback = await prisma.category.findFirst({ where: { isDefault: true, type: "expense" }, select: { id: true } });
    if (!fallback) { res.status(400).json({ error: "No category available to log this payment against" }); return; }

    const newBalance = Math.max(0, debt.balance - Number(amount));
    const today = new Date().toISOString().slice(0, 10);

    const [transaction, updatedDebt] = await prisma.$transaction([
      prisma.transaction.create({
        data: {
          userId: req.userId!,
          type: "expense",
          amount: Number(amount),
          description: `${debt.name} payment`,
          date: today,
          categoryId: fallback.id,
        },
      }),
      prisma.debt.update({ where: { id: debt.id }, data: { balance: newBalance, isPaidOff: newBalance <= 0 } }),
    ]);

    res.json({ transaction, debt: serializeDebt(updatedDebt) });
  } catch (err) {
    logger.error({ err }, "Log debt payment error");
    res.status(500).json({ error: "Failed to log debt payment" });
  }
});

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid debt id" }); return; }

    const existing = await prisma.debt.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Debt not found" }); return; }

    await prisma.debt.delete({ where: { id } });
    res.json({ success: true, message: "Debt deleted" });
  } catch (err) {
    logger.error({ err }, "Delete debt error");
    res.status(500).json({ error: "Failed to delete debt" });
  }
});

// ─── Payoff planner ───────────────────────────────────────────────────────────
// Computes both the snowball and avalanche strategies for the user's active
// debts so the UI can show a side-by-side comparison (interest saved,
// months to debt-free) rather than making the user re-run the calculator.
router.get("/payoff-plan", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const extraMonthly = Math.max(0, Number(req.query.extraMonthly ?? 0) || 0);

    const debts = await prisma.debt.findMany({ where: { userId, isPaidOff: false } });
    const debtInputs = debts.map((d: any) => ({
      id: d.id,
      name: d.name,
      balance: d.balance,
      interestRate: d.interestRate,
      minimumPayment: d.minimumPayment,
    }));

    const snowball = calculatePayoffPlan(debtInputs, extraMonthly, "snowball");
    const avalanche = calculatePayoffPlan(debtInputs, extraMonthly, "avalanche");

    res.json({
      debtCount: debtInputs.length,
      totalBalance: debtInputs.reduce((s: number, d: any) => s + d.balance, 0),
      totalMinimumPayment: debtInputs.reduce((s: number, d: any) => s + d.minimumPayment, 0),
      extraMonthly,
      snowball,
      avalanche,
    });
  } catch (err) {
    logger.error({ err }, "Debt payoff plan error");
    res.status(500).json({ error: "Failed to compute payoff plan" });
  }
});

export default router;
