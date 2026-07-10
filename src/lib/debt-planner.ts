export interface DebtInput {
  id: number;
  name: string;
  balance: number;
  interestRate: number; // APR, percent
  minimumPayment: number;
}

export type PayoffStrategy = "snowball" | "avalanche";

export interface PayoffOrderEntry {
  id: number;
  name: string;
  payoffMonth: number;
}

export interface MonthlySnapshot {
  month: number;
  totalBalance: number;
}

export interface PayoffPlan {
  strategy: PayoffStrategy;
  months: number;
  debtFreeDate: string;
  totalInterestPaid: number;
  totalPaid: number;
  payoffOrder: PayoffOrderEntry[];
  monthlySnapshots: MonthlySnapshot[];
  neverPaysOff: boolean;
  monthlyBudget: number;
}

const MAX_MONTHS = 600; // 50-year safety cap

/**
 * Simulates a debt payoff strategy month by month.
 *
 * Both snowball (smallest balance first) and avalanche (highest interest
 * rate first) work the same way mechanically: pay the minimum on every
 * debt, then throw whatever's left of the fixed monthly budget — starting
 * minimums plus any extra the user commits, plus minimums freed up as
 * debts get paid off — at whichever debt is "next" per the strategy's
 * ordering. The strategies only differ in that ordering.
 */
export function calculatePayoffPlan(
  debtsInput: DebtInput[],
  extraMonthly: number,
  strategy: PayoffStrategy
): PayoffPlan {
  const debts = debtsInput
    .filter((d) => d.balance > 0)
    .map((d) => ({ ...d, balance: d.balance }));

  const monthlyBudget = debts.reduce((s, d) => s + d.minimumPayment, 0) + Math.max(0, extraMonthly);

  const payoffOrder: PayoffOrderEntry[] = [];
  const monthlySnapshots: MonthlySnapshot[] = [];
  let totalInterestPaid = 0;
  let month = 0;

  const sortForExtra = (active: typeof debts) => {
    if (strategy === "snowball") {
      return [...active].sort((a, b) => a.balance - b.balance);
    }
    return [...active].sort((a, b) => b.interestRate - a.interestRate || a.balance - b.balance);
  };

  if (debts.length === 0 || monthlyBudget <= 0) {
    return {
      strategy,
      months: 0,
      debtFreeDate: new Date().toISOString().slice(0, 10),
      totalInterestPaid: 0,
      totalPaid: 0,
      payoffOrder: [],
      monthlySnapshots: [],
      neverPaysOff: debts.length > 0,
      monthlyBudget,
    };
  }

  while (debts.some((d) => d.balance > 0.01) && month < MAX_MONTHS) {
    month++;

    // Accrue a month's interest on every active balance.
    for (const d of debts) {
      if (d.balance <= 0) continue;
      const interest = d.balance * (d.interestRate / 100 / 12);
      d.balance += interest;
      totalInterestPaid += interest;
    }

    let remainingBudget = monthlyBudget;

    // Pay the minimum on every active debt first.
    for (const d of debts) {
      if (d.balance <= 0) continue;
      const pay = Math.min(d.minimumPayment, d.balance, remainingBudget);
      d.balance -= pay;
      remainingBudget -= pay;
    }

    // Throw whatever's left at the priority debt(s), per strategy.
    const active = debts.filter((d) => d.balance > 0.01);
    for (const d of sortForExtra(active)) {
      if (remainingBudget <= 0) break;
      const pay = Math.min(remainingBudget, d.balance);
      d.balance -= pay;
      remainingBudget -= pay;
    }

    // Record anything that just crossed off.
    for (const d of debts) {
      if (d.balance <= 0.01 && !payoffOrder.some((p) => p.id === d.id)) {
        payoffOrder.push({ id: d.id, name: d.name, payoffMonth: month });
      }
    }

    monthlySnapshots.push({ month, totalBalance: Math.max(0, debts.reduce((s, d) => s + Math.max(0, d.balance), 0)) });
  }

  const neverPaysOff = month >= MAX_MONTHS && debts.some((d) => d.balance > 0.01);
  const debtFreeDateObj = new Date();
  debtFreeDateObj.setMonth(debtFreeDateObj.getMonth() + month);
  const debtFreeDate = debtFreeDateObj.toISOString().slice(0, 10);

  const originalTotalBalance = debtsInput.reduce((s, d) => s + d.balance, 0);

  return {
    strategy,
    months: month,
    debtFreeDate,
    totalInterestPaid,
    totalPaid: originalTotalBalance + totalInterestPaid,
    payoffOrder,
    monthlySnapshots,
    neverPaysOff,
    monthlyBudget,
  };
}
