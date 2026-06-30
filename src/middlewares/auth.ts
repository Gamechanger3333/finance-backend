import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.SESSION_SECRET;

// Startup check — fail fast if secret is missing
if (!JWT_SECRET) {
  console.error("FATAL: SESSION_SECRET environment variable is not set.");
  process.exit(1);
}

export interface AuthRequest extends Request {
  userId?: number;
}

export function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET as string) as { userId: number; iat: number };
    req.userId = payload.userId;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "Token expired, please log in again" });
    } else {
      res.status(401).json({ error: "Invalid token" });
    }
  }
}

export function signToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET as string, { expiresIn: "7d" });
}