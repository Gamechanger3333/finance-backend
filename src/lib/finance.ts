import prisma from "../db/index.js";

export type Period = "daily" | "weekly" | "monthly" | "yearly";

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
