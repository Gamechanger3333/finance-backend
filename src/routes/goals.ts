import { Router, Response } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { checkGoalMilestones } from "../lib/finance.js";

const router = Router();

const GOAL_TYPES = ["savings", "debt_payoff", "investment", "emergency_fund", "vacation", "purchase", "education", "other"];

function enrichGoal(goal: any) {
  const percentage = goal.targetAmount > 0 ? Math.min(100, (goal.currentAmount / goal.targetAmount) * 100) : 0;
  const deadline = new Date(goal.deadline);
  const daysRemaining = Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  return {
    ...goal,
    percentage,
    daysRemaining,
    isCompleted: goal.isCompleted || goal.currentAmount >= goal.targetAmount,
    createdAt: goal.createdAt instanceof Date ? goal.createdAt.toISOString() : goal.createdAt,
  };
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const goals = await prisma.goal.findMany({ where: { userId: req.userId! } });
    res.json(goals.map(enrichGoal));
  } catch (err) {
    logger.error({ err }, "List goals error");
    res.status(500).json({ error: "Failed to fetch goals" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, targetAmount, currentAmount, deadline, type, notes } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!Number.isFinite(Number(targetAmount)) || Number(targetAmount) <= 0) { res.status(400).json({ error: "targetAmount must be a positive number" }); return; }
    if (!deadline) { res.status(400).json({ error: "deadline is required" }); return; }
    if (!type || !GOAL_TYPES.includes(type)) { res.status(400).json({ error: `type must be one of: ${GOAL_TYPES.join(", ")}` }); return; }

    const goal = await prisma.goal.create({
      data: {
        userId: req.userId!,
        name: name.trim(),
        targetAmount: Number(targetAmount),
        currentAmount: currentAmount !== undefined ? Number(currentAmount) : 0,
        deadline,
        type,
        notes,
      },
    });
    res.status(201).json(enrichGoal(goal));
  } catch (err) {
    logger.error({ err }, "Create goal error");
    res.status(500).json({ error: "Failed to create goal" });
  }
});

async function updateGoalHandler(req: AuthRequest, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid goal id" }); return; }

    const existing = await prisma.goal.findFirst({ where: { id, userId: req.userId! } });
    if (!existing) { res.status(404).json({ error: "Goal not found" }); return; }

    const { name, targetAmount, currentAmount, deadline, type, notes, isCompleted } = req.body;
    const data: Record<string, any> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name cannot be empty" }); return; }
      data.name = name.trim();
    }
    if (targetAmount !== undefined) { data.targetAmount = Number(targetAmount); }
    if (currentAmount !== undefined) { data.currentAmount = Number(currentAmount); }
    if (deadline !== undefined) { data.deadline = deadline; }
    if (type !== undefined) { data.type = type; }
    if (notes !== undefined) { data.notes = notes; }
    if (isCompleted !== undefined) { data.isCompleted = !!isCompleted; }

    let goal = await prisma.goal.update({ where: { id }, data });

    // Auto-mark as completed when target is reached
    if (!goal.isCompleted && goal.currentAmount >= goal.targetAmount) {
      goal = await prisma.goal.update({ where: { id }, data: { isCompleted: true } });
    }

    if (currentAmount !== undefined && goal.currentAmount !== existing.currentAmount) {
      await checkGoalMilestones(req.userId!, goal, existing.currentAmount);
    }

    res.json(enrichGoal(goal));
  } catch (err) {
    logger.error({ err }, "Update goal error");
    res.status(500).json({ error: "Failed to update goal" });
  }
}

router.patch("/:id", requireAuth, updateGoalHandler);
router.put("/:id", requireAuth, updateGoalHandler);

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid goal id" }); return; }

    const existing = await prisma.goal.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Goal not found" }); return; }

    await prisma.goal.delete({ where: { id } });
    res.json({ success: true, message: "Goal deleted" });
  } catch (err) {
    logger.error({ err }, "Delete goal error");
    res.status(500).json({ error: "Failed to delete goal" });
  }
});

export default router;
