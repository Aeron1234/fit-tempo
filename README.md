# Fit Tempo

Fit Tempo is a responsive web app for planning meals, tracking nutrition and workouts, and adjusting your schedule when plans change.

## What you can do

- **Pantry and Budget Meal Planner** suggests meals from your pantry and budget. It distinguishes the cost of the ingredients you use from the cost of buying whole packages and shows where prices are missing.
- **Fit My Week** helps you find another slot for a missed workout or choose a shorter routine that fits. You review the proposed change before confirming it.
- **Track meals and movement** with manual or barcode-assisted food logging, recipes, workout sets and timers, activity, body measurements, and hydration.
- **Review your progress** with weekly metrics that show gaps in logging alongside recorded values.

## Staging

The [Fit Tempo staging frontend](https://fit-tempo-web-staging.vercel.app/) is hosted on Vercel. API-backed features are still undergoing staging verification. The [staging runbook](docs/PHASE26_VERCEL_STAGING.md) covers the deployment, health checks, and current startup issue.

### AI food recognition

Gemini is disabled on staging. The current adapter accepts approved sample images in local synthetic-demo mode. The deployed API uses local mode with EmailJS, which is incompatible with that adapter. A Gemini API key alone does not enable real-photo analysis. Barcode lookup and manual meal entry remain available when AI is off.

## Run locally

Use Node.js 24, npm 12, and PostgreSQL.

1. Run `npm ci` from the repository root.
2. Create a local PostgreSQL database and apply the ordered migrations. Follow the [PostgreSQL setup guide](docs/PHASE05_POSTGRES.md).
3. Copy `apps/api/.env.example` and `apps/web/.env.example` to `.env.local` in their respective directories. Set the API database URL and local auth secrets. Keep provider credentials in the API environment. See the [EmailJS guide](docs/PHASE21_EMAILJS.md) if you need to test with a real inbox.
4. Run `npm run dev:api` and `npm run dev:web` in separate terminals from the root. Open [http://localhost:5173](http://localhost:5173).

Run `npm run typecheck`, `npm run lint`, `npm run test:contracts`, and `npm run build` for the main project checks.

## Project structure

| Directory | Contents |
| --- | --- |
| `apps/web` | React, TypeScript, Vite, Tailwind and shadcn/ui frontend |
| `apps/api` | Express and TypeScript API with PostgreSQL and Redis-backed limits |
| `packages/contracts` | Shared validation schemas and domain contracts |
| `database/migrations` | Ordered PostgreSQL migrations |

[Architecture](ARCHITECTURE.md) · [Implementation status](docs/IMPLEMENTATION_STATUS.md)
