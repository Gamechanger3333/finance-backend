import "dotenv/config";
import cron from "node-cron";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { runDailyMaintenanceSweep } from "./lib/scheduler.js";

const port = Number(process.env.PORT || 3001);

app.listen(port, () => {
  logger.info({ port }, "FinFlow backend listening");
});

// Daily maintenance sweep (recurring-bill auto-pay + per-user notification
// checks) at 06:00 server time. Runs once at startup too, so anything due
// while the server was down still gets caught on the next boot rather than
// waiting a full day.
const AUTO_PAY_CRON = process.env.RECURRING_AUTO_PAY_CRON || "0 6 * * *";

async function runSweep() {
  try {
    await runDailyMaintenanceSweep();
  } catch (err) {
    logger.error({ err }, "Daily maintenance sweep failed");
  }
}

cron.schedule(AUTO_PAY_CRON, runSweep);
runSweep();
