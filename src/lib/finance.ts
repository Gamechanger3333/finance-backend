import prisma from "../db/index.js";

export type Period = "daily" | "weekly" | "monthly" | "yearly";

/**
 * Advances a YYYY-MM-DD date string by one period of the given frequency.
 * Used to roll a recurring bill's due date forward once it's been paid.
 */
export function advanceDate(dateStr: string, frequency: "weekly" | "monthly" | "yearly"): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (frequency === "weekly") date.setDate(date.getDate() + 7);
  else if (frequency === "yearly") date.setFullYear(date.getFullYear() + 1);
  else date.setMonth(date.getMonth() + 1); // monthly (default)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Logs a paid recurring bill as an expense transaction and rolls its
 * nextDueDate forward. Shared by the manual "Mark Paid" button and the
 * daily auto-pay cron job below, so both paths behave identically.
 */
export async function logRecurringBillPayment(bill: {
  id: number;
  userId: number;
  name: string;
  amount: number;
  categoryId: number | null;
  nextDueDate: string;
  frequency: string;
}) {
  let categoryId = bill.categoryId;
  if (!categoryId) {
    const fallback = await prisma.category.findFirst({ where: { isDefault: true, type: "expense" }, select: { id: true } });
    categoryId = fallback?.id ?? null;
  }
  if (!categoryId) return null; // nothing sensible to file it under — skip

  const today = new Date().toISOString().slice(0, 10);
  const [transaction, updatedBill] = await prisma.$transaction([
    prisma.transaction.create({
      data: {
        userId: bill.userId,
        type: "expense",
        amount: bill.amount,
        description: `${bill.name} (recurring)`,
        date: today,
        categoryId,
      },
    }),
    prisma.recurringBill.update({
      where: { id: bill.id },
      data: { nextDueDate: advanceDate(bill.nextDueDate, bill.frequency as "weekly" | "monthly" | "yearly"), lastNotifiedDueDate: null },
      include: { category: { select: { name: true, icon: true } } },
    }),
  ]);

  return { transaction, bill: updatedBill };
}

/**
 * Daily auto-pay sweep: for every active recurring bill whose nextDueDate
 * has arrived (today or earlier), automatically logs the expense and rolls
 * the due date forward — this is what actually makes recurring transactions
 * "auto-created on schedule" rather than requiring a manual click every
 * time. A user who wants to review a bill before it posts should mark it
 * inactive and log it manually instead.
 */
export async function runRecurringBillAutoPay(): Promise<{ processed: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const dueBills = await prisma.recurringBill.findMany({
    where: { isActive: true, nextDueDate: { lte: today } },
  });

  let processed = 0;
  for (const bill of dueBills) {
    try {
      const result = await logRecurringBillPayment(bill as any);
      if (result) {
        await prisma.notification.create({
          data: {
            userId: bill.userId,
            title: `${bill.name} auto-paid`,
            message: `$${bill.amount.toFixed(2)} was automatically logged as an expense.`,
            type: "info",
          },
        });
        processed++;
      }
    } catch {
      // Skip this bill on error; the rest of the sweep should still run.
    }
  }
  return { processed };
}

/**
 * Whole-day difference between a YYYY-MM-DD date and today (negative = overdue).
 */
export function daysUntil(dateStr: string, now: Date = new Date()): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Lazily checks a user's active recurring bills for anything due within 3
 * days (or already overdue) and creates a notification the first time we
 * notice — tracked via lastNotifiedDueDate so it doesn't fire again for the
 * same due date. Runs on read (bills list / dashboard load) rather than a
 * background cron, which is a deliberate trade-off for this app's current
 * scale; a scheduled job would be the right move once this runs for real
 * users at volume.
 */
