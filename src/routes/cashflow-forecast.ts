import { Router } from "express";
import { requireAuth, AuthRequest } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { getCashflowForecast, checkAndNotifyOverdraftRisk } from "../lib/finance.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days ?? "30"), 10) || 30));

    // Lazy check — same pattern as recurring bill due-checks: run on read,
    // no cron needed at this scale.
    await checkAndNotifyOverdraftRisk(userId);

    const forecast = await getCashflowForecast(userId, days);
    res.json(forecast);
  } catch (err) {
    logger.error({ err }, "Cashflow forecast error");
    res.status(500).json({ error: "Failed to compute cash-flow forecast" });
  }
});

export default router;
