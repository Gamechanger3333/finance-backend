import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app = express();

// Behind a reverse proxy (Render/Railway/Nginx/etc.) — needed for correct
// client IPs in rate limiting and secure cookies.
app.set("trust proxy", 1);

// ─── Security headers ────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// ─── Global rate limit: 200 req / 15 min per IP ──────────────────────────────
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests from this IP, try again later" },
  })
);

// ─── Request logger ───────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  })
);

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10kb" }));        // reject huge payloads
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api", router);

// ─── 404 handler (JSON, not Express's default HTML page) ────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Catches anything that reaches next(err) — malformed JSON bodies from
// express.json(), and any error a route handler forgot to catch — and
// always responds with JSON instead of falling through to Express's
// default HTML error page.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) { next(err); return; }
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    res.status(400).json({ error: "Invalid JSON in request body" });
    return;
  }
  logger.error({ err }, "Unhandled error");
  res.status(err?.status || err?.statusCode || 500).json({ error: "Something went wrong" });
});

export default app;