export async function checkAndNotifyDueBills(userId: number): Promise<void> {
  const bills = await prisma.recurringBill.findMany({ where: { userId, isActive: true } });
  for (const bill of bills) {
    const days = daysUntil(bill.nextDueDate);
    if (days > 3) continue;
    if (bill.lastNotifiedDueDate === bill.nextDueDate) continue;

    const title =
      days < 0
        ? `${bill.name} is overdue`
        : days === 0
        ? `${bill.name} is due today`
        : `${bill.name} is due in ${days} day${days === 1 ? "" : "s"}`;

    await prisma.notification.create({
      data: {
        userId,
        title,
        message: `$${bill.amount.toFixed(2)} · ${bill.frequency} bill`,
        type: days < 0 ? "warning" : "info",
      },
    });
    await prisma.recurringBill.update({
      where: { id: bill.id },
      data: { lastNotifiedDueDate: bill.nextDueDate },
    });
  }
}

/**
 * Sums every transaction the user has ever recorded (income positive,
 * expense negative). Used as the forecast's starting balance when the user
 * hasn't set an explicit currentBalance in Settings — an estimate, not a
 * bank-verified figure, since we have no bank connection.
 */
export async function getNetBalanceToDate(userId: number): Promise<number> {
  const rows = await prisma.transaction.groupBy({
    by: ["type"],
    where: { userId },
    _sum: { amount: true },
  });
  let income = 0, expenses = 0;
  for (const row of rows) {
    if (row.type === "income") income = row._sum.amount ?? 0;
    else if (row.type === "expense") expenses = row._sum.amount ?? 0;
  }
  return income - expenses;
}

export interface ForecastDay {
  date: string;
  balance: number;
  income: number;
  expenses: number;
  events: { name: string; amount: number }[];
}

export interface CashflowForecast {
  startingBalance: number;
  startingBalanceIsEstimate: boolean;
  days: ForecastDay[];
  lowestPoint: { date: string; balance: number };
  overdraftDate: string | null;
}

/**
 * Projects daily account balance forward `days` days from today.
 *
 * Two ingredients:
 *  1. Known future events — each active recurring bill's upcoming due
 *     dates within the window, rolled forward with advanceDate.
 *  2. A "background drift" — the average daily income and average daily
 *     *discretionary* (non-bill) expense observed over the trailing 90
 *     days, applied to every day. Discretionary expense is total expense
 *     minus the portion attributable to recurring bills over that same
 *     window, so bills aren't double-counted (once as background average,
 *     once as a discrete event).
 *
 * This is a heuristic, not a bank-grade forecast — there's no transaction
 * feed to learn from beyond what the user has logged.
 */
