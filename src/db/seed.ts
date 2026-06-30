import "dotenv/config";
import { db, categoriesTable, usersTable } from "./index.js";
import bcrypt from "bcryptjs";

const DEFAULT_CATEGORIES = [
  { name: "Salary", icon: "briefcase", color: "#10b981", type: "income", isDefault: true },
  { name: "Freelance", icon: "laptop", color: "#06b6d4", type: "income", isDefault: true },
  { name: "Investment", icon: "trending-up", color: "#8b5cf6", type: "income", isDefault: true },
  { name: "Other Income", icon: "plus-circle", color: "#f59e0b", type: "income", isDefault: true },
  { name: "Food & Dining", icon: "utensils", color: "#ef4444", type: "expense", isDefault: true },
  { name: "Transportation", icon: "car", color: "#f97316", type: "expense", isDefault: true },
  { name: "Shopping", icon: "shopping-bag", color: "#ec4899", type: "expense", isDefault: true },
  { name: "Entertainment", icon: "film", color: "#a855f7", type: "expense", isDefault: true },
  { name: "Healthcare", icon: "heart", color: "#14b8a6", type: "expense", isDefault: true },
  { name: "Housing", icon: "home", color: "#3b82f6", type: "expense", isDefault: true },
  { name: "Utilities", icon: "zap", color: "#eab308", type: "expense", isDefault: true },
  { name: "Education", icon: "book", color: "#6366f1", type: "expense", isDefault: true },
  { name: "Travel", icon: "plane", color: "#0ea5e9", type: "expense", isDefault: true },
  { name: "Subscriptions", icon: "repeat", color: "#d946ef", type: "expense", isDefault: true },
  { name: "Other", icon: "circle", color: "#6b7280", type: "expense", isDefault: true },
];

async function seed() {
  console.log("🌱 Seeding database...");

  // Insert default categories
  console.log("  → inserting categories...");
  await db.insert(categoriesTable).values(DEFAULT_CATEGORIES).onConflictDoNothing();

  // Create demo user
  console.log("  → creating demo user...");
  const hash = await bcrypt.hash("Demo@1234", 12);
  await db
    .insert(usersTable)
    .values({
      name: "Demo User",
      email: "demo@finflow.com",
      passwordHash: hash,
      userType: "individual",
      currency: "USD",
      financialHealthScore: 72,
    })
    .onConflictDoNothing();

  console.log("✅ Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
