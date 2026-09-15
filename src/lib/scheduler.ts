import prisma from "../db/index.js";
import { logger } from "./logger.js";
import {
  checkAndNotifyDueBills,
  checkAndNotifyOverdraftRisk,
  checkAndNotifyBudgetOverspend,
  runRecurringBillAutoPay,
} from "./finance.js";
import { runDueFixedSavingsRules } from "./savings.js";

/**
 * Runs the four "lazy" per-user notification checks (due bills, overdraft
 * risk, fixed savings-rule contributions, budget overspend) for every
 * user, once. These used to run inline on every single GET
 * /dashboard/summary request — meaning a user opening their dashboard
 * twice in a minute paid for two full notification sweeps (each doing
 * their own DB queries, one of them recomputing the cash-flow forecast a
 * second time on top of the dashboard's own forecast call) for no benefit,
 * since the checks are idempotent and only need to run once per day.
 *
 * Moving them here, behind the same daily cron as the recurring-bill
 * auto-pay sweep, means the dashboard route now does exactly one cash-flow
 * forecast computation per request instead of two, and users don't pay a
 * notification-sweep cost on every page view.
 */
export async function runDailyUserChecks(): Promise<{ usersChecked: number }> {
  const users = await prisma.user.findMany({ select: { id: true } });

  let usersChecked = 0;
  for (const { id: userId } of users) {
    try {
      await Promise.all([
        checkAndNotifyDueBills(userId),
        checkAndNotifyOverdraftRisk(userId),
        runDueFixedSavingsRules(userId),
        checkAndNotifyBudgetOverspend(userId),
      ]);
      usersChecked++;
    } catch (err) {
      logger.warn({ err, userId }, "Daily user check failed for one user — continuing sweep");
    }
  }
  return { usersChecked };
}

/**
 * Runs the full daily maintenance sweep: recurring-bill auto-pay followed
 * by the per-user notification checks. Called on a cron schedule and once
 * at server startup (see index.ts).
 */
export async function runDailyMaintenanceSweep(): Promise<void> {
  const { processed } = await runRecurringBillAutoPay();
  const { usersChecked } = await runDailyUserChecks();
  logger.info({ billsAutoPaid: processed, usersChecked }, "Daily maintenance sweep completed");
}