export async function getCashflowForecast(userId: number, days = 30): Promise<CashflowForecast> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { currentBalance: true } });
  const startingBalanceIsEstimate = user?.currentBalance == null;
  const startingBalance = user?.currentBalance ?? (await getNetBalanceToDate(userId));

  const lookbackDays = 90;
  const now = new Date();
  const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - lookbackDays);
  const earliestStr = `${earliest.getFullYear()}-${String(earliest.getMonth() + 1).padStart(2, "0")}-${String(earliest.getDate()).padStart(2, "0")}`;

  const [recentTx, bills] = await Promise.all([
    prisma.transaction.findMany({ where: { userId, date: { gte: earliestStr } }, select: { type: true, amount: true } }),
    prisma.recurringBill.findMany({ where: { userId, isActive: true } }),
  ]);

  let totalIncome90 = 0, totalExpense90 = 0;
  for (const tx of recentTx) {
    if (tx.type === "income") totalIncome90 += tx.amount;
    else if (tx.type === "expense") totalExpense90 += tx.amount;
  }

  // Estimate how much of the last 90 days' expenses came from bills we
  // already track, so we don't double-count them in the daily average.
  const occurrencesPer90Days = (frequency: string) => {
    if (frequency === "weekly") return lookbackDays / 7;
    if (frequency === "yearly") return lookbackDays / 365;
    return lookbackDays / 30; // monthly (default)
  };
  const billDriven90 = bills.reduce((sum: number, b: any) => sum + b.amount * occurrencesPer90Days(b.frequency), 0);
  const discretionaryExpense90 = Math.max(0, totalExpense90 - billDriven90);

  const avgDailyIncome = totalIncome90 / lookbackDays;
  const avgDailyDiscretionaryExpense = discretionaryExpense90 / lookbackDays;

  // Project each active bill's occurrences within the window, advancing
  // nextDueDate forward as many times as needed.
  const billEventsByDate = new Map<string, { name: string; amount: number }[]>();
  const windowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  for (const bill of bills) {
    let occurDate = bill.nextDueDate;
    let guard = 0;
    while (guard < 500) {
      guard++;
      const [y, m, d] = occurDate.split("-").map(Number);
      const occurAsDate = new Date(y, m - 1, d);
      if (occurAsDate > windowEnd) break;
      if (occurAsDate >= new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        const list = billEventsByDate.get(occurDate) ?? [];
        list.push({ name: bill.name, amount: bill.amount });
        billEventsByDate.set(occurDate, list);
      }
      occurDate = advanceDate(occurDate, bill.frequency as "weekly" | "monthly" | "yearly");
    }
  }

  const forecastDays: ForecastDay[] = [];
  let runningBalance = startingBalance;
  let lowestPoint = { date: "", balance: startingBalance };
  let overdraftDate: string | null = null;

  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const events = billEventsByDate.get(dateStr) ?? [];
    const eventTotal = events.reduce((s, e) => s + e.amount, 0);

    const dayIncome = avgDailyIncome;
    const dayExpenses = avgDailyDiscretionaryExpense + eventTotal;
    runningBalance += dayIncome - dayExpenses;

    if (i === 0 || runningBalance < lowestPoint.balance) {
      lowestPoint = { date: dateStr, balance: runningBalance };
    }
    if (overdraftDate === null && runningBalance < 0) {
      overdraftDate = dateStr;
    }

    forecastDays.push({ date: dateStr, balance: runningBalance, income: dayIncome, expenses: dayExpenses, events });
  }

  return { startingBalance, startingBalanceIsEstimate, days: forecastDays, lowestPoint, overdraftDate };
}

/**
 * Lazily checks the user's cash-flow forecast for a projected overdraft
 * within the next 14 days and creates a one-time warning notification —
 * same lazy-on-read pattern as checkAndNotifyDueBills, deduped by checking
 * for an existing unread warning for the same projected date.
 */
export async function checkAndNotifyOverdraftRisk(userId: number): Promise<void> {
  const forecast = await getCashflowForecast(userId, 14);
  if (!forecast.overdraftDate) return;

  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type: "warning",
      title: "Projected overdraft risk",
      message: { contains: forecast.overdraftDate },
    },
  });
  if (existing) return;

  await prisma.notification.create({
    data: {
      userId,
      title: "Projected overdraft risk",
      message: `Based on your recent spending and upcoming bills, your balance may go negative around ${forecast.overdraftDate}.`,
      type: "warning",
    },
  });
}

/**
 * Lazily checks every active budget's current-period spend against its
 * limit and creates a one-time "Budget exceeded" notification per budget
 * per period — same on-read pattern as the other checks, deduped by
 * looking for an existing notification created since the period started.
 */
export async function checkAndNotifyBudgetOverspend(userId: number): Promise<void> {
  const budgets = await prisma.budget.findMany({ where: { userId } });
  if (budgets.length === 0) return;

  const byPeriod = new Map<string, typeof budgets>();
  for (const b of budgets) {
    const list = byPeriod.get(b.period) ?? [];
    list.push(b);
    byPeriod.set(b.period, list);
  }

  for (const [period, group] of byPeriod) {
    const { startDate } = getPeriodRange(period);
    const ids = group.map((b: any) => b.categoryId);
    const spendMap = await getExpenseSpendByCategory(userId, ids, startDate, getPeriodRange(period).endDate);

    for (const b of group as any[]) {
      const spent = spendMap.get(b.categoryId) ?? 0;
      if (spent <= b.amount) continue;

      const existing = await prisma.notification.findFirst({
        where: { userId, type: "warning", title: `Budget exceeded: ${b.name}`, createdAt: { gte: new Date(`${startDate}T00:00:00`) } },
      });
      if (existing) continue;

      await prisma.notification.create({
        data: {
          userId,
          title: `Budget exceeded: ${b.name}`,
          message: `You've spent $${spent.toFixed(2)} of your $${b.amount.toFixed(2)} "${b.name}" budget this ${period} period.`,
          type: "warning",
        },
      });
    }
  }
}

