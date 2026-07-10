import { Router } from "express";
import crypto from "crypto";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

function isPositiveNumber(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function generateInviteCode(): string {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function getMembership(userId: number) {
  return prisma.householdMember.findFirst({ where: { userId }, include: { household: true } });
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const membership = await getMembership(req.userId!);
    if (!membership) { res.json(null); return; }

    const members = await prisma.householdMember.findMany({
      where: { householdId: membership.householdId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { joinedAt: "asc" },
    });

    res.json({
      id: membership.household.id,
      name: membership.household.name,
      inviteCode: membership.household.inviteCode,
      ownerId: membership.household.ownerId,
      myRole: membership.role,
      members: members.map((m: any) => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role })),
    });
  } catch (err) {
    logger.error({ err }, "Get household error");
    res.status(500).json({ error: "Failed to fetch household" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const existing = await getMembership(req.userId!);
    if (existing) { res.status(400).json({ error: "You're already in a household. Leave it first to create a new one." }); return; }

    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name is required" }); return; }

    let inviteCode = generateInviteCode();
    // Extremely unlikely collision, but guard anyway.
    for (let i = 0; i < 5 && (await prisma.household.findUnique({ where: { inviteCode } })); i++) inviteCode = generateInviteCode();

    const household = await prisma.household.create({
      data: {
        name: name.trim(),
        ownerId: req.userId!,
        inviteCode,
        members: { create: { userId: req.userId!, role: "owner" } },
      },
    });
    res.status(201).json({ id: household.id, name: household.name, inviteCode: household.inviteCode });
  } catch (err) {
    logger.error({ err }, "Create household error");
    res.status(500).json({ error: "Failed to create household" });
  }
});

router.post("/join", requireAuth, async (req: AuthRequest, res) => {
  try {
    const existing = await getMembership(req.userId!);
    if (existing) { res.status(400).json({ error: "You're already in a household. Leave it first to join another." }); return; }

    const { inviteCode } = req.body;
    if (!inviteCode || typeof inviteCode !== "string") { res.status(400).json({ error: "inviteCode is required" }); return; }

    const household = await prisma.household.findUnique({ where: { inviteCode: inviteCode.toUpperCase().trim() } });
    if (!household) { res.status(404).json({ error: "No household found with that invite code" }); return; }

    await prisma.householdMember.create({ data: { householdId: household.id, userId: req.userId!, role: "member" } });
    res.status(201).json({ id: household.id, name: household.name });
  } catch (err) {
    logger.error({ err }, "Join household error");
    res.status(500).json({ error: "Failed to join household" });
  }
});

router.post("/leave", requireAuth, async (req: AuthRequest, res) => {
  try {
    const membership = await getMembership(req.userId!);
    if (!membership) { res.status(400).json({ error: "You're not in a household" }); return; }

    if (membership.role === "owner") {
      const otherMembers = await prisma.householdMember.count({ where: { householdId: membership.householdId, userId: { not: req.userId! } } });
      if (otherMembers > 0) {
        res.status(400).json({ error: "Transfer ownership or remove other members before leaving as owner." });
        return;
      }
      // Last member out — tear down the household entirely.
      await prisma.household.delete({ where: { id: membership.householdId } });
    } else {
      await prisma.householdMember.delete({ where: { id: membership.id } });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Leave household error");
    res.status(500).json({ error: "Failed to leave household" });
  }
});

router.get("/expenses", requireAuth, async (req: AuthRequest, res) => {
  try {
    const membership = await getMembership(req.userId!);
    if (!membership) { res.json([]); return; }

    const expenses = await prisma.sharedExpense.findMany({
      where: { householdId: membership.householdId },
      include: {
        paidBy: { select: { id: true, name: true } },
        splits: { include: { user: { select: { id: true, name: true } } } },
      },
      orderBy: { date: "desc" },
      take: 100,
    });

    res.json(expenses.map((e: any) => ({
      id: e.id,
      description: e.description,
      amount: e.amount,
      date: e.date,
      paidByUserId: e.paidByUserId,
      paidByName: e.paidBy.name,
      createdAt: e.createdAt.toISOString(),
      splits: e.splits.map((s: any) => ({ id: s.id, userId: s.userId, userName: s.user.name, amountOwed: s.amountOwed, isSettled: s.isSettled })),
    })));
  } catch (err) {
    logger.error({ err }, "List shared expenses error");
    res.status(500).json({ error: "Failed to fetch shared expenses" });
  }
});

router.post("/expenses", requireAuth, async (req: AuthRequest, res) => {
  try {
    const membership = await getMembership(req.userId!);
    if (!membership) { res.status(400).json({ error: "You're not in a household" }); return; }

    const { description, amount, date, splitMethod, customSplits } = req.body;
    if (!description || typeof description !== "string" || !description.trim()) { res.status(400).json({ error: "description is required" }); return; }
    if (!isPositiveNumber(amount)) { res.status(400).json({ error: "amount must be a positive number" }); return; }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "date is required in YYYY-MM-DD format" }); return; }
    if (!["equal", "custom"].includes(splitMethod)) { res.status(400).json({ error: "splitMethod must be 'equal' or 'custom'" }); return; }

    const members = await prisma.householdMember.findMany({ where: { householdId: membership.householdId }, select: { userId: true } });
    const memberIds = members.map((m: any) => m.userId);

    let splits: { userId: number; amountOwed: number }[];
    if (splitMethod === "equal") {
      const share = Math.round((Number(amount) / memberIds.length) * 100) / 100;
      splits = memberIds.map((userId: number) => ({ userId, amountOwed: share }));
      // Fix any rounding drift onto the payer's share.
      const drift = Math.round((Number(amount) - share * memberIds.length) * 100) / 100;
      if (drift !== 0) {
        const idx = splits.findIndex((s) => s.userId === req.userId!);
        if (idx >= 0) splits[idx].amountOwed = Math.round((splits[idx].amountOwed + drift) * 100) / 100;
      }
    } else {
      if (!Array.isArray(customSplits) || customSplits.length === 0) { res.status(400).json({ error: "customSplits is required for a custom split" }); return; }
      for (const s of customSplits) {
        if (!memberIds.includes(Number(s.userId)) || !isPositiveNumber(s.amount)) { res.status(400).json({ error: "Invalid customSplits entry" }); return; }
      }
      const total = customSplits.reduce((sum: number, s: any) => sum + Number(s.amount), 0);
      if (Math.abs(total - Number(amount)) > 0.01) { res.status(400).json({ error: "customSplits must add up to the total amount" }); return; }
      splits = customSplits.map((s: any) => ({ userId: Number(s.userId), amountOwed: Number(s.amount) }));
    }

    // The payer doesn't owe themselves — their own share is already covered
    // by having paid, so it's excluded from the "who owes what" ledger.
    const owedSplits = splits.filter((s) => s.userId !== req.userId!);

    const expense = await prisma.sharedExpense.create({
      data: {
        householdId: membership.householdId,
        paidByUserId: req.userId!,
        description: description.trim(),
        amount: Number(amount),
        date,
        splits: { create: owedSplits.map((s) => ({ userId: s.userId, amountOwed: s.amountOwed })) },
      },
      include: { splits: true },
    });

    res.status(201).json(expense);
  } catch (err) {
    logger.error({ err }, "Create shared expense error");
    res.status(500).json({ error: "Failed to create shared expense" });
  }
});

