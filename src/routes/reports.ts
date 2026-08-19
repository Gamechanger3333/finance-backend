import { Router } from "express";
import PDFDocument from "pdfkit";
import prisma from "../db/index.js";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

function isValidDate(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v).getTime());
}

function resolveRange(req: AuthRequest): { startDate: string; endDate: string } | null {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  if (!isValidDate(startDate) || !isValidDate(endDate)) return null;
  return { startDate: startDate!, endDate: endDate! };
}

export async function buildSummary(userId: number, startDate: string, endDate: string) {
  const transactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: startDate, lte: endDate } },
    include: { category: { select: { name: true } } },
    orderBy: { date: "asc" },
  });

  let totalIncome = 0, totalExpenses = 0;
  const byCategory = new Map<string, { name: string; type: string; total: number; count: number }>();

  for (const tx of transactions as any[]) {
    if (tx.type === "income") totalIncome += tx.amount;
    else totalExpenses += tx.amount;

    const key = `${tx.type}:${tx.category?.name ?? "Uncategorized"}`;
    const entry = byCategory.get(key) ?? { name: tx.category?.name ?? "Uncategorized", type: tx.type, total: 0, count: 0 };
    entry.total += tx.amount;
    entry.count += 1;
    byCategory.set(key, entry);
  }

  return {
    startDate,
    endDate,
    totalIncome,
    totalExpenses,
    netIncome: totalIncome - totalExpenses,
    transactionCount: transactions.length,
    byCategory: Array.from(byCategory.values()).sort((a, b) => b.total - a.total),
    transactions,
  };
}

router.get("/summary", requireAuth, async (req: AuthRequest, res) => {
  try {
    const range = resolveRange(req);
    if (!range) { res.status(400).json({ error: "startDate and endDate are required in YYYY-MM-DD format" }); return; }

    const summary = await buildSummary(req.userId!, range.startDate, range.endDate);
    // Don't ship the full transaction list in the summary payload — the
    // export endpoints handle that; this is just for the on-screen preview.
    const { transactions, ...rest } = summary;
    res.json(rest);
  } catch (err) {
    logger.error({ err }, "Report summary error");
    res.status(500).json({ error: "Failed to build report summary" });
  }
});

router.get("/export.csv", requireAuth, async (req: AuthRequest, res) => {
  try {
    const range = resolveRange(req);
    if (!range) { res.status(400).json({ error: "startDate and endDate are required in YYYY-MM-DD format" }); return; }

    const { transactions } = await buildSummary(req.userId!, range.startDate, range.endDate);

    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = [["Date", "Type", "Category", "Description", "Amount"].join(",")];
    for (const tx of transactions as any[]) {
      rows.push([
        tx.date,
        tx.type,
        escape(tx.category?.name ?? "Uncategorized"),
        escape(tx.description ?? ""),
        tx.amount.toFixed(2),
      ].join(","));
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="transactions_${range.startDate}_to_${range.endDate}.csv"`);
    res.send(rows.join("\n"));
  } catch (err) {
    logger.error({ err }, "CSV export error");
    res.status(500).json({ error: "Failed to export CSV" });
  }
});

router.get("/export.pdf", requireAuth, async (req: AuthRequest, res) => {
  try {
    const range = resolveRange(req);
    if (!range) { res.status(400).json({ error: "startDate and endDate are required in YYYY-MM-DD format" }); return; }

    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { name: true } });
    const summary = await buildSummary(req.userId!, range.startDate, range.endDate);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="financial_statement_${range.startDate}_to_${range.endDate}.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    doc.pipe(res);

    doc.fontSize(20).fillColor("#0a0f0d").text("Financial Statement", { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#666").text(`${user?.name ?? "User"}  ·  ${range.startDate} to ${range.endDate}`);
    doc.moveDown(1);

    // Summary boxes
    doc.fontSize(12).fillColor("#0a0f0d");
    const summaryRows: [string, string][] = [
      ["Total Income", `$${summary.totalIncome.toFixed(2)}`],
      ["Total Expenses", `$${summary.totalExpenses.toFixed(2)}`],
      ["Net Income", `$${summary.netIncome.toFixed(2)}`],
      ["Transactions", `${summary.transactionCount}`],
    ];
    for (const [label, value] of summaryRows) {
      doc.font("Helvetica-Bold").text(`${label}: `, { continued: true }).font("Helvetica").text(value);
    }
    doc.moveDown(1);

    // Category breakdown
    doc.fontSize(14).font("Helvetica-Bold").text("By Category");
    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica");
    for (const cat of summary.byCategory) {
      const sign = cat.type === "income" ? "+" : "-";
      doc.text(`${cat.name} (${cat.type})`, { continued: true, width: 350 });
      doc.text(`${sign}$${cat.total.toFixed(2)}  (${cat.count})`, { align: "right" });
    }
    doc.moveDown(1);

    // Transaction ledger
    doc.fontSize(14).font("Helvetica-Bold").text("Transaction Detail");
    doc.moveDown(0.3);
    doc.fontSize(9).font("Helvetica");
    for (const tx of summary.transactions as any[]) {
      if (doc.y > 740) doc.addPage();
      const sign = tx.type === "income" ? "+" : "-";
      const label = `${tx.date}  ${tx.category?.name ?? "Uncategorized"}${tx.description ? " — " + tx.description : ""}`;
      doc.text(label, { continued: true, width: 400 });
      doc.text(`${sign}$${tx.amount.toFixed(2)}`, { align: "right" });
    }

    doc.moveDown(1.5);
    doc.fontSize(8).fillColor("#999").text(
      "This statement is generated from your recorded transactions for informational purposes and is not a substitute for professional tax advice.",
      { align: "left" }
    );

    doc.end();
  } catch (err) {
    logger.error({ err }, "PDF export error");
    if (!res.headersSent) res.status(500).json({ error: "Failed to export PDF" });
  }
});

export default router;
