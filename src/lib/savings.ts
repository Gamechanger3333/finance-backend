import prisma from "../db/index.js";
import { advanceDate, checkGoalMilestones } from "./finance.js";

/**
 * Round-up rule: whenever the user logs an expense, rounds it up to the
 * nearest `roundUpTo` and sweeps the difference into the linked goal. This
 * is a notional transfer (spare change from money already spent), not a
 * new transaction — it doesn't affect the expense totals, just the goal.
 */
export interface AppliedContribution {
  ruleName: string;
  amount: number;
}

export async function applyRoundUpRules(userId: number, expenseAmount: number): Promise<AppliedContribution[]> {
  const rules = await prisma.savingsRule.findMany({
    where: { userId, type: "round_up", isActive: true },
  });
  const applied: AppliedContribution[] = [];
  for (const rule of rules) {
    const roundUpTo = rule.roundUpTo ?? 1;
    if (roundUpTo <= 0) continue;
    const roundedUp = Math.ceil(expenseAmount / roundUpTo) * roundUpTo;
    const delta = Math.round((roundedUp - expenseAmount) * 100) / 100;
    if (delta <= 0) continue;

    const goalBefore = await prisma.goal.findUnique({ where: { id: rule.goalId } });
    if (!goalBefore) continue;

    const [, , , updatedGoal] = await prisma.$transaction([
      prisma.goal.update({ where: { id: rule.goalId }, data: { currentAmount: { increment: delta } } }),
      prisma.savingsRule.update({ where: { id: rule.id }, data: { totalSaved: { increment: delta } } }),
      prisma.savingsContribution.create({
        data: { userId, savingsRuleId: rule.id, amount: delta, note: "Round-up from a purchase" },
      }),
      prisma.goal.findUnique({ where: { id: rule.goalId } }),
    ]);
    applied.push({ ruleName: rule.name, amount: delta });
    if (updatedGoal) await checkGoalMilestones(userId, updatedGoal, goalBefore.currentAmount);
  }
  return applied;
}

/**
 * Percent-of-income rule: whenever the user logs income, notionally sets
 * aside a percentage of it into the linked goal — same "doesn't touch the
 * ledger, just earmarks progress" treatment as round-up.
 */
export async function applyIncomeRules(userId: number, incomeAmount: number): Promise<AppliedContribution[]> {
  const rules = await prisma.savingsRule.findMany({
    where: { userId, type: "percent_of_income", isActive: true },
  });
  const applied: AppliedContribution[] = [];
  for (const rule of rules) {
    const pct = rule.percentage ?? 0;
    if (pct <= 0) continue;
    const delta = Math.round(incomeAmount * (pct / 100) * 100) / 100;
    if (delta <= 0) continue;

    const goalBefore = await prisma.goal.findUnique({ where: { id: rule.goalId } });
    if (!goalBefore) continue;

    const [, , , updatedGoal] = await prisma.$transaction([
      prisma.goal.update({ where: { id: rule.goalId }, data: { currentAmount: { increment: delta } } }),
      prisma.savingsRule.update({ where: { id: rule.id }, data: { totalSaved: { increment: delta } } }),
      prisma.savingsContribution.create({
        data: { userId, savingsRuleId: rule.id, amount: delta, note: `${pct}% of income auto-saved` },
      }),
      prisma.goal.findUnique({ where: { id: rule.goalId } }),
    ]);
    applied.push({ ruleName: rule.name, amount: delta });
    if (updatedGoal) await checkGoalMilestones(userId, updatedGoal, goalBefore.currentAmount);
  }
  return applied;
}

/**
 * Fixed-recurring rule: an actual scheduled transfer, like a bill you pay
 * to yourself. Unlike round-up/percent-of-income, this books a real
 * expense transaction (so cash-flow forecasts and budgets see it as a
 * committed outflow) while crediting the linked goal the same amount.
 * Lazy on-read pattern, same as recurring bill due-checks.
 */
export async function runDueFixedSavingsRules(userId: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const rules = await prisma.savingsRule.findMany({
    where: { userId, type: "fixed_recurring", isActive: true, nextRunDate: { lte: today } },
  });
  if (rules.length === 0) return;

  const fallbackCategory = await prisma.category.findFirst({
    where: { isDefault: true, type: "expense" },
    select: { id: true },
  });
  if (!fallbackCategory) return;

  for (const rule of rules) {
    const amount = rule.fixedAmount ?? 0;
    if (amount <= 0 || !rule.frequency) continue;

    const goalBefore = await prisma.goal.findUnique({ where: { id: rule.goalId } });
    if (!goalBefore) continue;

    const [, updatedGoal] = await prisma.$transaction([
      prisma.transaction.create({
        data: {
          userId,
          type: "expense",
          amount,
          description: `Auto-save: ${rule.name}`,
          date: today,
          categoryId: fallbackCategory.id,
        },
      }),
      prisma.goal.update({ where: { id: rule.goalId }, data: { currentAmount: { increment: amount } } }),
      prisma.savingsRule.update({
        where: { id: rule.id },
        data: {
          totalSaved: { increment: amount },
          nextRunDate: advanceDate(rule.nextRunDate as string, rule.frequency as "weekly" | "monthly" | "yearly"),
        },
      }),
      prisma.savingsContribution.create({
        data: { userId, savingsRuleId: rule.id, amount, note: `Scheduled ${rule.frequency} auto-save` },
      }),
      prisma.notification.create({
        data: {
          userId,
          title: "Auto-save complete",
          message: `$${amount.toFixed(2)} moved into your "${rule.name}" savings rule.`,
          type: "info",
        },
      }),
    ]);
    if (updatedGoal) await checkGoalMilestones(userId, updatedGoal, goalBefore.currentAmount);
  }
}
