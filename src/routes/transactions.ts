import { Router, Response } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 100;

function isPositiveNumber(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

async function isCategoryUsableByUser(categoryId: number, userId: number): Promise<boolean> {
  const cat = await prisma.category.findFirst({
    where: { id: categoryId, OR: [{ isDefault: true }, { userId }] },
    select: { id: true },
  });
  return !!cat;
}

function serializeTx(tx: any) {
  return {
    ...tx,
    categoryName: tx.category?.name ?? "Unknown",
    categoryIcon: tx.category?.icon ?? "circle",
    createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : tx.createdAt,
  };
}

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { type, search, startDate, endDate } = req.query as Record<string, string>;
    const limitParam = parseInt(req.query.limit as string);
    const offsetParam = parseInt(req.query.offset as string);
    const take = Number.isInteger(limitParam) ? Math.min(MAX_PAGE_SIZE, Math.max(1, limitParam)) : DEFAULT_PAGE_SIZE;
    const skip = Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

    const where: any = { userId: req.userId! };
    if (type === "income" || type === "expense") where.type = type;
    if (startDate) where.date = { ...(where.date ?? {}), gte: startDate };
    if (endDate) where.date = { ...(where.date ?? {}), lte: endDate };
    // Search is applied at the DB level (not after take/skip) so results aren't
    // silently limited to whichever page happened to be fetched.
    if (search) {
      where.OR = [
        { description: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
        { category: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const transactions = await prisma.transaction.findMany({
      where,
      include: { category: { select: { name: true, icon: true } } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take,
      skip,
    });

    res.json(transactions.map(serializeTx));
  } catch (err) {
    logger.error({ err }, "List transactions error");
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { type, amount, description, date, categoryId, notes } = req.body;

    if (type !== "income" && type !== "expense") { res.status(400).json({ error: "type must be 'income' or 'expense'" }); return; }
    if (!isPositiveNumber(amount)) { res.status(400).json({ error: "amount must be a positive number" }); return; }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "date is required in YYYY-MM-DD format" }); return; }
    const catId = parseInt(categoryId);
    if (!Number.isInteger(catId)) { res.status(400).json({ error: "categoryId is required" }); return; }
    if (!(await isCategoryUsableByUser(catId, req.userId!))) { res.status(400).json({ error: "Invalid category" }); return; }

    const tx = await prisma.transaction.create({
      data: { userId: req.userId!, type, amount: Number(amount), description: description || "", date, categoryId: catId, notes },
      include: { category: { select: { name: true, icon: true } } },
    });

    res.status(201).json(serializeTx(tx));
  } catch (err) {
    logger.error({ err }, "Create transaction error");
    res.status(500).json({ error: "Failed to create transaction" });
  }
});

router.get("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid transaction id" }); return; }

    const tx = await prisma.transaction.findFirst({
      where: { id, userId: req.userId! },
      include: { category: { select: { name: true, icon: true } } },
    });
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    res.json(serializeTx(tx));
  } catch (err) {
    logger.error({ err }, "Get transaction error");
    res.status(500).json({ error: "Failed to fetch transaction" });
  }
});

async function updateTransactionHandler(req: AuthRequest, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid transaction id" }); return; }
    const { type, amount, description, date, categoryId, notes } = req.body;
    const data: Record<string, any> = {};

    if (type !== undefined) {
      if (type !== "income" && type !== "expense") { res.status(400).json({ error: "type must be 'income' or 'expense'" }); return; }
      data.type = type;
    }
    if (amount !== undefined) {
      if (!isPositiveNumber(amount)) { res.status(400).json({ error: "amount must be a positive number" }); return; }
      data.amount = Number(amount);
    }
    if (description !== undefined) data.description = description;
    if (date !== undefined) data.date = date;
    if (categoryId !== undefined) {
      const catId = parseInt(categoryId);
      if (!Number.isInteger(catId) || !(await isCategoryUsableByUser(catId, req.userId!))) {
        res.status(400).json({ error: "Invalid category" }); return;
      }
      data.categoryId = catId;
    }
    if (notes !== undefined) data.notes = notes;

    const existing = await prisma.transaction.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Transaction not found" }); return; }

    const tx = await prisma.transaction.update({
      where: { id },
      data,
      include: { category: { select: { name: true, icon: true } } },
    });
    res.json(serializeTx(tx));
  } catch (err) {
    logger.error({ err }, "Update transaction error");
    res.status(500).json({ error: "Failed to update transaction" });
  }
}

router.patch("/:id", requireAuth, updateTransactionHandler);
router.put("/:id", requireAuth, updateTransactionHandler);

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid transaction id" }); return; }

    const existing = await prisma.transaction.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Transaction not found" }); return; }

    await prisma.transaction.delete({ where: { id } });
    res.json({ success: true, message: "Transaction deleted" });
  } catch (err) {
    logger.error({ err }, "Delete transaction error");
    res.status(500).json({ error: "Failed to delete transaction" });
  }
});

export default router;
