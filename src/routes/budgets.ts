import { Router, Response } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { getPeriodRange, getExpenseSpendByCategory } from "../lib/finance.js";

const router = Router();

function isPositiveNumber(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

async function isCategoryUsableByUser(categoryId: number, userId: number): Promise<boolean> {
  const cat = await prisma.category.findFirst({
    where: { id: categoryId, OR: [{ isDefault: true }, { userId }] },
    select: { id: true },
  });
  return !!cat;
}

async function attachProgress(budgets: any[], userId: number) {
  if (budgets.length === 0) return [];

  // Group by period so each period window is computed once
  const byPeriod = new Map<string, any[]>();
  for (const b of budgets) {
    const list = byPeriod.get(b.period) ?? [];
    list.push(b);
    byPeriod.set(b.period, list);
  }

  const spendMap = new Map<number, number>();
  for (const [period, group] of byPeriod) {
    const { startDate, endDate } = getPeriodRange(period);
    const ids = group.map((b: any) => b.categoryId);
    const spend = await getExpenseSpendByCategory(userId, ids, startDate, endDate);
    for (const [catId, total] of spend) spendMap.set(catId, total);
  }

  return budgets.map((budget) => {
    const spent = spendMap.get(budget.categoryId) ?? 0;
    const remaining = Math.max(0, budget.amount - spent);
    const percentage = budget.amount > 0 ? Math.min(100, (spent / budget.amount) * 100) : 0;
    return {
      ...budget,
      categoryName: budget.category?.name ?? "Unknown",
      spent,
      remaining,
      percentage,
      isOverBudget: spent > budget.amount,
      createdAt: budget.createdAt instanceof Date ? budget.createdAt.toISOString() : budget.createdAt,
    };
  });
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const budgets = await prisma.budget.findMany({
      where: { userId: req.userId! },
      include: { category: { select: { name: true, icon: true } } },
    });
    res.json(await attachProgress(budgets, req.userId!));
  } catch (err) {
    logger.error({ err }, "List budgets error");
    res.status(500).json({ error: "Failed to fetch budgets" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, amount, period, categoryId } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!isPositiveNumber(amount)) { res.status(400).json({ error: "amount must be a positive number" }); return; }
    if (!["daily", "weekly", "monthly", "yearly"].includes(period)) { res.status(400).json({ error: "period must be one of daily, weekly, monthly, yearly" }); return; }
    const catId = parseInt(categoryId);
    if (!Number.isInteger(catId)) { res.status(400).json({ error: "categoryId is required" }); return; }
    if (!(await isCategoryUsableByUser(catId, req.userId!))) { res.status(400).json({ error: "Invalid category" }); return; }

    const budget = await prisma.budget.create({
      data: { userId: req.userId!, name: name.trim(), amount: Number(amount), period, categoryId: catId },
      include: { category: { select: { name: true, icon: true } } },
    });
    const [withProgress] = await attachProgress([budget], req.userId!);
    res.status(201).json(withProgress);
  } catch (err) {
    logger.error({ err }, "Create budget error");
    res.status(500).json({ error: "Failed to create budget" });
  }
});

async function updateBudgetHandler(req: AuthRequest, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid budget id" }); return; }

    const existing = await prisma.budget.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Budget not found" }); return; }

    const { name, amount, period, categoryId } = req.body;
    const data: Record<string, any> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name cannot be empty" }); return; }
      data.name = name.trim();
    }
    if (amount !== undefined) {
      if (!isPositiveNumber(amount)) { res.status(400).json({ error: "amount must be a positive number" }); return; }
      data.amount = Number(amount);
    }
    if (period !== undefined) {
      if (!["daily", "weekly", "monthly", "yearly"].includes(period)) { res.status(400).json({ error: "Invalid period" }); return; }
      data.period = period;
    }
    if (categoryId !== undefined) {
      const catId = parseInt(categoryId);
      if (!Number.isInteger(catId) || !(await isCategoryUsableByUser(catId, req.userId!))) { res.status(400).json({ error: "Invalid category" }); return; }
      data.categoryId = catId;
    }

    const budget = await prisma.budget.update({
      where: { id },
      data,
      include: { category: { select: { name: true, icon: true } } },
    });
    const [withProgress] = await attachProgress([budget], req.userId!);
    res.json(withProgress);
  } catch (err) {
    logger.error({ err }, "Update budget error");
    res.status(500).json({ error: "Failed to update budget" });
  }
}

router.patch("/:id", requireAuth, updateBudgetHandler);
router.put("/:id", requireAuth, updateBudgetHandler);

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid budget id" }); return; }

    const existing = await prisma.budget.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Budget not found" }); return; }

    await prisma.budget.delete({ where: { id } });
    res.json({ success: true, message: "Budget deleted" });
  } catch (err) {
    logger.error({ err }, "Delete budget error");
    res.status(500).json({ error: "Failed to delete budget" });
  }
});

export default router;
