import { Router } from "express";
import { db, categoriesTable } from "../db/index.js";
import { eq, or } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const cats = await db
      .select()
      .from(categoriesTable)
      .where(or(eq(categoriesTable.isDefault, true), eq(categoriesTable.userId, req.userId!)));
    res.json(cats);
  } catch (err) {
    logger.error({ err }, "List categories error");
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { name, icon, type, color } = req.body;
    if (!name || !type) {
      res.status(400).json({ error: "name and type required" });
      return;
    }
    const [cat] = await db
      .insert(categoriesTable)
      .values({ name, icon: icon || "circle", type, color: color || "#6366f1", isDefault: false, userId: req.userId! })
      .returning();
    res.status(201).json(cat);
  } catch (err) {
    logger.error({ err }, "Create category error");
    res.status(500).json({ error: "Failed to create category" });
  }
});

export default router;
