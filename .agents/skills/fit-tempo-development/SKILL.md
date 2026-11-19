---
name: fit-tempo-development
description: Implement, continue, review, and hand off Fit Tempo phases using the project architecture, phase assignments, security rules, and implementation status. Use for Fit Tempo implementation, phase continuation, review, and handoff tasks.
---

# Fit Tempo development

Resolve the project root three directories above this file. Read applicable ancestor/root/nested AGENTS.md instructions, [ARCHITECTURE.md](../../../ARCHITECTURE.md) completely and [implementation status](../../../docs/IMPLEMENTATION_STATUS.md) before changes. Resolve architecture paths against the root. Keep the architecture authoritative. Reuse this skill after bootstrap without recursively recreating it.

## Phase workflow

Act as lead implementation agent for Fit Tempo, this pure WEB fitness and nutrition portfolio app. Preserve the exact display name Fit Tempo in UI, email templates, documentation and portfolio materials; use fit-tempo for technical slugs and project/package names. Read this complete architecture, repository instructions and docs/IMPLEMENTATION_STATUS.md before changes. Use React/TypeScript/Vite, React Router, TanStack Query, Zustand for UI only, shadcn/ui/Tailwind, React Hook Form/Zod, Recharts/Lucide, Express/TypeScript, PostgreSQL, session-backed JWT HttpOnly cookies, express-rate-limit with Redis, backend EmailJS, and Gemini behind explicit data/audience gates. Frontend and Express deploy on Vercel. Do not introduce React Native, Expo, guest SQLite, Supabase Auth, or a microservice architecture.

Implement both required twists: Pantry and Budget Meal Planner and Fit My Week. Preserve unknown prices/nutrients, food-specific unit conversion, historical nutrient snapshots, deterministic cost/scheduling rules, curated shorter workouts, confirmation before save/reschedule/deduction, revisions and idempotency. No AI-generated numbers replace verified calculations or missing data. AI suggestions remain editable and require confirmation; synthetic images/profiles for free-tier development, no hidden personal health data uploads.

Implement notification preferences and PostgreSQL jobs/logs under Section 16. Cron requires CRON_SECRET, independent of user login/browser activity. Never use node-cron or in-memory timers for scheduled emails. Hobby daily mode cannot fulfill arbitrary intraday reminders; label/disable unsupported controls. Respect timezone/DST, quiet hours, opt-outs, actual activity, leases, uniqueness, per-provider pacing and expiry. EmailJS acceptance is not inbox delivery; unknown external-send outcomes cannot be blindly retried or claimed exactly-once. Essential account emails are event-driven and remain separate from optional reminder opt-outs.

Apply the transaction contracts in Section 6.1 and the phase dependencies and evidence rules in Section 13.1. Execute the phase requested, sequentially respecting prerequisites. Spawn exactly the listed subagent count when capacity allows, excluding you; max three, no recursive delegation. Define owned paths/contracts and no overlapping edits; reviewers are read-only until assigned fixes. If agents are unavailable, execute roles sequentially and report honestly. You integrate and verify all work. Do not claim completed phases from the old manga/anime project.

Update docs/IMPLEMENTATION_STATUS.md after each phase with deliverables, decisions, actual checks/results, mocked-versus-live evidence and blockers. Test business boundaries rather than trivial mirror tests: ownership/admin access, CSRF/session revocation/refresh race, nutrition basis, missing data, budget arithmetic, schedule conflicts, duplicate confirmations, notification DST/leases/send ambiguity, provider quotas and private file access. No real test emails without authorized recipients.

Always review and update the repository-root AGENTS.md at the end of every implementation phase and before handing work back, including partial or blocked phases. Read existing root and applicable nested AGENTS.md instructions before starting. If the root file is absent, create it; use the conventional uppercase filename AGENTS.md rather than creating a second differently cased agents.md file. Preserve existing valid instructions and user-authored content; make targeted edits instead of replacing the file wholesale.

Keep AGENTS.md concise and current: project purpose/stack, repository layout, verified setup/build/test commands, durable architectural decisions, security/data-handling rules, known constraints, and a brief current-phase/next-action handoff linking to docs/IMPLEMENTATION_STATUS.md. Update it whenever these facts change; if a phase changes no durable guidance, refresh the concise phase/handoff reference without inventing new rules. Keep detailed progress, command output, test evidence and chronological history in IMPLEMENTATION_STATUS.md. Never include credentials, tokens, personal health data, unverified commands, or claims that blocked work passed. The lead owns AGENTS.md edits after collecting subagent handoffs, avoiding concurrent edits. A phase is not ready for handoff until both documentation files have been reviewed and brought up to date.

Continue unblocked local work; never invent credentials, service quotas, real delivery or deployment success. Preserve unrelated files. Do not provision paid services, grant privileges, or publish production without applicable authorization. Finish a concrete reviewable release candidate before any final publication decision. Stop at a requested phase boundary and report outcome and remaining work.

## Setup and continuation

Follow Section 8.1 for Phase 03 Vite React/TypeScript setup, root npm workspaces and one lockfile, aliases, compatible Tailwind/shadcn integration, Fast Refresh and same-origin API proxy checks. Inspect actual files and verify commands before documenting them.

Follow Section 6.1 for schedule/pantry revision locks, atomic retry receipts, relationship ownership, historical snapshots and day completion/missing-data semantics. Follow Section 13.1 for local account-email verification before live integration and transactional reminder cancellation before dispatch.

When architecture changes, update affected skill guidance and AGENTS.md in the same handoff. Explicitly read this skill if automatic discovery is unavailable and record the limitation. Stop at the requested phase boundary.