const GOAL_MILESTONES = [25, 50, 75, 100];

/**
 * Fires a one-time notification the moment a goal's progress crosses each
 * 25/50/75/100% threshold. Called from every code path that changes a
 * goal's currentAmount (manual edits and automated savings-rule
 * contributions alike), passing the amount before the change so we can
 * detect the crossing rather than re-firing on every update.
 */
export async function checkGoalMilestones(
  userId: number,
  goal: { id: number; name: string; targetAmount: number; currentAmount: number },
  previousAmount: number
): Promise<void> {
  if (goal.targetAmount <= 0) return;
  const prevPct = (previousAmount / goal.targetAmount) * 100;
  const newPct = (goal.currentAmount / goal.targetAmount) * 100;

  for (const milestone of GOAL_MILESTONES) {
    if (prevPct < milestone && newPct >= milestone) {
      const isComplete = milestone === 100;
      await prisma.notification.create({
        data: {
          userId,
          title: isComplete ? `Goal reached: ${goal.name} 🎉` : `${milestone}% milestone: ${goal.name}`,
          message: isComplete
            ? `You've hit your target of $${goal.targetAmount.toFixed(2)} for "${goal.name}"!`
            : `"${goal.name}" is now ${milestone}% funded — $${goal.currentAmount.toFixed(2)} of $${goal.targetAmount.toFixed(2)}.`,
          type: isComplete ? "success" : "info",
        },
      });
    }
  }
}

export function getPeriodRange(period: string, now: Date = new Date()): { startDate: string; endDate: string } {
  if (period === "weekly") {
    const day = now.getDay();
    const start = new Date(now);
    start.setDate(now.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { startDate: start.toISOString().split("T")[0], endDate: end.toISOString().split("T")[0] };
  }
  if (period === "yearly") {
    return { startDate: `${now.getFullYear()}-01-01`, endDate: `${now.getFullYear()}-12-31` };
  }
  if (period === "daily") {
    const d = now.toISOString().split("T")[0];
    return { startDate: d, endDate: d };
  }
  // monthly (default)
  const y = now.getFullYear();
  const m = now.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  return {
    startDate: `${y}-${String(m + 1).padStart(2, "0")}-01`,
    endDate: `${y}-${String(m + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * Returns total expense spend per categoryId within a date range.
 * Uses Prisma groupBy — single query regardless of how many categories.
 */
export async function getExpenseSpendByCategory(
  userId: number,
  categoryIds: number[],
  startDate: string,
  endDate: string
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (categoryIds.length === 0) return result;

  const rows = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: {
      userId,
      type: "expense",
      categoryId: { in: categoryIds },
      date: { gte: startDate, lte: endDate },
    },
    _sum: { amount: true },
  });

  for (const row of rows) {
    result.set(row.categoryId, row._sum.amount ?? 0);
  }
  return result;
}

/**
 * Returns a rolling 12-month cashflow in a single grouped query.
 */
export async function getMonthlyCashflow(
  userId: number,
  monthsBack = 12
): Promise<{ month: string; income: number; expenses: number }[]> {
  const now = new Date();
  const earliest = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1);
  const earliestStr = earliest.toISOString().split("T")[0];

  const transactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: earliestStr } },
    select: { date: true, type: true, amount: true },
  });

  const byMonth = new Map<string, { income: number; expenses: number }>();
  for (const tx of transactions) {
    const key = tx.date.substring(0, 7); // YYYY-MM
    const entry = byMonth.get(key) ?? { income: 0, expenses: 0 };
    if (tx.type === "income") entry.income += tx.amount;
    else if (tx.type === "expense") entry.expenses += tx.amount;
    byMonth.set(key, entry);
  }

  const months: { month: string; income: number; expenses: number }[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
    const entry = byMonth.get(key) ?? { income: 0, expenses: 0 };
    months.push({ month: label, ...entry });
  }
  return months;
}
