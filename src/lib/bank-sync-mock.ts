/**
 * Demo-mode bank sync.
 *
 * A real integration would use the `plaid` SDK: create a Link token,
 * exchange the public token from Plaid Link for an access token, then call
 * /transactions/sync on a schedule. This sandbox has no network route to
 * Plaid's API and no PLAID_CLIENT_ID/PLAID_SECRET configured, so this
 * module simulates that same shape — a "connect" step that links a mock
 * institution/account, and a "sync" step that returns a batch of
 * realistic-looking transactions — so the rest of the app (and a future
 * real Plaid integration) can plug into the exact same route contract.
 */

export const MOCK_INSTITUTIONS = [
  { name: "Chase", accountNames: ["Total Checking", "Freedom Credit Card"] },
  { name: "Bank of America", accountNames: ["Advantage Checking", "Customized Cash Rewards"] },
  { name: "Wells Fargo", accountNames: ["Everyday Checking", "Active Cash Card"] },
  { name: "Capital One", accountNames: ["360 Checking", "Quicksilver Card"] },
];

const MOCK_MERCHANTS: { merchant: string; categoryName: string; type: "income" | "expense"; min: number; max: number }[] = [
  { merchant: "Starbucks", categoryName: "Food & Dining", type: "expense", min: 4, max: 12 },
  { merchant: "Whole Foods Market", categoryName: "Food & Dining", type: "expense", min: 20, max: 110 },
  { merchant: "Uber", categoryName: "Transport", type: "expense", min: 8, max: 35 },
  { merchant: "Shell Gas Station", categoryName: "Transport", type: "expense", min: 25, max: 65 },
  { merchant: "Amazon", categoryName: "Shopping", type: "expense", min: 12, max: 150 },
  { merchant: "Target", categoryName: "Shopping", type: "expense", min: 15, max: 90 },
  { merchant: "Netflix", categoryName: "Entertainment", type: "expense", min: 15.49, max: 15.49 },
  { merchant: "AMC Theatres", categoryName: "Entertainment", type: "expense", min: 12, max: 40 },
  { merchant: "PG&E", categoryName: "Bills & Utilities", type: "expense", min: 60, max: 180 },
  { merchant: "Comcast", categoryName: "Bills & Utilities", type: "expense", min: 70, max: 90 },
  { merchant: "CVS Pharmacy", categoryName: "Healthcare", type: "expense", min: 10, max: 60 },
  { merchant: "Direct Deposit — Employer", categoryName: "Salary", type: "income", min: 1800, max: 3200 },
];

function randomBetween(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function randomPastDate(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(Math.random() * daysBack));
  return d.toISOString().slice(0, 10);
}

export function pickMockAccount(institutionName: string): { accountName: string; accountMask: string } {
  const inst = MOCK_INSTITUTIONS.find((i) => i.name === institutionName) ?? MOCK_INSTITUTIONS[0];
  const accountName = inst.accountNames[Math.floor(Math.random() * inst.accountNames.length)];
  const accountMask = String(1000 + Math.floor(Math.random() * 9000));
  return { accountName, accountMask };
}

export interface MockSyncedTransaction {
  externalId: string;
  type: "income" | "expense";
  amount: number;
  description: string;
  date: string;
  categoryName: string;
}

/**
 * Generates a batch of 4-10 plausible transactions from the mock merchant
 * list, as if they'd just posted to the linked account since the last sync.
 */
export function generateMockTransactions(connectionId: number): MockSyncedTransaction[] {
  const count = 4 + Math.floor(Math.random() * 7);
  const transactions: MockSyncedTransaction[] = [];
  for (let i = 0; i < count; i++) {
    const m = MOCK_MERCHANTS[Math.floor(Math.random() * MOCK_MERCHANTS.length)];
    transactions.push({
      externalId: `mock_${connectionId}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: m.type,
      amount: randomBetween(m.min, m.max),
      description: m.merchant,
      date: randomPastDate(m.type === "income" ? 14 : 10),
      categoryName: m.categoryName,
    });
  }
  return transactions;
}
