import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { runNotificationDispatch } from '../dist/notification-dispatch.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const database = databaseUrl && new URL(databaseUrl);
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
    || !database.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('bounded overlapping Cron runs drain an isolated batch through an owned mock', { timeout: 30_000 }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const owner = randomUUID();
  const email = `phase25-${owner}@example.invalid`;
  const size = 12;
  const now = () => new Date('2024-03-12T12:00:00Z');
  let reservations = 0;
  let calls = 0;
  const run = reserve => runNotificationDispatch(pool, {
    dryRun: false, recipientFilter: email, now, reserve,
    async send({ to, type }) {
      assert.equal(to, email);
      assert.equal(type, 'weekly_summary');
      calls++;
      return 'accepted';
    },
  });
  try {
    await pool.query('INSERT INTO users(id,email,password_hash,verified_at) VALUES ($1,$2,$3,$4)',
      [owner, email, 'test-only', now()]);
    await pool.query(`INSERT INTO notification_preferences(id,user_id,type,enabled,revision)
      VALUES ($1,$2,'weekly_summary',true,1)`, [randomUUID(), owner]);
    await pool.query(`INSERT INTO water_logs(id,user_id,amount_ml,occurred_at,recorded_time_zone,recorded_local_date,client_operation_id)
      VALUES ($1,$2,500,'2024-03-09T12:00:00Z','Asia/Manila','2024-03-09',$3)`, [randomUUID(), owner, randomUUID()]);
    await pool.query(`INSERT INTO notification_jobs(id,user_id,type,occurrence_identity,scheduled_at,expires_at,preference_revision)
      SELECT gen_random_uuid(),$1,'weekly_summary','fixture:'||occurrence,'2024-03-12T11:00:00Z','2024-03-12T16:00:00Z',1
      FROM generate_series(1,$2) occurrence`, [owner, size]);

    const denied = await Promise.all(Array.from({ length: 4 }, () => run(async () => false)));
    assert.equal(denied.reduce((total, result) => total + result.accepted, 0), 0);
    assert.equal(calls, 0);
    const reserve = async () => ++reservations <= size;
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => run(reserve)));
    assert.ok(concurrent.every(result => result.evaluated <= 8));
    assert.equal(concurrent.reduce((total, result) => total + result.accepted, 0), size);
    assert.equal(calls, size);
    assert.equal(reservations, size);
    const { rows: [stored] } = await pool.query(`SELECT count(*)::int AS jobs,
      count(*) FILTER (WHERE j.status='accepted' AND j.attempts=1 AND l.status='accepted')::int AS accepted
      FROM notification_jobs j LEFT JOIN notification_logs l ON l.job_id=j.id WHERE j.user_id=$1`, [owner]);
    assert.deepEqual(stored, { jobs: size, accepted: size });
    assert.equal((await run(reserve)).remaining, 0);
    assert.equal(calls, size);
  } finally {
    await pool.query('DELETE FROM notification_logs WHERE user_id=$1', [owner]);
    await pool.query('DELETE FROM users WHERE id=$1', [owner]);
    await pool.end();
  }
});
