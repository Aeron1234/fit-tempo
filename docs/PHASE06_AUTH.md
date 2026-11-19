# Phase 06 local auth verification

The local Phase 06 gate passed on November 17, 2026 using a user-run disposable migrated PostgreSQL database and the injected mailbox. The commands below reproduce that check. Do not use a production database or real mailbox for this procedure. Live delivery, shared limits and deployment cookie behavior have separate later-phase gates.

From the project root, with working npm registry access:

```powershell
npm.cmd install
npm.cmd ci
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

For the integration test, put `TEST_DATABASE_URL=postgresql://.../fit_tempo_phase05_test` in an ignored `apps/api/.env.test.local` file (or another **disposable**, already migrated database). Do not point it at production or a database with important data. The test creates a unique fictional account and removes it afterward. After the normal build, run from the root:

```powershell
npm.cmd run build --workspace @fit-tempo/api
node --env-file=apps/api/.env.test.local --test apps/api/test/auth.integration.mjs
```

The test asserts scanner-safe GETs, one-use verification/reset, pre-auth CSRF/Origin, trainee admin rejection, two-tab and lost-response refresh recovery, expired-access refresh/logout, server revocation and password reset. It uses the injected in-memory mailbox and sends no external email. Additional security review remains necessary before public exposure.

Use a disposable database with migrations 001–004 applied. In `apps/api/.env.local`, set `DATABASE_URL`, independent random `JWT_ACCESS_SECRET` and `CSRF_SECRET` values of at least 32 characters, `FRONTEND_URL=http://localhost:5173`, `EMAIL_ADAPTER=test-mailbox`, and local mode. Keep secrets out of source, terminal transcripts and frontend variables. The in-memory mailbox is injected by the API when auth is configured; there is no public mailbox route. A local integration test must inject and inspect its messages in the same process. Production configuration must reject this mailbox.

Required HTTP/database scenarios before closing the gate:

1. Obtain `GET /api/v1/auth/csrf`; use its returned token and cookie with the exact configured Origin on each unsafe request. Missing/wrong Origin or token returns 403. Check login, refresh, logout and account changes.
2. Register a fictional trainee; inspect the injected mailbox in process. GET the verification link and its API GET counterpart without consuming the token. POST the token once to verify; a second POST fails. Unverified login and client-provided admin role must fail.
3. Login and check HttpOnly cookies, `/me`, trainee denial at `/admin-check`, and role/status from the current database. Suspend or revoke the session in PostgreSQL and confirm the very next `/me` request rejects a copied unexpired access cookie.
4. Refresh concurrently from two simulated tabs with the same old cookie and CSRF token. Both should recover the same successor within the documented 10-second grace without revoking the session. Simulate a lost first response and retry the old cookie within grace. Test replay beyond grace and expired access with a valid refresh/CSRF token. Check logout with expired access revokes the server session.
5. Request recovery for an existing and nonexistent fictional email; responses must be indistinguishable. GET the recovery link without consuming it. POST a valid token once to change the password and revoke all sessions; reuse fails. The old password and copied session cookies must fail.
6. Verify the configured production mode refuses the test mailbox. No actual EmailJS or authorized external inbox delivery is implied; that belongs to Phase 21.

The current executor cannot reach its npm registry (`ENOTFOUND`) or local PostgreSQL TCP listener (Windows 10013), so these cases have not been run here. Do not claim this checklist as test results.
