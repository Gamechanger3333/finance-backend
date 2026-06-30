# FinFlow Backend

Express + TypeScript + PostgreSQL + Drizzle ORM backend for FinFlow.

## Stack

- **Express 4** (REST API)
- **TypeScript** + **tsx** (dev runner)
- **Drizzle ORM** + **PostgreSQL**
- **bcryptjs** (password hashing)
- **jsonwebtoken** (JWT auth)
- **Groq SDK** (AI — Llama 3.3)
- **Pino** (logging)

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | ❌ | Register |
| POST | `/api/auth/login` | ❌ | Login → JWT |
| GET | `/api/auth/me` | ✅ | Current user |
| PUT | `/api/auth/profile` | ✅ | Update profile |
| GET | `/api/dashboard/summary` | ✅ | Financial overview |
| GET | `/api/dashboard/recent-transactions` | ✅ | Last 10 transactions |
| GET | `/api/transactions` | ✅ | List all |
| POST | `/api/transactions` | ✅ | Create |
| DELETE | `/api/transactions/:id` | ✅ | Delete |
| GET | `/api/budgets` | ✅ | List with progress |
| POST | `/api/budgets` | ✅ | Create |
| DELETE | `/api/budgets/:id` | ✅ | Delete |
| GET | `/api/goals` | ✅ | List |
| POST | `/api/goals` | ✅ | Create |
| PATCH | `/api/goals/:id` | ✅ | Update (add funds) |
| DELETE | `/api/goals/:id` | ✅ | Delete |
| GET | `/api/categories` | ✅ | List |
| GET | `/api/notifications` | ✅ | List |
| GET | `/api/ai/insights` | ✅ | AI insights |
| POST | `/api/ai/chat` | ✅ | AI chat |
| GET | `/api/healthz` | ❌ | Health check |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in:

```env
PORT=3001
DATABASE_URL=postgresql://postgres:password@localhost:5432/finflow
SESSION_SECRET=your-super-secret-jwt-key-change-this
GROQ_API_KEY=your-groq-api-key-here   # get free key at console.groq.com
```

### 3. Create database & run migrations

```bash
# Create DB (if needed)
createdb finflow

# Push schema to DB
npm run db:push

# Seed with default categories + demo user
npm run db:seed
```

### 4. Run in dev mode

```bash
npm run dev
# Backend runs on http://localhost:3001
```

## Demo Account

After seeding:
- **Email:** demo@finflow.com  
- **Password:** Demo@1234

## Production Build

```bash
npm run build
npm start
```
