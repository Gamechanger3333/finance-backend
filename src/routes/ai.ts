import { Router } from "express";
import rateLimit from "express-rate-limit";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import Groq from "groq-sdk";
import { getCashflowForecast } from "../lib/finance.js";
import { buildSummary } from "./reports.js";

const router = Router();

// AI calls cost real money/tokens per request — these routes had no rate
// limiting at all before, unlike every other route in the app.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Too many AI requests, please try again in a few minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});
const landingChatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many requests, please try again in a few minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_TURNS = 6;

function getGroq() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");
  return new Groq({ apiKey });
}

/**
 * Sanitizes a client-supplied chat history array into a bounded list of
 * {role, content} pairs the model can consume. Keeps only the last
 * MAX_HISTORY_TURNS turns so a single conversation can't grow the prompt
 * (and therefore the API bill) without limit.
 */
function sanitizeHistory(history: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(history)) return [];
  const cleaned = history
    .filter(
      (m: any) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, MAX_MESSAGE_LENGTH) }));
  return cleaned.slice(-MAX_HISTORY_TURNS * 2);
}

async function getUserFinancialContext(userId: number) {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  // Grounds the advisor in the same data the rest of the app uses: recent
  // transactions, budgets, goals, outstanding debts, and the cash-flow
  // forecast — so its answers can't drift from what's actually on the
  // user's dashboard.
  const [transactions, budgets, goals, debts, forecast] = await Promise.all([
    prisma.transaction.findMany({ where: { userId }, orderBy: { date: "desc" }, take: 50 }),
    prisma.budget.findMany({ where: { userId } }),
    prisma.goal.findMany({ where: { userId } }),
    prisma.debt.findMany({ where: { userId, isPaidOff: false } }),
    getCashflowForecast(userId, 30).catch(() => null),
  ]);

  const thisMonth = transactions.filter((t: any) => t.date >= monthStart);
  const totalIncome = thisMonth.filter((t: any) => t.type === "income").reduce((s: number, t: any) => s + t.amount, 0);
  const totalExpenses = thisMonth.filter((t: any) => t.type === "expense").reduce((s: number, t: any) => s + t.amount, 0);
  const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;
  const totalDebt = debts.reduce((s: number, d: any) => s + d.balance, 0);

  return {
    summary: { totalIncome, totalExpenses, savingsRate, transactionCount: thisMonth.length },
    budgets: budgets.map((b: any) => ({ name: b.name, amount: b.amount, period: b.period })),
    goals: goals.map((g: any) => ({ name: g.name, target: g.targetAmount, current: g.currentAmount, type: g.type })),
    recentTransactions: thisMonth.slice(0, 10).map((t: any) => ({ type: t.type, amount: t.amount, description: t.description })),
    debts: { totalDebt, count: debts.length, items: debts.map((d: any) => ({ name: d.name, balance: d.balance, apr: d.interestRate, minimumPayment: d.minimumPayment })) },
    cashflow: forecast ? { startingBalance: forecast.startingBalance, lowestPoint: forecast.lowestPoint, overdraftDate: forecast.overdraftDate } : null,
  };
}

