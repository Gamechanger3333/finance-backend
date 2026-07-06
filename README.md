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
| POST | `/api/auth/register` | ❌ | Register (sends verification email, does NOT log in) |
| POST | `/api/auth/login` | ❌ | Login → JWT (blocked with 403 if email unverified) |
| POST | `/api/auth/verify-email` | ❌ | Verify via `{ token }` (link) or `{ email, otp }` (code) → JWT |
| POST | `/api/auth/resend-verification` | ❌ | Resend verification email `{ email }` |
| POST | `/api/auth/forgot-password` | ❌ | Send password reset email `{ email }` |
| POST | `/api/auth/reset-password` | ❌ | Reset via `{ token, newPassword }` or `{ email, otp, newPassword }` |
| POST | `/api/auth/logout` | ✅ | Logout |
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

# Email (Resend) — required for verification + password reset emails
RESEND_API_KEY=your-resend-api-key-here
EMAIL_FROM="FinFlow <onboarding@resend.dev>"
FRONTEND_URL=http://localhost:3000
```

#### Getting a free Resend API key (no domain required)

1. Go to https://resend.com and sign up for free (100 emails/day, 3,000/month).
2. Go to **API Keys** → **Create API Key** → copy it into `RESEND_API_KEY`.
3. Leave `EMAIL_FROM` as `FinFlow <onboarding@resend.dev>` — this is Resend's shared
   sandbox sender, which lets you send real emails to **any inbox** without owning
   or verifying a custom domain. (Once you buy a domain later, verify it in Resend
   and switch `EMAIL_FROM` to your own address, e.g. `FinFlow <noreply@yourdomain.com>`.)

### 3. Create database & run migrations

```bash
# Create DB (if needed)
createdb finflow

# Push schema to DB (adds the new verification/reset columns)
npm run db:push

# Seed with default categories + demo user (pre-verified)
npm run db:seed
```

### 4. Run in dev mode

```bash
npm run dev
# Backend runs on http://localhost:3001
```

## Auth Flow

- **Register** → account created as unverified → verification email sent (contains both
  a clickable link and a 6-digit code) → user must verify before they can log in.
- **Login** while unverified → `403` with `requiresVerification: true` → frontend
  redirects to `/verify-email`.
- **Verify email** → either click the emailed link, or enter the 6-digit code →
  account marked verified → JWT issued automatically.
- **Forgot password** → emailed link + 6-digit code (15 min expiry) → `/reset-password`
  accepts either the token (from the link) or email+otp to set a new password.
- All codes/tokens are stored as SHA-256 hashes (never plaintext) and expire in 15
  minutes. OTPs lock out after 5 wrong attempts per challenge.

## Demo Account

After seeding:
- **Email:** demo@finflow.com  
- **Password:** Demo@1234
- (Pre-verified — no email step needed for the demo account.)

## Production Build

```bash
npm run build
npm start
```