// A member marks their own share as settled — this app doesn't move real
// money, so settlement is a self-reported acknowledgment, same spirit as
// the debt payoff planner's manual "log a payment".
router.post("/expenses/:expenseId/splits/:splitId/settle", requireAuth, async (req: AuthRequest, res) => {
  try {
    const splitId = parseInt(req.params.splitId);
    if (!Number.isInteger(splitId)) { res.status(400).json({ error: "Invalid split id" }); return; }

    const split = await prisma.sharedExpenseSplit.findFirst({ where: { id: splitId, userId: req.userId! } });
    if (!split) { res.status(404).json({ error: "Split not found" }); return; }

    const updated = await prisma.sharedExpenseSplit.update({ where: { id: splitId }, data: { isSettled: true } });
    res.json(updated);
  } catch (err) {
    logger.error({ err }, "Settle split error");
    res.status(500).json({ error: "Failed to settle split" });
  }
});

router.get("/balances", requireAuth, async (req: AuthRequest, res) => {
  try {
    const membership = await getMembership(req.userId!);
    if (!membership) { res.json({ owedToMe: 0, iOwe: 0, byMember: [] }); return; }

    const expenses = await prisma.sharedExpense.findMany({
      where: { householdId: membership.householdId },
      include: { splits: true, paidBy: { select: { id: true, name: true } } },
    });

    // net[otherUserId] > 0 means they owe me; < 0 means I owe them.
    const net = new Map<number, { name: string; amount: number }>();
    const nameCache = new Map<number, string>();

    const allMembers = await prisma.householdMember.findMany({
      where: { householdId: membership.householdId },
      include: { user: { select: { id: true, name: true } } },
    });
    for (const m of allMembers as any[]) nameCache.set(m.userId, m.user.name);

    for (const e of expenses as any[]) {
      for (const split of e.splits) {
        if (split.isSettled) continue;
        if (e.paidByUserId === req.userId! && split.userId !== req.userId!) {
          // They owe me.
          const cur = net.get(split.userId) ?? { name: nameCache.get(split.userId) ?? "Member", amount: 0 };
          cur.amount += split.amountOwed;
          net.set(split.userId, cur);
        } else if (split.userId === req.userId! && e.paidByUserId !== req.userId!) {
          // I owe them.
          const cur = net.get(e.paidByUserId) ?? { name: nameCache.get(e.paidByUserId) ?? "Member", amount: 0 };
          cur.amount -= split.amountOwed;
          net.set(e.paidByUserId, cur);
        }
      }
    }

    const byMember = Array.from(net.entries()).map(([userId, v]) => ({ userId, name: v.name, amount: Math.round(v.amount * 100) / 100 }));
    const owedToMe = byMember.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0);
    const iOwe = byMember.filter((m) => m.amount < 0).reduce((s, m) => s + Math.abs(m.amount), 0);

    res.json({ owedToMe: Math.round(owedToMe * 100) / 100, iOwe: Math.round(iOwe * 100) / 100, byMember });
  } catch (err) {
    logger.error({ err }, "Household balances error");
    res.status(500).json({ error: "Failed to compute balances" });
  }
});

export default router;
