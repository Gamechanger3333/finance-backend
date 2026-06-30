import { Router } from "express";
import { db, goalsTable } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

function enrichGoal(goal: typeof goalsTable.$inferSelect) {
  const percentage = goal.targetAmount > 0
    ? Math.min(100, (goal.currentAmount / goal.targetAmount) * 100)
    : 0;
  const deadline = new Date(goal.deadline);
  const now = new Date();
  const daysRemaining = Math.max(
    0,
    Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  );
  return {
    ...goal,
    percentage,
    daysRemaining,
    isCompleted: goal.isCompleted || goal.currentAmount >= goal.targetAmount,
    createdAt: goal.createdAt.toISOString(),
  };
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, req.userId!));
    res.json(goals.map(enrichGoal));
  } catch (err) {
    logger.error({ err }, "List goals error");
    res.status(500).json({ error: "Failed to fetch goals" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, targetAmount, currentAmount, deadline, type, notes } = req.body;
    if (!name || !targetAmount || !deadline || !type) {
      res.status(400).json({ error: "name, targetAmount, deadline, type required" });
      return;
    }
    const [goal] = await db
      .insert(goalsTable)
      .values({
        userId: req.userId!,
        name,
        targetAmount: parseFloat(targetAmount),
        currentAmount: parseFloat(currentAmount ?? 0),
        deadline,
        type,
        notes,
      })
      .returning();
    res.status(201).json(enrichGoal(goal));
  } catch (err) {
    logger.error({ err }, "Create goal error");
    res.status(500).json({ error: "Failed to create goal" });
  }
});

router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, targetAmount, currentAmount, deadline, type, notes } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name) updates.name = name;
    if (targetAmount !== undefined) updates.targetAmount = parseFloat(targetAmount);
    if (currentAmount !== undefined) updates.currentAmount = parseFloat(currentAmount);
    if (deadline) updates.deadline = deadline;
    if (type) updates.type = type;
    if (notes !== undefined) updates.notes = notes;

    const [goal] = await db
      .update(goalsTable)
      .set(updates)
      .where(and(eq(goalsTable.id, id), eq(goalsTable.userId, req.userId!)))
      .returning();

    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    res.json(enrichGoal(goal));
  } catch (err) {
    logger.error({ err }, "Update goal error");
    res.status(500).json({ error: "Failed to update goal" });
  }
});

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(goalsTable).where(and(eq(goalsTable.id, id), eq(goalsTable.userId, req.userId!)));
    res.json({ success: true, message: "Goal deleted" });
  } catch (err) {
    logger.error({ err }, "Delete goal error");
    res.status(500).json({ error: "Failed to delete goal" });
  }
});

export default router;
