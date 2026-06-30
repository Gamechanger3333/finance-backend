import { Router } from "express";
import { db, transactionsTable, categoriesTable } from "../db/index.js";
import { eq, and, desc, gte, lte } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const type = req.query.type as string | undefined;
    const search = req.query.search as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const conditions: ReturnType<typeof eq>[] = [eq(transactionsTable.userId, req.userId!)];
    if (type === "income" || type === "expense") conditions.push(eq(transactionsTable.type, type));
    if (startDate) conditions.push(gte(transactionsTable.date, startDate));
    if (endDate) conditions.push(lte(transactionsTable.date, endDate));

    const allRows = await db
      .select({
        id: transactionsTable.id,
        userId: transactionsTable.userId,
        type: transactionsTable.type,
        amount: transactionsTable.amount,
        description: transactionsTable.description,
        date: transactionsTable.date,
        categoryId: transactionsTable.categoryId,
        categoryName: categoriesTable.name,
        categoryIcon: categoriesTable.icon,
        notes: transactionsTable.notes,
        createdAt: transactionsTable.createdAt,
      })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(and(...conditions))
      .orderBy(desc(transactionsTable.date), desc(transactionsTable.createdAt));

    const filtered = search
      ? allRows.filter((r) =>
          `${r.description} ${r.categoryName}`.toLowerCase().includes(search.toLowerCase())
        )
      : allRows;

    const data = filtered.map((r) => ({
      ...r,
      categoryName: r.categoryName ?? "Unknown",
      categoryIcon: r.categoryIcon ?? "circle",
      createdAt: r.createdAt.toISOString(),
    }));

    res.json(data);
  } catch (err) {
    logger.error({ err }, "List transactions error");
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { type, amount, description, date, categoryId, notes } = req.body;
    if (!type || !amount || !date || !categoryId) {
      res.status(400).json({ error: "type, amount, date, categoryId required" });
      return;
    }
    const [tx] = await db
      .insert(transactionsTable)
      .values({
        userId: req.userId!,
        type,
        amount: parseFloat(amount),
        description: description || "",
        date,
        categoryId: parseInt(categoryId),
        notes,
      })
      .returning();

    const [cat] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.id, tx.categoryId))
      .limit(1);

    res.status(201).json({
      ...tx,
      categoryName: cat?.name ?? "Unknown",
      categoryIcon: cat?.icon ?? "circle",
      createdAt: tx.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Create transaction error");
    res.status(500).json({ error: "Failed to create transaction" });
  }
});

router.get("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db
      .select({
        id: transactionsTable.id,
        userId: transactionsTable.userId,
        type: transactionsTable.type,
        amount: transactionsTable.amount,
        description: transactionsTable.description,
        date: transactionsTable.date,
        categoryId: transactionsTable.categoryId,
        categoryName: categoriesTable.name,
        categoryIcon: categoriesTable.icon,
        notes: transactionsTable.notes,
        createdAt: transactionsTable.createdAt,
      })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(and(eq(transactionsTable.id, id), eq(transactionsTable.userId, req.userId!)))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }
    res.json({
      ...row,
      categoryName: row.categoryName ?? "Unknown",
      categoryIcon: row.categoryIcon ?? "circle",
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Get transaction error");
    res.status(500).json({ error: "Failed to fetch transaction" });
  }
});

router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const { type, amount, description, date, categoryId, notes } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (type) updates.type = type;
    if (amount !== undefined) updates.amount = parseFloat(amount);
    if (description) updates.description = description;
    if (date) updates.date = date;
    if (categoryId) updates.categoryId = parseInt(categoryId);
    if (notes !== undefined) updates.notes = notes;

    const [tx] = await db
      .update(transactionsTable)
      .set(updates)
      .where(and(eq(transactionsTable.id, id), eq(transactionsTable.userId, req.userId!)))
      .returning();

    if (!tx) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }
    const [cat] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, tx.categoryId)).limit(1);
    res.json({ ...tx, categoryName: cat?.name ?? "Unknown", categoryIcon: cat?.icon ?? "circle", createdAt: tx.createdAt.toISOString() });
  } catch (err) {
    logger.error({ err }, "Update transaction error");
    res.status(500).json({ error: "Failed to update transaction" });
  }
});

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    await db
      .delete(transactionsTable)
      .where(and(eq(transactionsTable.id, id), eq(transactionsTable.userId, req.userId!)));
    res.json({ success: true, message: "Transaction deleted" });
  } catch (err) {
    logger.error({ err }, "Delete transaction error");
    res.status(500).json({ error: "Failed to delete transaction" });
  }
});

export default router;
