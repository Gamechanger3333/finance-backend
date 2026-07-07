import { Router } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { getPeriodRange, getExpenseSpendByCategory, getMonthlyCashflow, checkAndNotifyDueBills, daysUntil } from "../lib/finance.js";

const router = Router();

async function getMonthTotals(userId: number, monthPrefix: string) {
  const rows = await prisma.transaction.groupBy({
    by: ["type"],
    where: { userId, date: { startsWith: monthPrefix } },
    _sum: { amount: true },
  });
  let income = 0, expenses = 0;
  for (const row of rows) {
    if (row.type === "income") income = row._sum.amount ?? 0;
    else if (row.type === "expense") expenses = row._sum.amount ?? 0;
  }
  return { income, expenses };
}

router.get("/summary", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;

    // Fire off any due/overdue bill reminders (creates Notification rows) —
    // this is our lazy substitute for a background cron.
    await checkAndNotifyDueBills(userId);

    const [{ income: monthlyIncome, expenses: monthlyExpenses }, { income: lastIncome, expenses: lastExpenses }] =
      await Promise.all([getMonthTotals(userId, thisMonth), getMonthTotals(userId, lastMonth)]);

    const [budgets, goals, upcomingBillsRaw] = await Promise.all([
      prisma.budget.findMany({ where: { userId }, include: { category: { select: { name: true } } } }),
      prisma.goal.findMany({ where: { userId } }),
      prisma.recurringBill.findMany({ where: { userId, isActive: true }, orderBy: { nextDueDate: "asc" }, take: 5 }),
    ]);

    const activeGoals = goals.filter((g: any) => !g.isCompleted).length;

    let budgetSummary: any[] = [];
    if (budgets.length > 0) {
      const { startDate, endDate } = getPeriodRange("monthly", now);
      const categoryIds = budgets.map((b: any) => b.categoryId);
      const spendByCategory = await getExpenseSpendByCategory(userId, categoryIds, startDate, endDate);
      budgetSummary = budgets.map((b: any) => ({
        budgetId: b.id,
        name: b.name,
        budget: b.amount,
        spent: spendByCategory.get(b.categoryId) ?? 0,
        categoryName: b.category?.name,
      }));
    }

    const goalsSummary = goals.map((g: any) => ({
      id: g.id,
      name: g.name,
      targetAmount: g.targetAmount,
      currentAmount: g.currentAmount,
      type: g.type,
    }));

    const upcomingBills = upcomingBillsRaw.map((b: any) => ({
      id: b.id,
      name: b.name,
      amount: b.amount,
      frequency: b.frequency,
      nextDueDate: b.nextDueDate,
      daysUntilDue: daysUntil(b.nextDueDate),
    }));

    res.json({
      monthlyIncome,
      monthlyExpenses,
      netBalance: monthlyIncome - monthlyExpenses,
      savingsRate: monthlyIncome > 0 ? ((monthlyIncome - monthlyExpenses) / monthlyIncome) * 100 : 0,
      activeGoals,
      budgetSummary,
      goalsSummary,
      upcomingBills,
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
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.userId! },
      include: { category: { select: { name: true, icon: true } } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 10,
    });

    res.json(transactions.map((t: any) => ({
      ...t,
      categoryName: t.category?.name ?? "Unknown",
      categoryIcon: t.category?.icon ?? "circle",
      createdAt: t.createdAt.toISOString(),
    })));
  } catch (err) {
    logger.error({ err }, "Recent transactions error");
    res.status(500).json({ error: "Failed to fetch recent transactions" });
  }
});

router.get("/cashflow", requireAuth, async (req: AuthRequest, res) => {
  try {
    const months = await getMonthlyCashflow(req.userId!, 12);
    res.json(months);
  } catch (err) {
    logger.error({ err }, "Cashflow error");
    res.status(500).json({ error: "Failed to fetch cashflow" });
  }
});

export default router;
