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
  const existing = await prisma.user.findUnique({ where: { email: "demo@finflow.com" } });
  if (!existing) {
    await prisma.user.create({
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
    // Make sure existing demo user is verified
    await prisma.user.update({ where: { email: "demo@finflow.com" }, data: { emailVerified: true } });
    console.log("✓ Demo user already exists");
  }

  console.log("Seeding complete!");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
