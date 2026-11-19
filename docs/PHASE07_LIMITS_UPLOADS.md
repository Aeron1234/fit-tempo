# Phase 07 limits and private uploads

Phase 07 is partially implemented. The local limiter uses separate Redis namespaces for coarse IP, API user, login IP/account, search, AI and email windows. When `REDIS_URL` is configured with auth, the API connects to Redis and applies coarse/API limits plus login and account-email limits. Redis store errors must return a controlled 503, not a false 429. Production still fails closed until live adapters are configured.

The dependencies are installed and root typecheck/lint/build pass. The synthetic storage test passed. The user ran the two-instance Redis integration test successfully against their Upstash development database on November 17, 2026. This executor still receives `ENOTFOUND` for that host. The test accepts `TEST_REDIS_URL` or falls back to `REDIS_URL` from the ignored local API env file; use only a development Redis instance.

The storage service has injected metadata and private object interfaces. It authorizes a two-minute grant, validates JPEG/PNG/WebP signature and decoded dimensions, re-encodes without metadata, bounds size/pixels and grants reads only for an owned ready record. `database/migrations/005_private_upload_expiry.sql` persists pending expiry; `apps/api/src/storage-pg.ts` scopes metadata operations to user and uses conditional transitions. File routes exist inside the auth router only when a private storage service is injected. **No concrete private object adapter is configured**, so these routes are not enabled in the app. No live private bucket, signing policy or deletion guarantee is claimed.

## Local verification after dependency installation

From the root, install the declared packages and apply migration 005 to a disposable database. Use a **development Redis instance** for the limits test. Put `TEST_REDIS_URL` in an ignored `apps/api/.env.test.local`, or use the existing `REDIS_URL` in `apps/api/.env.local`, without sharing its value. Run:

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run test:storage --workspace @fit-tempo/api
node --env-file=apps/api/.env.local --test apps/api/test/limits.integration.mjs
```

The storage test uses an injected fake private object adapter and harmless invalid SVG bytes, not a real bucket. It checks owner hiding, signature mismatch, oversize declarations, expiry, re-encoding and a bounded timeout. The limits test creates two Express instances with separate clients against one Redis service, expecting the sixth account request to return 429 after five allowed requests and a store outage to return 503. Test code cannot establish production bucket privacy or provider policy.

## Remaining gate

- Install dependencies and update the single root lockfile; pass typecheck/build and the above tests.
- Shared counters and fail-closed store outage passed in the user-run test with two independently created clients and API instances.
- Implement a private object adapter with exact upload size/MIME policy, short-lived signed grants, bounded reads, private signed access and deletion. Verify malicious/oversized uploads, owner-only reads, expiry and timeouts through authenticated CSRF-protected HTTP routes.
- Persist object-deletion retry work. A failed removal after a metadata state change can leave orphaned bytes; best-effort cleanup is not a deletion guarantee.
- Verify a trusted proxy configuration at deployment; never trust arbitrary forwarded IP headers.

Do not enable public uploads or claim the Section 13 Phase 07 gate until those checks pass. Phase 08 remains pending.

## November 17 private-storage continuation

The user applied migration 005 on the disposable PostgreSQL database. Source now includes an S3-compatible private adapter (`apps/api/src/storage-s3.ts`), explicitly configured through backend-only storage region/bucket/key variables, a transactionally queued PostgreSQL deletion intent in migration `006_private_object_deletions.sql`, and a bounded manual maintenance runner (`apps/api/src/storage-maintenance.ts`). Routes remain disabled without all required configuration; canonical paths are `/api/v1/me/uploads/authorize`, `/api/v1/me/uploads/:id/finalize`, `/api/v1/me/files/:id/access`, and DELETE `/api/v1/me/files/:id`. The adapter's signed POST constrains MIME and size, and its short GET links only expose re-encoded private objects after ownership checks. Verify the bucket's public-access-block policy independently before enabling it.

The new `apps/api/test/storage.http.integration.mjs` uses fictional accounts, an injected mailbox, disposable PostgreSQL and fake private objects for CSRF/ownership/malicious content/expiry/deadline/revocation checks. It needs `TEST_DATABASE_URL` in the ignored test env file and a network-capable local terminal. Run from the root after applying migration 006 and installing dependencies:

```powershell
npm install
npm run typecheck
npm run lint
npm run build
node --env-file=apps/api/.env.test.local --test apps/api/test/storage.http.integration.mjs
npm run test:storage --workspace @fit-tempo/api
node --env-file=apps/api/.env.local apps/api/dist/storage-maintenance.js
```

The last command requires a configured private test bucket and DB, and performs bounded deletion work; run it only against disposable objects. Migration 006 must be applied with `database/migrate.ps1` as for migration 005. After the user's npm install, the SDK stream type was corrected; root typecheck/lint/build and the updated synthetic storage test pass. Executor loopback blocks the HTTP test (`EACCES`). A failure of both PostgreSQL insertion and immediate object removal after an object write can leave an orphan; reconcile bucket keys operationally. Phase 07 is open pending migration 006, HTTP test and real bucket policy/grants/reads/deletion retry evidence; stop before Phase 08.

## Supabase private Storage selection

Supabase Storage is the selected Phase 07 provider. Set `STORAGE_PROVIDER=supabase`, the project's direct HTTPS S3 endpoint (`https://<project-ref>.storage.supabase.co/storage/v1/s3`), the region/bucket and **server-only** S3 access key pair in the ignored backend environment. Leave these unset until a disposable private bucket is ready. The bucket must restrict maximum file size to **2 MiB** and allowed MIME types to **image/jpeg, image/png, image/webp**. The keys bypass Supabase RLS; never use them in the frontend. Keep the existing PostgreSQL auth/metadata database; Supabase is for private objects only.

Supabase compatibility documentation does not establish the AWS signed POST policy used by the previous adapter. Fit Tempo now returns a same-origin PUT grant at `/api/v1/me/uploads/:id/content` and enforces current session, CSRF, ownership, exact MIME, signature, 2 MiB bytes and two-minute expiry in Express before backend PutObject. Finalization validates/re-encodes into a private ready key capped at 2 MiB, and owned access yields a 30-second signed GET. No live Supabase upload or policy check has passed yet. `node --test apps/api/test/storage.supabase.integration.mjs` passes with fake objects; the updated PostgreSQL-backed HTTP test and migration 006 still require local execution. A signed GET already issued is a bearer URL until its expiry; do not promise immediate URL revocation.
## Final verification
Phase 07 is complete. User-run live Supabase size and MIME checks and the simulated provider deadline test both passed. See the implementation status for the combined Redis, PostgreSQL, and live storage evidence.
