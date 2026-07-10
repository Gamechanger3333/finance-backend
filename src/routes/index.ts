import { Router } from "express";
import authRouter from "./auth.js";
import dashboardRouter from "./dashboard.js";
import transactionsRouter from "./transactions.js";
import budgetsRouter from "./budgets.js";
import goalsRouter from "./goals.js";
import categoriesRouter from "./categories.js";
import aiRouter from "./ai.js";
import notificationsRouter from "./notifications.js";
import recurringBillsRouter from "./recurring-bills.js";
import cashflowForecastRouter from "./cashflow-forecast.js";
import debtsRouter from "./debts.js";
import savingsRulesRouter from "./savings-rules.js";
import reportsRouter from "./reports.js";
import householdRouter from "./household.js";
import bankSyncRouter from "./bank-sync.js";

const router = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.use("/auth", authRouter);
router.use("/dashboard", dashboardRouter);
router.use("/transactions", transactionsRouter);
router.use("/budgets", budgetsRouter);
router.use("/goals", goalsRouter);
router.use("/categories", categoriesRouter);
router.use("/ai", aiRouter);
router.use("/notifications", notificationsRouter);
router.use("/recurring-bills", recurringBillsRouter);
router.use("/cashflow-forecast", cashflowForecastRouter);
router.use("/debts", debtsRouter);
router.use("/savings-rules", savingsRulesRouter);
router.use("/reports", reportsRouter);
router.use("/household", householdRouter);
router.use("/bank-sync", bankSyncRouter);

export default router;
