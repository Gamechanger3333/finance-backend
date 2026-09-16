import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const DEFAULT_CATEGORIES = [
  { name: "Salary", icon: "briefcase", type: "income", color: "#10b981" },
  { name: "Freelance", icon: "laptop", type: "income", color: "#3b82f6" },
  { name: "Investment", icon: "trending-up", type: "income", color: "#8b5cf6" },
  { name: "Other Income", icon: "plus-circle", type: "income", color: "#06b6d4" },
  { name: "Food & Dining", icon: "utensils", type: "expense", color: "#f59e0b" },
  { name: "Transport", icon: "car", type: "expense", color: "#ef4444" },
  { name: "Shopping", icon: "shopping-bag", type: "expense", color: "#ec4899" },
  { name: "Entertainment", icon: "film", type: "expense", color: "#f97316" },
  { name: "Bills & Utilities", icon: "zap", type: "expense", color: "#6366f1" },
  { name: "Healthcare", icon: "heart", type: "expense", color: "#14b8a6" },
  { name: "Education", icon: "book", type: "expense", color: "#84cc16" },
  { name: "Savings", icon: "piggy-bank", type: "expense", color: "#10b981" },
  { name: "Other", icon: "circle", type: "expense", color: "#6b7280" },
];

async function main() {
  console.log("Seeding database...");

  // Seed default categories
  for (const cat of DEFAULT_CATEGORIES) {
    await prisma.category.upsert({
      where: { id: (await prisma.category.findFirst({ where: { name: cat.name, isDefault: true } }))?.id ?? 0 },
      update: {},
      create: { ...cat, isDefault: true },
    });
  }
  console.log("✓ Categories seeded");

  // Seed demo user
  const hash = await bcrypt.hash("Demo@1234", 12);
  let demoUser = await prisma.user.findUnique({ where: { email: "demo@finflow.com" } });
  if (!demoUser) {
    demoUser = await prisma.user.create({
      data: {
        name: "Demo User",
        email: "demo@finflow.com",
        passwordHash: hash,
        userType: "individual",
        currency: "USD",
        financialHealthScore: 72,
        emailVerified: true,
      },
    });
    console.log("✓ Demo user created  (email: demo@finflow.com  password: Demo@1234)");
  } else {
    await prisma.user.update({ where: { email: "demo@finflow.com" }, data: { emailVerified: true } });
    console.log("✓ Demo user already exists");
  }

  // Only populate sample financial data once — skip if the demo user
  // already has transactions (e.g. re-running seed on every deploy
  // shouldn't duplicate data or wipe anything a recruiter/tester added).
  const existingTxCount = await prisma.transaction.count({ where: { userId: demoUser.id } });
  if (existingTxCount > 0) {
    console.log("✓ Demo data already present — skipping sample data seed");
    return;
  }

  const categories = await prisma.category.findMany({ where: { isDefault: true } });
  const catByName = (name: string) => categories.find((c: (typeof categories)[number]) => c.name === name)!.id;

  // Realistic-looking transaction history: recurring salary + varied
  // expenses across the last 3 months, so charts/reports/AI insights all
  // have something meaningful to show instead of an empty dashboard.
  const today = new Date();
  const dateStr = (monthsAgo: number, day: number) => {
    const d = new Date(today.getFullYear(), today.getMonth() - monthsAgo, day);
    return d.toISOString().slice(0, 10);
  };

  const transactions: { type: "income" | "expense"; amount: number; description: string; date: string; categoryName: string }[] = [];
  for (let m = 2; m >= 0; m--) {
    transactions.push({ type: "income", amount: 5200, description: "Monthly salary", date: dateStr(m, 1), categoryName: "Salary" });
    transactions.push({ type: "income", amount: 600, description: "Freelance web project", date: dateStr(m, 15), categoryName: "Freelance" });
    transactions.push({ type: "expense", amount: 1400, description: "Rent", date: dateStr(m, 2), categoryName: "Bills & Utilities" });
    transactions.push({ type: "expense", amount: 220, description: "Electricity & internet", date: dateStr(m, 5), categoryName: "Bills & Utilities" });
    transactions.push({ type: "expense", amount: 380, description: "Groceries", date: dateStr(m, 7), categoryName: "Food & Dining" });
    transactions.push({ type: "expense", amount: 145, description: "Dining out", date: dateStr(m, 12), categoryName: "Food & Dining" });
    transactions.push({ type: "expense", amount: 90, description: "Gas & rideshare", date: dateStr(m, 9), categoryName: "Transport" });
    transactions.push({ type: "expense", amount: 65, description: "Streaming subscriptions", date: dateStr(m, 3), categoryName: "Entertainment" });
    transactions.push({ type: "expense", amount: 210, description: "Clothing", date: dateStr(m, 18), categoryName: "Shopping" });
    transactions.push({ type: "expense", amount: 500, description: "Savings transfer", date: dateStr(m, 25), categoryName: "Savings" });
  }
  await prisma.transaction.createMany({
    data: transactions.map((t) => ({
      userId: demoUser!.id,
      type: t.type,
      amount: t.amount,
      description: t.description,
      date: t.date,
      categoryId: catByName(t.categoryName),
    })),
  });
  console.log(`✓ ${transactions.length} sample transactions seeded`);

  // Budgets
  await prisma.budget.createMany({
    data: [
      { userId: demoUser.id, name: "Food & Dining", amount: 600, period: "monthly", categoryId: catByName("Food & Dining") },
      { userId: demoUser.id, name: "Entertainment", amount: 100, period: "monthly", categoryId: catByName("Entertainment") },
      { userId: demoUser.id, name: "Shopping", amount: 250, period: "monthly", categoryId: catByName("Shopping") },
    ],
  });
  console.log("✓ Sample budgets seeded");

  // Goals
  await prisma.goal.createMany({
    data: [
      { userId: demoUser.id, name: "Emergency Fund", type: "emergency_fund", targetAmount: 10000, currentAmount: 4200, deadline: dateStr(-9, 1) },
      { userId: demoUser.id, name: "Japan Trip", type: "vacation", targetAmount: 3000, currentAmount: 850, deadline: dateStr(-6, 1) },
    ],
  });
  console.log("✓ Sample goals seeded");

  // A debt with some payoff progress already made, so the debt-planner UI
  // has real numbers to project instead of an empty state.
  await prisma.debt.create({
    data: {
      userId: demoUser.id,
      name: "Car Loan",
      debtType: "auto_loan",
      balance: 8400,
      interestRate: 6.5,
      minimumPayment: 320,
    },
  });
  console.log("✓ Sample debt seeded");

  console.log("Seeding complete!");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
