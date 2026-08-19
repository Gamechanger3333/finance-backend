import "dotenv/config";
import cron from "node-cron";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { runRecurringBillAutoPay } from "./lib/finance.js";

const port = Number(process.env.PORT || 3001);

app.listen(port, () => {
  logger.info({ port }, "FinFlow backend listening");
});

// Daily auto-pay sweep for recurring bills, at 06:00 server time — turns
// "recurring transactions" from a manual click into an actually scheduled
// job. Runs once at startup too, so a bill that came due while the server
// was down still gets caught on the next boot rather than waiting a full
// day.
const AUTO_PAY_CRON = process.env.RECURRING_AUTO_PAY_CRON || "0 6 * * *";

async function runAutoPaySweep() {
  try {
    const { processed } = await runRecurringBillAutoPay();
    if (processed > 0) logger.info({ processed }, "Recurring bill auto-pay sweep completed");
  } catch (err) {
    logger.error({ err }, "Recurring bill auto-pay sweep failed");
  }
}

cron.schedule(AUTO_PAY_CRON, runAutoPaySweep);
runAutoPaySweep();