router.get("/insights", aiLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    const ctx = await getUserFinancialContext(req.userId!);
    const prompt = `You are an expert financial advisor. Based on this user's financial data, generate actionable insights.

Financial Data:
- Monthly Income: $${ctx.summary.totalIncome.toFixed(2)}
- Monthly Expenses: $${ctx.summary.totalExpenses.toFixed(2)}
- Savings Rate: ${ctx.summary.savingsRate.toFixed(1)}%
- Active Budgets: ${ctx.budgets.length}
- Financial Goals: ${ctx.goals.length}
- Outstanding Debt: $${ctx.debts.totalDebt.toFixed(2)} across ${ctx.debts.count} debt(s)
- Cash-flow (30-day): starting balance $${ctx.cashflow?.startingBalance?.toFixed(2) ?? "unknown"}${ctx.cashflow?.overdraftDate ? `, projected overdraft risk around ${ctx.cashflow.overdraftDate}` : ", no projected overdraft"}
- Recent Transactions: ${JSON.stringify(ctx.recentTransactions.slice(0, 5))}

Respond with a JSON object (no markdown, raw JSON only) with this exact structure:
{"insights":[{"type":"warning|opportunity|tip|achievement","title":"...","description":"...","impact":"..."}],"spendingAnalysis":"2-3 sentences","recommendations":["rec1","rec2","rec3"],"savingsOpportunities":["opp1","opp2","opp3"],"healthTips":["tip1","tip2","tip3"]}`;

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
      logger.warn({ aiErr }, "Groq AI call failed, using fallback");
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

router.post("/chat", aiLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message required" });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `message must be under ${MAX_MESSAGE_LENGTH} characters` });
      return;
    }

    const ctx = await getUserFinancialContext(req.userId!);
    const systemPrompt = `You are FinFlow AI, an expert personal finance assistant. You have access to the user's financial data:
- Monthly Income: $${ctx.summary.totalIncome.toFixed(2)}
- Monthly Expenses: $${ctx.summary.totalExpenses.toFixed(2)}
- Savings Rate: ${ctx.summary.savingsRate.toFixed(1)}%
- Goals: ${ctx.goals.map((g: any) => g.name).join(", ") || "None set"}
- Budgets: ${ctx.budgets.map((b: any) => b.name).join(", ") || "None set"}
- Outstanding Debt: $${ctx.debts.totalDebt.toFixed(2)}${ctx.debts.count ? ` (${ctx.debts.items.map((d: any) => `${d.name}: $${d.balance.toFixed(2)} @ ${d.apr}% APR`).join("; ")})` : " (none)"}
- 30-day cash-flow: starting balance $${ctx.cashflow?.startingBalance?.toFixed(2) ?? "unknown"}${ctx.cashflow?.overdraftDate ? `, projected to dip negative around ${ctx.cashflow.overdraftDate}` : ", no projected overdraft"}
Be specific, actionable, and concise. Keep responses under 150 words.`;

    // Conversation history lets the assistant hold a real multi-turn
    // conversation instead of treating every message as a cold start.
    const priorTurns = sanitizeHistory(history);

    let reply: string;
    try {
      const groq = getGroq();
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          ...priorTurns,
          { role: "user", content: message },
        ],
        max_tokens: 300,
        temperature: 0.7,
      });
      reply = completion.choices[0]?.message?.content ?? "I'm having trouble connecting. Please try again.";
    } catch (aiErr) {
      logger.warn({ aiErr }, "Groq chat failed");
      reply = "I'm your AI financial assistant. Please check your GROQ_API_KEY configuration to enable AI responses.";
    }

    // Persist both turns so the conversation survives a refresh/new
    // session (see GET/DELETE /chat/history below).
    try {
      await prisma.chatMessage.createMany({
        data: [
          { userId: req.userId!, role: "user", content: message.slice(0, MAX_MESSAGE_LENGTH) },
          { userId: req.userId!, role: "assistant", content: reply.slice(0, 4000) },
        ],
      });
    } catch (persistErr) {
      logger.warn({ persistErr }, "Failed to persist chat message");
    }

    res.json({
      reply,
      suggestions: ["How can I save more money?", "Am I on track with my budget?", "What should my emergency fund be?", "How can I improve my financial health score?"],
    });
  } catch (err) {
    logger.error({ err }, "AI chat error");
    res.json({ reply: "I'm your AI financial assistant. What would you like to know?", suggestions: ["How can I save more money?", "What expenses should I cut?"] });
  }
});

// GET /api/ai/chat/history — last 50 persisted messages, oldest first, so
// the frontend can restore the conversation on load.
router.get("/chat/history", requireAuth, async (req: AuthRequest, res) => {
  try {
    const rows = await prisma.chatMessage.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    res.json({ messages: rows.map((m: any) => ({ role: m.role, content: m.content })) });
  } catch (err) {
    logger.error({ err }, "Get chat history error");
    res.status(500).json({ error: "Failed to load chat history" });
  }
});

// DELETE /api/ai/chat/history — "Clear conversation" in the UI.
router.delete("/chat/history", requireAuth, async (req: AuthRequest, res) => {
  try {
    await prisma.chatMessage.deleteMany({ where: { userId: req.userId! } });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Clear chat history error");
    res.status(500).json({ error: "Failed to clear chat history" });
  }
});

