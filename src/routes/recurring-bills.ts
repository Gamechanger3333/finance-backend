import { Router, Response } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { advanceDate, daysUntil, checkAndNotifyDueBills } from "../lib/finance.js";

const router = Router();

const FREQUENCIES = ["weekly", "monthly", "yearly"] as const;
type Frequency = (typeof FREQUENCIES)[number];

function isPositiveNumber(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function isValidDate(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v).getTime());
}

async function isCategoryUsableByUser(categoryId: number, userId: number): Promise<boolean> {
  const cat = await prisma.category.findFirst({
    where: { id: categoryId, OR: [{ isDefault: true }, { userId }] },
    select: { id: true },
  });
  return !!cat;
}

function statusFor(bill: { nextDueDate: string; isActive: boolean }) {
  if (!bill.isActive) return "paused";
  const d = daysUntil(bill.nextDueDate);
  if (d < 0) return "overdue";
  if (d <= 3) return "due_soon";
  return "upcoming";
}

function serializeBill(bill: any) {
  const days = daysUntil(bill.nextDueDate);
  return {
    ...bill,
    categoryName: bill.category?.name ?? null,
    categoryIcon: bill.category?.icon ?? null,
    daysUntilDue: days,
    status: statusFor(bill),
    createdAt: bill.createdAt instanceof Date ? bill.createdAt.toISOString() : bill.createdAt,
  };
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    await checkAndNotifyDueBills(req.userId!);
    const bills = await prisma.recurringBill.findMany({
      where: { userId: req.userId! },
      include: { category: { select: { name: true, icon: true } } },
      orderBy: { nextDueDate: "asc" },
    });
    res.json(bills.map(serializeBill));
  } catch (err) {
    logger.error({ err }, "List recurring bills error");
    res.status(500).json({ error: "Failed to fetch recurring bills" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, amount, categoryId, frequency, nextDueDate, autoDetected } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!isPositiveNumber(amount)) { res.status(400).json({ error: "amount must be a positive number" }); return; }
    if (!FREQUENCIES.includes(frequency)) { res.status(400).json({ error: `frequency must be one of: ${FREQUENCIES.join(", ")}` }); return; }
    if (!isValidDate(nextDueDate)) { res.status(400).json({ error: "nextDueDate is required in YYYY-MM-DD format" }); return; }

    let catId: number | null = null;
    if (categoryId !== undefined && categoryId !== null && categoryId !== "") {
      catId = parseInt(categoryId);
      if (!Number.isInteger(catId) || !(await isCategoryUsableByUser(catId, req.userId!))) {
        res.status(400).json({ error: "Invalid category" });
        return;
      }
    }

    const bill = await prisma.recurringBill.create({
      data: {
        userId: req.userId!,
        name: name.trim(),
        amount: Number(amount),
        categoryId: catId,
        frequency,
        nextDueDate,
        autoDetected: !!autoDetected,
      },
      include: { category: { select: { name: true, icon: true } } },
    });
    res.status(201).json(serializeBill(bill));
  } catch (err) {
    logger.error({ err }, "Create recurring bill error");
    res.status(500).json({ error: "Failed to create recurring bill" });
  }
});

async function updateBillHandler(req: AuthRequest, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid bill id" }); return; }

    const existing = await prisma.recurringBill.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Recurring bill not found" }); return; }

    const { name, amount, categoryId, frequency, nextDueDate, isActive } = req.body;
    const data: Record<string, any> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name cannot be empty" }); return; }
      data.name = name.trim();
    }
    if (amount !== undefined) {
      if (!isPositiveNumber(amount)) { res.status(400).json({ error: "amount must be a positive number" }); return; }
      data.amount = Number(amount);
    }
    if (frequency !== undefined) {
      if (!FREQUENCIES.includes(frequency)) { res.status(400).json({ error: `frequency must be one of: ${FREQUENCIES.join(", ")}` }); return; }
      data.frequency = frequency;
    }
    if (nextDueDate !== undefined) {
      if (!isValidDate(nextDueDate)) { res.status(400).json({ error: "nextDueDate must be in YYYY-MM-DD format" }); return; }
      data.nextDueDate = nextDueDate;
      data.lastNotifiedDueDate = null; // date moved — allow a fresh reminder for it
    }
    if (categoryId !== undefined) {
      if (categoryId === null || categoryId === "") {
        data.categoryId = null;
      } else {
        const catId = parseInt(categoryId);
        if (!Number.isInteger(catId) || !(await isCategoryUsableByUser(catId, req.userId!))) {
          res.status(400).json({ error: "Invalid category" });
          return;
        }
        data.categoryId = catId;
      }
    }
    if (isActive !== undefined) data.isActive = !!isActive;

    const bill = await prisma.recurringBill.update({
      where: { id },
      data,
      include: { category: { select: { name: true, icon: true } } },
    });
    res.json(serializeBill(bill));
  } catch (err) {
    logger.error({ err }, "Update recurring bill error");
    res.status(500).json({ error: "Failed to update recurring bill" });
  }
}

