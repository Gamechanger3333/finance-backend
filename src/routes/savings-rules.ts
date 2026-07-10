import { Router, Response } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { runDueFixedSavingsRules } from "../lib/savings.js";

const router = Router();

const RULE_TYPES = ["round_up", "percent_of_income", "fixed_recurring"] as const;
type RuleType = (typeof RULE_TYPES)[number];
const FREQUENCIES = ["weekly", "monthly"];

function isPositiveNumber(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function isValidDate(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v).getTime());
}

async function isGoalOwnedByUser(goalId: number, userId: number): Promise<boolean> {
  const goal = await prisma.goal.findFirst({ where: { id: goalId, userId }, select: { id: true } });
  return !!goal;
}

function serializeRule(rule: any) {
  return {
    ...rule,
    goalName: rule.goal?.name ?? null,
    createdAt: rule.createdAt instanceof Date ? rule.createdAt.toISOString() : rule.createdAt,
  };
}

function validateTypeFields(body: any, res: Response): Record<string, any> | null {
  const { type, roundUpTo, percentage, fixedAmount, frequency, nextRunDate } = body;
  const data: Record<string, any> = {};

  if (type === "round_up") {
    if (!isPositiveNumber(roundUpTo)) { res.status(400).json({ error: "roundUpTo must be a positive number (e.g. 1, 5, 10)" }); return null; }
    data.roundUpTo = Number(roundUpTo);
  } else if (type === "percent_of_income") {
    const pct = Number(percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) { res.status(400).json({ error: "percentage must be between 1 and 100" }); return null; }
    data.percentage = pct;
  } else if (type === "fixed_recurring") {
    if (!isPositiveNumber(fixedAmount)) { res.status(400).json({ error: "fixedAmount must be a positive number" }); return null; }
    if (!FREQUENCIES.includes(frequency)) { res.status(400).json({ error: `frequency must be one of: ${FREQUENCIES.join(", ")}` }); return null; }
    if (!isValidDate(nextRunDate)) { res.status(400).json({ error: "nextRunDate is required in YYYY-MM-DD format" }); return null; }
    data.fixedAmount = Number(fixedAmount);
    data.frequency = frequency;
    data.nextRunDate = nextRunDate;
  }
  return data;
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    await runDueFixedSavingsRules(req.userId!);
    const rules = await prisma.savingsRule.findMany({
      where: { userId: req.userId! },
      include: { goal: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(rules.map(serializeRule));
  } catch (err) {
    logger.error({ err }, "List savings rules error");
    res.status(500).json({ error: "Failed to fetch savings rules" });
  }
});

// Recent contribution activity across all of the user's rules — powers an
// "impact feed" in the UI.
router.get("/activity", requireAuth, async (req: AuthRequest, res) => {
  try {
    const contributions = await prisma.savingsContribution.findMany({
      where: { userId: req.userId! },
      include: { rule: { select: { name: true, type: true, goal: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json(contributions.map((c: any) => ({
      id: c.id,
      amount: c.amount,
      note: c.note,
      ruleName: c.rule?.name,
      ruleType: c.rule?.type,
      goalName: c.rule?.goal?.name,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
    })));
  } catch (err) {
    logger.error({ err }, "Savings activity error");
    res.status(500).json({ error: "Failed to fetch savings activity" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, type, goalId } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!RULE_TYPES.includes(type)) { res.status(400).json({ error: `type must be one of: ${RULE_TYPES.join(", ")}` }); return; }
    const gId = parseInt(goalId);
    if (!Number.isInteger(gId) || !(await isGoalOwnedByUser(gId, req.userId!))) { res.status(400).json({ error: "Invalid goal" }); return; }

    const typeData = validateTypeFields(req.body, res);
    if (typeData === null) return;

    const rule = await prisma.savingsRule.create({
      data: { userId: req.userId!, name: name.trim(), type, goalId: gId, ...typeData },
      include: { goal: { select: { name: true } } },
    });
    res.status(201).json(serializeRule(rule));
  } catch (err) {
    logger.error({ err }, "Create savings rule error");
    res.status(500).json({ error: "Failed to create savings rule" });
  }
});

async function updateRuleHandler(req: AuthRequest, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid rule id" }); return; }

    const existing = await prisma.savingsRule.findFirst({ where: { id, userId: req.userId! } });
    if (!existing) { res.status(404).json({ error: "Savings rule not found" }); return; }

    const { name, isActive, goalId } = req.body;
    const data: Record<string, any> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name cannot be empty" }); return; }
      data.name = name.trim();
    }
    if (isActive !== undefined) data.isActive = !!isActive;
    if (goalId !== undefined) {
      const gId = parseInt(goalId);
      if (!Number.isInteger(gId) || !(await isGoalOwnedByUser(gId, req.userId!))) { res.status(400).json({ error: "Invalid goal" }); return; }
      data.goalId = gId;
    }

    // Allow updating the type-specific fields for whatever type this rule
    // already is (type itself is immutable — create a new rule to change it).
    const merged = { ...req.body, type: existing.type };
    if (["roundUpTo", "percentage", "fixedAmount", "frequency", "nextRunDate"].some((k) => req.body[k] !== undefined)) {
      const typeData = validateTypeFields(merged, res);
      if (typeData === null) return;
      Object.assign(data, typeData);
    }

    const rule = await prisma.savingsRule.update({ where: { id }, data, include: { goal: { select: { name: true } } } });
    res.json(serializeRule(rule));
  } catch (err) {
    logger.error({ err }, "Update savings rule error");
    res.status(500).json({ error: "Failed to update savings rule" });
  }
}

router.patch("/:id", requireAuth, updateRuleHandler);
router.put("/:id", requireAuth, updateRuleHandler);

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid rule id" }); return; }

    const existing = await prisma.savingsRule.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Savings rule not found" }); return; }

    await prisma.savingsRule.delete({ where: { id } });
    res.json({ success: true, message: "Savings rule deleted" });
  } catch (err) {
    logger.error({ err }, "Delete savings rule error");
    res.status(500).json({ error: "Failed to delete savings rule" });
  }
});

export default router;
