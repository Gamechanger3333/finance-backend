import { Router } from "express";
import authRouter from "./auth.js";
import dashboardRouter from "./dashboard.js";
import transactionsRouter from "./transactions.js";
import budgetsRouter from "./budgets.js";
import goalsRouter from "./goals.js";
import categoriesRouter from "./categories.js";
import aiRouter from "./ai.js";
import notificationsRouter from "./notifications.js";

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

export default router;
