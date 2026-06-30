import { Router } from "express";
import { db, budgetsTable, transactionsTable, categoriesTable } from "../db/index.js";
import { eq, and, gte, lte } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

async function computeBudgetProgress(budget: typeof budgetsTable.$inferSelect, userId: number) {
  const now = new Date();
  let startDate: string, endDate: string;

  if (budget.period === "monthly") {
    startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${lastDay}`;
  } else if (budget.period === "weekly") {
    const day = now.getDay();
    const start = new Date(now);
    start.setDate(now.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    startDate = start.toISOString().split("T")[0];
    endDate = end.toISOString().split("T")[0];
  } else {
    startDate = `${now.getFullYear()}-01-01`;
    endDate = `${now.getFullYear()}-12-31`;
  }

  const expenses = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.categoryId, budget.categoryId),
        eq(transactionsTable.type, "expense"),
        gte(transactionsTable.date, startDate),
        lte(transactionsTable.date, endDate)
      )
    );

  const spent = expenses.reduce((sum, tx) => sum + tx.amount, 0);
  const remaining = Math.max(0, budget.amount - spent);
  const percentage = budget.amount > 0 ? Math.min(100, (spent / budget.amount) * 100) : 0;

  const [cat] = await db
    .select()
    .from(categoriesTable)
    .where(eq(categoriesTable.id, budget.categoryId))
    .limit(1);

  return {
    ...budget,
    categoryName: cat?.name ?? "Unknown",
    spent,
    remaining,
    percentage,
    isOverBudget: spent > budget.amount,
    createdAt: budget.createdAt.toISOString(),
  };
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const budgets = await db.select().from(budgetsTable).where(eq(budgetsTable.userId, req.userId!));
    const withProgress = await Promise.all(budgets.map((b) => computeBudgetProgress(b, req.userId!)));
    res.json(withProgress);
  } catch (err) {
    logger.error({ err }, "List budgets error");
    res.status(500).json({ error: "Failed to fetch budgets" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, amount, period, categoryId } = req.body;
    if (!name || !amount || !period || !categoryId) {
      res.status(400).json({ error: "name, amount, period, categoryId required" });
      return;
    }
    const [budget] = await db
      .insert(budgetsTable)
      .values({ userId: req.userId!, name, amount: parseFloat(amount), period, categoryId: parseInt(categoryId) })
      .returning();

    res.status(201).json(await computeBudgetProgress(budget, req.userId!));
  } catch (err) {
    logger.error({ err }, "Create budget error");
    res.status(500).json({ error: "Failed to create budget" });
  }
});

router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, amount, period, categoryId } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name) updates.name = name;
    if (amount) updates.amount = parseFloat(amount);
    if (period) updates.period = period;
    if (categoryId) updates.categoryId = parseInt(categoryId);

    const [budget] = await db
      .update(budgetsTable)
      .set(updates)
      .where(and(eq(budgetsTable.id, id), eq(budgetsTable.userId, req.userId!)))
      .returning();

    if (!budget) {
      res.status(404).json({ error: "Budget not found" });
      return;
    }
    res.json(await computeBudgetProgress(budget, req.userId!));
  } catch (err) {
    logger.error({ err }, "Update budget error");
    res.status(500).json({ error: "Failed to update budget" });
  }
});

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(budgetsTable).where(and(eq(budgetsTable.id, id), eq(budgetsTable.userId, req.userId!)));
    res.json({ success: true, message: "Budget deleted" });
  } catch (err) {
    logger.error({ err }, "Delete budget error");
    res.status(500).json({ error: "Failed to delete budget" });
  }
});

export default router;