router.patch("/:id", requireAuth, updateBillHandler);
router.put("/:id", requireAuth, updateBillHandler);

// Marks a bill as paid: logs an actual expense transaction (so it flows into
// budgets/dashboard like any other spend) and rolls nextDueDate forward.
router.post("/:id/mark-paid", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid bill id" }); return; }

    const bill = await prisma.recurringBill.findFirst({ where: { id, userId: req.userId! } });
    if (!bill) { res.status(404).json({ error: "Recurring bill not found" }); return; }

    let categoryId = bill.categoryId;
    if (!categoryId) {
      const fallback = await prisma.category.findFirst({ where: { isDefault: true, type: "expense" }, select: { id: true } });
      categoryId = fallback?.id ?? null;
    }
    if (!categoryId) { res.status(400).json({ error: "No category available to log this payment against" }); return; }

    const today = new Date().toISOString().slice(0, 10);
    const [transaction, updatedBill] = await prisma.$transaction([
      prisma.transaction.create({
        data: {
          userId: req.userId!,
          type: "expense",
          amount: bill.amount,
          description: `${bill.name} (recurring)`,
          date: today,
          categoryId,
        },
      }),
      prisma.recurringBill.update({
        where: { id: bill.id },
        data: { nextDueDate: advanceDate(bill.nextDueDate, bill.frequency as Frequency), lastNotifiedDueDate: null },
        include: { category: { select: { name: true, icon: true } } },
      }),
    ]);

    res.json({ transaction, bill: serializeBill(updatedBill) });
  } catch (err) {
    logger.error({ err }, "Mark bill paid error");
    res.status(500).json({ error: "Failed to mark bill as paid" });
  }
});

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid bill id" }); return; }

    const existing = await prisma.recurringBill.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Recurring bill not found" }); return; }

    await prisma.recurringBill.delete({ where: { id } });
    res.json({ success: true, message: "Recurring bill deleted" });
  } catch (err) {
    logger.error({ err }, "Delete recurring bill error");
    res.status(500).json({ error: "Failed to delete recurring bill" });
  }
});

// ─── Auto-detection ───────────────────────────────────────────────────────────
// Scans the user's last 6 months of expense transactions for repeating
// patterns (same description + category recurring at a roughly fixed
// interval) and returns candidates that aren't already tracked, so the user
// can add them with one click instead of typing every bill in by hand.
router.get("/detect", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const since = new Date();
    since.setMonth(since.getMonth() - 6);
    const sinceStr = since.toISOString().slice(0, 10);

    const [transactions, existingBills] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId, type: "expense", date: { gte: sinceStr } },
        include: { category: { select: { name: true, icon: true } } },
        orderBy: { date: "asc" },
      }),
      prisma.recurringBill.findMany({ where: { userId }, select: { name: true, categoryId: true } }),
    ]);

    const trackedKeys = new Set(existingBills.map((b: any) => `${b.name.trim().toLowerCase()}::${b.categoryId ?? "none"}`));

    const groups = new Map<string, typeof transactions>();
    for (const t of transactions) {
      const key = `${t.description.trim().toLowerCase()}::${t.categoryId}`;
      if (!key.trim() || key.startsWith("::")) continue; // skip transactions with no description
      const list = groups.get(key) ?? [];
      list.push(t);
      groups.set(key, list);
    }

    const candidates: any[] = [];
    for (const [key, txs] of groups) {
      if (txs.length < 2) continue;
      if (trackedKeys.has(`${txs[0].description.trim().toLowerCase()}::${txs[0].categoryId ?? "none"}`)) continue;

      const gaps: number[] = [];
      for (let i = 1; i < txs.length; i++) {
        const d1 = new Date(txs[i - 1].date).getTime();
        const d2 = new Date(txs[i].date).getTime();
        gaps.push(Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
      }
      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;

      let frequency: Frequency | null = null;
      if (avgGap >= 6 && avgGap <= 8) frequency = "weekly";
      else if (avgGap >= 27 && avgGap <= 33) frequency = "monthly";
      else if (avgGap >= 350 && avgGap <= 380) frequency = "yearly";
      if (!frequency) continue;

      const amounts = txs.map((t: any) => t.amount);
      const avgAmount = amounts.reduce((s: number, a: number) => s + a, 0) / amounts.length;
      const variance = Math.max(...amounts) - Math.min(...amounts);
      if (variance / avgAmount > 0.15) continue; // amount too inconsistent to be confident

      const last = txs[txs.length - 1];
      const nextDueDate = advanceDate(last.date, frequency);

      candidates.push({
        key,
        name: last.description,
        amount: Math.round(avgAmount * 100) / 100,
        categoryId: last.categoryId,
        categoryName: last.category?.name ?? null,
        categoryIcon: last.category?.icon ?? null,
        frequency,
        nextDueDate,
        occurrences: txs.length,
      });
    }

    res.json(candidates);
  } catch (err) {
    logger.error({ err }, "Detect recurring bills error");
    res.status(500).json({ error: "Failed to detect recurring bills" });
  }
});

export default router;
