import { Router } from "express";
import { db, notificationsTable } from "../db/index.js";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const notifs = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, req.userId!))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(20);
    res.json(notifs.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })));
  } catch (err) {
    logger.error({ err }, "List notifications error");
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.patch("/:id/read", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const [notif] = await db
      .update(notificationsTable)
      .set({ isRead: true })
      .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, req.userId!)))
      .returning();
    if (!notif) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.json({ ...notif, createdAt: notif.createdAt.toISOString() });
  } catch (err) {
    logger.error({ err }, "Mark notification read error");
    res.status(500).json({ error: "Failed to update notification" });
  }
});

export default router;
