import { Router } from "express";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { MOCK_INSTITUTIONS, pickMockAccount, generateMockTransactions } from "../lib/bank-sync-mock.js";

const router = Router();

router.get("/institutions", requireAuth, async (_req: AuthRequest, res) => {
  // Stands in for Plaid Link's institution picker.
  res.json(MOCK_INSTITUTIONS.map((i) => i.name));
});

router.get("/connections", requireAuth, async (req: AuthRequest, res) => {
  try {
    const connections = await prisma.bankConnection.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
    });
    res.json(connections.map((c: any) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      lastSyncedAt: c.lastSyncedAt ? c.lastSyncedAt.toISOString() : null,
    })));
  } catch (err) {
    logger.error({ err }, "List bank connections error");
    res.status(500).json({ error: "Failed to fetch connections" });
  }
});

router.post("/connect", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { institutionName } = req.body;
    if (!institutionName || !MOCK_INSTITUTIONS.some((i) => i.name === institutionName)) {
      res.status(400).json({ error: "Invalid institution" });
      return;
    }
    const { accountName, accountMask } = pickMockAccount(institutionName);

    const connection = await prisma.bankConnection.create({
      data: { userId: req.userId!, institutionName, accountName, accountMask, status: "active" },
    });
    res.status(201).json({ ...connection, createdAt: connection.createdAt.toISOString(), lastSyncedAt: null });
  } catch (err) {
    logger.error({ err }, "Connect bank error");
    res.status(500).json({ error: "Failed to connect bank account" });
  }
});

router.post("/:id/sync", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid connection id" }); return; }

    const connection = await prisma.bankConnection.findFirst({ where: { id, userId: req.userId! } });
    if (!connection) { res.status(404).json({ error: "Connection not found" }); return; }
    if (connection.status !== "active") { res.status(400).json({ error: "This connection is not active" }); return; }

    const mockTx = generateMockTransactions(connection.id);

    // Resolve category names to this user's usable categories (default or
    // their own), falling back to "Other" if nothing matches.
    const categoryNames = Array.from(new Set(mockTx.map((t) => t.categoryName)));
    const categories = await prisma.category.findMany({
      where: { name: { in: categoryNames }, OR: [{ isDefault: true }, { userId: req.userId! }] },
    });
    const fallback = await prisma.category.findFirst({ where: { isDefault: true, type: "expense" } });
    const categoryByName = new Map<string, number>(categories.map((c: any) => [c.name, c.id]));

    let imported = 0;
    for (const t of mockTx) {
      const categoryId = categoryByName.get(t.categoryName) ?? fallback?.id;
      if (!categoryId) continue;

      try {
        await prisma.$transaction([
          prisma.bankSyncTransaction.create({
            data: { bankConnectionId: connection.id, externalId: t.externalId },
          }),
          prisma.transaction.create({
            data: {
              userId: req.userId!,
              type: t.type,
              amount: t.amount,
              description: t.description,
              date: t.date,
              categoryId,
              source: "bank_sync",
            },
          }),
        ]);
        imported++;
      } catch {
        // Unique constraint hit (already imported this externalId) — skip.
        continue;
      }
    }

    const updated = await prisma.bankConnection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });

    if (imported > 0) {
      await prisma.notification.create({
        data: {
          userId: req.userId!,
          title: "Bank sync complete",
          message: `Imported ${imported} new transaction${imported === 1 ? "" : "s"} from ${connection.institutionName} ${connection.accountName}.`,
          type: "info",
        },
      });
    }

    res.json({ imported, connection: { ...updated, createdAt: updated.createdAt.toISOString(), lastSyncedAt: updated.lastSyncedAt.toISOString() } });
  } catch (err) {
    logger.error({ err }, "Bank sync error");
    res.status(500).json({ error: "Failed to sync transactions" });
  }
});

router.delete("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid connection id" }); return; }

    const existing = await prisma.bankConnection.findFirst({ where: { id, userId: req.userId! }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Connection not found" }); return; }

    await prisma.bankConnection.delete({ where: { id } });
    res.json({ success: true, message: "Bank connection removed" });
  } catch (err) {
    logger.error({ err }, "Disconnect bank error");
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

export default router;
