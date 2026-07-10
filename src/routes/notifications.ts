import { Router } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const notifs = await prisma.notification.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json(notifs.map((n: any) => ({ ...n, createdAt: n.createdAt.toISOString() })));
  } catch (err) {
    logger.error({ err }, "List notifications error");
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.patch("/:id/read", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid notification id" }); return; }

    const existing = await prisma.notification.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Notification not found" }); return; }

    const notif = await prisma.notification.update({ where: { id }, data: { isRead: true } });
    res.json({ ...notif, createdAt: notif.createdAt.toISOString() });
  } catch (err) {
    logger.error({ err }, "Mark notification read error");
    res.status(500).json({ error: "Failed to update notification" });
  }
});

router.patch("/read-all", requireAuth, async (req: AuthRequest, res) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.userId!, isRead: false }, data: { isRead: true } });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Mark all notifications read error");
    res.status(500).json({ error: "Failed to update notifications" });
  }
});

export default router;
