import { Router } from "express";
import { db, transactionsTable, budgetsTable, goalsTable } from "../db/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import Groq from "groq-sdk";

const router = Router();

function getGroq() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");
  return new Groq({ apiKey });
}

async function getUserFinancialContext(userId: number) {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const [transactions, budgets, goals] = await Promise.all([
    db.select().from(transactionsTable).where(eq(transactionsTable.userId, userId)).limit(50),
    db.select().from(budgetsTable).where(eq(budgetsTable.userId, userId)),
    db.select().from(goalsTable).where(eq(goalsTable.userId, userId)),
  ]);

  const thisMonth = transactions.filter((t) => t.date >= monthStart);
  const totalIncome = thisMonth.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const totalExpenses = thisMonth.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;

  return {
    summary: { totalIncome, totalExpenses, savingsRate, transactionCount: thisMonth.length },
    budgets: budgets.map((b) => ({ name: b.name, amount: b.amount, period: b.period })),
    goals: goals.map((g) => ({ name: g.name, target: g.targetAmount, current: g.currentAmount, type: g.type })),
    recentTransactions: thisMonth.slice(0, 10).map((t) => ({ type: t.type, amount: t.amount, description: t.description })),
  };
}

router.get("/insights", requireAuth, async (req: AuthRequest, res) => {
  try {
    const ctx = await getUserFinancialContext(req.userId!);

    const prompt = `You are an expert financial advisor. Based on this user's financial data, generate actionable insights.

Financial Data:
- Monthly Income: $${ctx.summary.totalIncome.toFixed(2)}
- Monthly Expenses: $${ctx.summary.totalExpenses.toFixed(2)}
- Savings Rate: ${ctx.summary.savingsRate.toFixed(1)}%
- Active Budgets: ${ctx.budgets.length}
- Financial Goals: ${ctx.goals.length}
- Recent Transactions: ${JSON.stringify(ctx.recentTransactions.slice(0, 5))}

Respond with a JSON object (no markdown, raw JSON only) with this exact structure:
{
  "insights": [
    {"type": "warning|opportunity|tip|achievement", "title": "...", "description": "...", "impact": "..."},
    {"type": "warning|opportunity|tip|achievement", "title": "...", "description": "...", "impact": "..."},
    {"type": "warning|opportunity|tip|achievement", "title": "...", "description": "...", "impact": "..."}
  ],
  "spendingAnalysis": "2-3 sentences",
  "recommendations": ["rec 1", "rec 2", "rec 3"],
  "savingsOpportunities": ["opp 1", "opp 2", "opp 3"],
  "healthTips": ["tip 1", "tip 2", "tip 3"]
}`;

    let parsed;
    try {
      const groq = getGroq();
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0.7,
      });
      const text = completion.choices[0]?.message?.content ?? "{}";
      parsed = JSON.parse(text);
    } catch (aiErr) {
      logger.warn({ aiErr }, "Groq AI call failed, using fallback insights");
      parsed = {
        insights: [
          { type: "tip", title: "Track Your Spending", description: "Add more transactions to get personalized insights.", impact: "Better financial awareness" },
          { type: "opportunity", title: "Set a Budget", description: "Creating category budgets helps control spending.", impact: "Save up to 20% more" },
          { type: "achievement", title: "You Are Saving!", description: `Your savings rate is ${ctx.summary.savingsRate.toFixed(1)}% this month.`, impact: "Building financial security" },
        ],
        spendingAnalysis: "Add more transaction data to get a detailed spending analysis.",
        recommendations: ["Set monthly budgets for your top expense categories", "Aim for a 20% savings rate", "Review your subscriptions monthly"],
        savingsOpportunities: ["Automate savings transfers", "Track discretionary spending", "Compare utility providers"],
        healthTips: ["Build a 3-6 month emergency fund", "Pay off high-interest debt first", "Invest early for compound growth"],
      };
    }

    res.json(parsed);
  } catch (err) {
    logger.error({ err }, "AI insights error");
    res.json({
      insights: [
        { type: "tip", title: "Start Tracking", description: "Add transactions to get personalized AI insights.", impact: "Improved financial awareness" },
        { type: "opportunity", title: "Create Your Budget", description: "Setting budgets helps you stay on track.", impact: "Control your spending" },
        { type: "tip", title: "Set Financial Goals", description: "Goals give your savings a purpose.", impact: "Faster wealth building" },
      ],
      spendingAnalysis: "Add your transactions to get detailed spending analysis.",
      recommendations: ["Set monthly budgets", "Track every expense for 30 days", "Set a savings goal"],
      savingsOpportunities: ["Review subscriptions", "Cook more at home", "Use cashback cards"],
      healthTips: ["Save 3-6 months of expenses", "Invest 15% of income", "Pay yourself first"],
    });
  }
});

router.post("/chat", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      res.status(400).json({ error: "message required" });
      return;
    }

    const ctx = await getUserFinancialContext(req.userId!);

    const systemPrompt = `You are FinFlow AI, an expert personal finance assistant. You have access to the user's financial data:
- Monthly Income: $${ctx.summary.totalIncome.toFixed(2)}
- Monthly Expenses: $${ctx.summary.totalExpenses.toFixed(2)}
- Savings Rate: ${ctx.summary.savingsRate.toFixed(1)}%
- Goals: ${ctx.goals.map((g) => g.name).join(", ") || "None set"}
- Budgets: ${ctx.budgets.map((b) => b.name).join(", ") || "None set"}

Be specific, actionable, and concise. Keep responses under 150 words.`;

    let reply: string;
    try {
      const groq = getGroq();
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        max_tokens: 300,
        temperature: 0.7,
      });
      reply = completion.choices[0]?.message?.content ?? "I'm having trouble connecting. Please try again.";
    } catch (aiErr) {
      logger.warn({ aiErr }, "Groq chat failed, using fallback");
      reply = "I'm your AI financial assistant. Please check your GROQ_API_KEY configuration to enable AI responses.";
    }

    const suggestions = [
      "How can I save more money?",
      "Am I on track with my budget?",
      "What should my emergency fund be?",
      "How can I improve my financial health score?",
    ];

    res.json({ reply, suggestions });
  } catch (err) {
    logger.error({ err }, "AI chat error");
    res.json({
      reply: "I'm your AI financial assistant. What would you like to know?",
      suggestions: ["How can I save more money?", "What expenses should I cut?", "How do I reach my savings goal?"],
    });
  }
});

export default router;
