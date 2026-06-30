import { Router } from "express";
import { db, transactionsTable, budgetsTable, goalsTable, categoriesTable } from "../db/index.js";
import { eq, and, desc, gte, lte } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/summary", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const lastMonth =
      now.getMonth() === 0
        ? `${now.getFullYear() - 1}-12`
        : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;

    const allTx = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, userId));
    const thisMo = allTx.filter((tx) => tx.date.startsWith(thisMonth));
    const lastMo = allTx.filter((tx) => tx.date.startsWith(lastMonth));

    const monthlyIncome = thisMo.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const monthlyExpenses = thisMo.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    const lastIncome = lastMo.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const lastExpenses = lastMo.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    const netBalance = monthlyIncome - monthlyExpenses;
    const savingsRate = monthlyIncome > 0 ? ((monthlyIncome - monthlyExpenses) / monthlyIncome) * 100 : 0;

    const budgets = await db.select().from(budgetsTable).where(eq(budgetsTable.userId, userId));
    const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, userId));
    const activeGoals = goals.filter((g) => !g.isCompleted).length;

    // Budget summary with spent
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const monthEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-31`;
    const budgetSummary = await Promise.all(
      budgets.map(async (b) => {
        const [cat] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, b.categoryId)).limit(1);
        const spent = allTx
          .filter((t) => t.type === "expense" && t.categoryId === b.categoryId && t.date >= monthStart && t.date <= monthEnd)
          .reduce((s, t) => s + t.amount, 0);
        return { budgetId: b.id, name: b.name, budget: b.amount, spent, categoryName: cat?.name };
      })
    );

    const goalsSummary = goals.map((g) => ({
      id: g.id,
      name: g.name,
      targetAmount: g.targetAmount,
      currentAmount: g.currentAmount,
      type: g.type,
    }));

    res.json({
      monthlyIncome,
      monthlyExpenses,
      netBalance,
      savingsRate,
      activeGoals,
      budgetSummary,
      goalsSummary,
      incomeChange: lastIncome > 0 ? ((monthlyIncome - lastIncome) / lastIncome) * 100 : 0,
      expenseChange: lastExpenses > 0 ? ((monthlyExpenses - lastExpenses) / lastExpenses) * 100 : 0,
    });
  } catch (err) {
    logger.error({ err }, "Dashboard summary error");
    res.status(500).json({ error: "Failed to fetch dashboard summary" });
  }
});

router.get("/recent-transactions", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const rows = await db
      .select({
        id: transactionsTable.id,
        userId: transactionsTable.userId,
        type: transactionsTable.type,
        amount: transactionsTable.amount,
        description: transactionsTable.description,
        date: transactionsTable.date,
        categoryId: transactionsTable.categoryId,
        categoryName: categoriesTable.name,
        categoryIcon: categoriesTable.icon,
        notes: transactionsTable.notes,
        createdAt: transactionsTable.createdAt,
      })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(eq(transactionsTable.userId, userId))
      .orderBy(desc(transactionsTable.date), desc(transactionsTable.createdAt))
      .limit(10);

    res.json(
      rows.map((r) => ({
        ...r,
        categoryName: r.categoryName ?? "Unknown",
        categoryIcon: r.categoryIcon ?? "circle",
        createdAt: r.createdAt.toISOString(),
      }))
    );
  } catch (err) {
    logger.error({ err }, "Recent transactions error");
    res.status(500).json({ error: "Failed to fetch recent transactions" });
  }
});

router.get("/cashflow", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
      const txs = await db.select().from(transactionsTable)
        .where(and(eq(transactionsTable.userId, userId), gte(transactionsTable.date, `${key}-01`), lte(transactionsTable.date, `${key}-31`)));
      months.push({
        month: label,
        income: txs.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0),
        expenses: txs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0),
      });
    }
    res.json(months);
  } catch (err) {
    logger.error({ err }, "Cashflow error");
    res.status(500).json({ error: "Failed to fetch cashflow" });
  }
});

export default router;
