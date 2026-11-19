# Phase 05 PostgreSQL verification

Use an isolated, empty PostgreSQL database. These commands are for local PowerShell and PostgreSQL 18; adjust the binary path if needed. Do not connect the test script to production. The migration account needs schema creation rights; the eventual API runtime account should have narrower rights. Keep the password in your normal credential store or prompt, never in this document or a command argument.

```powershell
$pg = 'C:\Program Files\PostgreSQL\18\bin'
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '5432'
$env:PGUSER = 'postgres' # change to your migration role
& "$pg\createdb.exe" -w fit_tempo_phase05_test
.\database\migrate.ps1 -Database fit_tempo_phase05_test -Psql "$pg\psql.exe"
& "$pg\psql.exe" -X -w -d fit_tempo_phase05_test -c 'SELECT name, left(sha256,12) AS checksum_prefix, applied_at FROM schema_migrations ORDER BY name;'
```

Configure authentication locally so `-w` can connect without a prompt, or omit `-w` in a manual `psql` command to receive a password prompt. The script deliberately fails without noninteractive credentials. Re-run the migration script: every migration should say `Already applied`. Editing an applied file must fail its checksum comparison. A SQL error during a later migration must leave neither that migration's tables nor its ledger row. Do not reuse this empty database for application data.

Inspect the Phase 05 schema:

```sql
SELECT name FROM schema_migrations ORDER BY name;
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
  AND (tablename LIKE '%revision%' OR tablename IN ('operation_receipts','daily_tracking_status','scheduled_workouts','notification_jobs'))
  ORDER BY tablename, indexname;
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('operation_receipts'::regclass, 'notification_jobs'::regclass,
                  'daily_tracking_status'::regclass, 'meal_items'::regclass,
                  'workout_sessions'::regclass)
ORDER BY table_name, conname;
```

Run the automated integrity file after the migrations (the script rolls back its synthetic fixtures):

```powershell
& "$pg\psql.exe" -X -w -v ON_ERROR_STOP=1 -d fit_tempo_phase05_test -f .\database\verify\integrity.sql
```

For actual competing writes, open **two separate `psql` terminals** against that same test database. Insert a fictional user and its revision rows, then set the user UUID in the examples below. The verification script includes a synthetic test user inside a rollback transaction; it does not leave one behind. The two-terminal exercise therefore needs its own committed synthetic user. Use new UUIDs throughout.

```sql
INSERT INTO users(id,email,password_hash) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','phase05-only@example.invalid','test-only') ON CONFLICT DO NOTHING;
INSERT INTO schedule_revisions(user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ON CONFLICT DO NOTHING;
INSERT INTO pantry_revisions(user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ON CONFLICT DO NOTHING;
```

Terminal A:

```sql
BEGIN;
SELECT revision FROM schedule_revisions WHERE user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' FOR UPDATE;
-- Keep this transaction open while running Terminal B.
UPDATE schedule_revisions SET revision=revision+1 WHERE user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND revision=0;
COMMIT;
```

Terminal B (start after A's `SELECT`, before A commits):

```sql
BEGIN;
SELECT revision FROM schedule_revisions WHERE user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' FOR UPDATE;
-- This waits on A, then returns 1 after A commits. A proposal based on 0 must conflict.
ROLLBACK;
```

Repeat with `pantry_revisions` and an actual `pantry_items` row. Within A's locked transaction, update its nonnegative quantity, increment the revision, insert a matching `mutation_results` row and `operation_receipts` row, then commit. B must wait, read revision 1 and refuse its stale deduction. Test a second transaction that inserts a result/receipt then executes `ROLLBACK`; the following queries must return zero rows for its IDs:

For the pantry contention check, create one fictional item first (using a food that belongs to the test user). Start with quantity 2 and revision 0. In terminal A, lock the pantry revision row, decrement the item to 1, insert a `mutation_results` row and its matching `operation_receipts` row, increment the revision, and keep the transaction open. In terminal B, begin and select that same revision row `FOR UPDATE` before A commits. B must wait. Commit A; B must then see revision 1 and roll back its proposal based on revision 0. Confirm quantity remains 1 and exactly one receipt exists. Use distinct UUIDs for the result, receipt and operation. This checks row-lock contention; the future API must additionally check the receipt and digest **before** rejecting a stale revision inside that lock.

```sql
SELECT revision FROM pantry_revisions WHERE user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SELECT * FROM mutation_results WHERE id='<rolled-back-result-uuid>';
SELECT * FROM operation_receipts WHERE client_operation_id='<rolled-back-operation-uuid>';
```

The database constrains unique receipts and balances. The application service in later phases must implement authenticate/scope, receipt lookup before revision checks, digest comparison, current-resource visibility and atomic writes on the **same connection**. Schema checks alone do not prove the full API protocol. Completed schedule/job cancellation and provider dispatch tests belong to later phases. Remove the synthetic test user or drop the disposable test database after verification.