// GET /api/ai/monthly-report?month=YYYY-MM — AI-generated natural-language
// summary of a given month's activity, grounded in that month's actual
// transaction/category breakdown (via the same buildSummary() the CSV/PDF
// exports use, so the numbers always match what's on the Reports page).
router.get("/monthly-report", aiLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    const monthParam = String(req.query.month ?? "");
    const now = new Date();
    const month = /^\d{4}-\d{2}$/.test(monthParam)
      ? monthParam
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const [year, mm] = month.split("-").map(Number);
    const startDate = `${month}-01`;
    const lastDay = new Date(year, mm, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;

    const summary = await buildSummary(req.userId!, startDate, endDate);
    const { transactions, ...summaryForPrompt } = summary;

    const prompt = `You are a personal finance assistant writing a short monthly report for a user, based only on this data:
${JSON.stringify(summaryForPrompt)}

Write a natural-language monthly financial report in plain prose (2-4 short paragraphs, no markdown headers, no bullet lists). Cover: overall income vs expenses and net result, the top 1-3 spending categories, anything notable (e.g. a category that dominates spending), and one or two concrete, specific suggestions for next month. Be warm but concise. Do not invent numbers not present in the data.`;

    let report: string;
    try {
      const groq = getGroq();
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.6,
      });
      report = completion.choices[0]?.message?.content ?? "";
    } catch (aiErr) {
      logger.warn({ aiErr }, "Groq monthly report failed");
      report = `In ${month}, you had $${summary.totalIncome.toFixed(2)} in income and $${summary.totalExpenses.toFixed(2)} in expenses, for a net of $${summary.netIncome.toFixed(2)}. Add your GROQ_API_KEY to enable the full AI-written narrative report.`;
    }

    res.json({ month, report, summary: summaryForPrompt });
  } catch (err) {
    logger.error({ err }, "AI monthly report error");
    res.status(500).json({ error: "Failed to generate monthly report" });
  }
});

// ─── Public landing-page assistant ───────────────────────────────────────────
// Unauthenticated visitors browsing the marketing site get a lightweight
// assistant that can answer product/pricing/general-finance questions. It
// never touches user financial data (there is no logged-in user yet), and is
// rate-limited more tightly than the in-app assistant since it's open to the
// public internet.
const LANDING_SYSTEM_PROMPT = `You are the FinFlow website assistant, greeting visitors on the public marketing/landing page (they are not logged in yet).
FinFlow is a personal finance app with: smart analytics dashboards, an AI financial advisor (powered by Llama 3.3 via Groq), budget management with overspend alerts, goal tracking, automatic transaction categorization, and bank-level security. Plans: Free ($0, 50 tx/month, 3 budget categories, 10 AI chats/day), Pro ($9/mo, unlimited everything), Business ($29/mo, adds team seats + API access).
Answer questions about the product, pricing, and general personal-finance/budgeting topics. Encourage visitors to create a free account or try the demo login when relevant, but don't be pushy. You do not have access to any specific person's financial data — if asked about "my" transactions/budgets, explain that this becomes available after signing in. Keep answers under 80 words and friendly.`;

router.post("/landing-chat", landingChatLimiter, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message required" });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `message must be under ${MAX_MESSAGE_LENGTH} characters` });
      return;
    }

    const priorTurns = sanitizeHistory(history);
    let reply: string;
    try {
      const groq = getGroq();
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: LANDING_SYSTEM_PROMPT },
          ...priorTurns,
          { role: "user", content: message },
        ],
        max_tokens: 220,
        temperature: 0.6,
      });
      reply =
        completion.choices[0]?.message?.content ??
        "I'm having trouble connecting right now — please try again in a moment.";
    } catch (aiErr) {
      logger.warn({ aiErr }, "Groq landing chat failed");
      reply =
        "I'm the FinFlow assistant! I can tell you about our AI budgeting tools, pricing plans, or general saving tips — what would you like to know?";
    }

    res.json({
      reply,
      suggestions: [
        "What does FinFlow cost?",
        "How does the AI advisor work?",
        "Is my data secure?",
        "How do I get started?",
      ],
    });
  } catch (err) {
    logger.error({ err }, "Landing chat error");
    res.json({
      reply: "Hi! I'm the FinFlow assistant. Ask me about features, pricing, or budgeting tips.",
      suggestions: ["What does FinFlow cost?", "How does the AI advisor work?"],
    });
  }
});

export default router;
