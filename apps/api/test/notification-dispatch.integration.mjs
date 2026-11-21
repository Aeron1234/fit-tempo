import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { resolveNotificationWallTime, runNotificationDispatch } from '../dist/notification-dispatch.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const database = databaseUrl && new URL(databaseUrl);
if (!database || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
    || !database.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('a DST gap moves to the next valid minute and a repeat uses the first instant', () => {
  assert.equal(resolveNotificationWallTime('2024-03-10', '02:15', 'America/New_York').toISOString(),
    '2024-03-10T07:00:00.000Z');
  assert.equal(resolveNotificationWallTime('2024-11-03', '01:30', 'America/New_York').toISOString(),
    '2024-11-03T05:30:00.000Z');
});

test('dispatcher leases, pacing and durable outcomes on PostgreSQL', { timeout: 30_000 }, async t => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const owners = [];
  let clock = new Date('2024-03-12T12:00:00Z');
  const now = () => new Date(clock);
  async function seed({ status = 'pending', attempts = 0, revision = 4, expired = false } = {}) {
    const owner = randomUUID();
    const id = randomUUID();
    const email = `phase23-${owner}@example.invalid`;
    owners.push(owner);
    await pool.query('INSERT INTO users(id,email,password_hash,verified_at) VALUES($1,$2,$3,$4)',
      [owner, email, 'test-only', now()]);
    await pool.query(`INSERT INTO notification_preferences(id,user_id,type,enabled,revision)
      VALUES($1,$2,'weekly_summary',true,4)`, [randomUUID(), owner]);
    await pool.query(`INSERT INTO water_logs(id,user_id,amount_ml,occurred_at,recorded_time_zone,recorded_local_date,client_operation_id)
      VALUES($1,$2,500,'2024-03-09T12:00:00Z','Asia/Manila','2024-03-09',$3)`, [randomUUID(), owner, randomUUID()]);
    const leased = status === 'leased' || status === 'sending';
    await pool.query(`INSERT INTO notification_jobs(id,user_id,type,occurrence_identity,scheduled_at,expires_at,
      status,attempts,preference_revision,lease_owner,lease_token,lease_expires_at)
      VALUES($1,$2,'weekly_summary',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, owner, '2024-03-04', new Date(+clock - 60_000), new Date(+clock + (expired ? -1000 : 86_400_000)),
      status, attempts, revision, leased ? 'interrupted-test-run' : null, leased ? randomUUID() : null,
      leased ? new Date(+clock - 1000) : null]);
    return { id, owner, email };
  }
  async function job(id) {
    const { rows } = await pool.query('SELECT status,attempts,retry_at,lease_token FROM notification_jobs WHERE id=$1', [id]);
    return rows[0];
  }
  async function outcomes(id) {
    const { rows } = await pool.query('SELECT status FROM notification_logs WHERE job_id=$1 ORDER BY attempt_number', [id]);
    return rows.map(row => row.status);
  }
  const execute = ({ reserve = async () => true, send, dryRun = false, recipientFilter }) =>
    runNotificationDispatch(pool, { now, reserve, send, dryRun, recipientFilter });
  const unexpected = async () => assert.fail('Unexpected provider call');

  try {
    await t.test('dry run never contacts the provider or consumes an attempt', async () => {
      const { id } = await seed();
      let providerInteractions = 0;
      await execute({
        dryRun: true,
        reserve: async () => { providerInteractions++; return true; },
        send: async () => { providerInteractions++; return 'accepted'; },
      });
      assert.equal(providerInteractions, 0);
      assert.equal((await job(id)).status, 'pending');
      assert.equal((await job(id)).attempts, 0);
      assert.deepEqual(await outcomes(id), []);
    });

    await t.test('overlapping runs send a reclaimed claim exactly once', async () => {
      // Close the dry-run fixture before testing the next isolated batch.
      await pool.query('UPDATE notification_jobs SET status=\'cancelled\' WHERE user_id=$1', [owners[0]]);
      const { id, email } = await seed({ status: 'leased' });
      const calls = [];
      let finishSend;
      const allowSend = new Promise(resolve => { finishSend = resolve; });
      let enteredSend;
      const providerEntered = new Promise(resolve => { enteredSend = resolve; });
      const first = execute({ send: async ({ to }) => {
        calls.push(to);
        enteredSend();
        await allowSend;
        return 'accepted';
      } });
      try {
        await Promise.race([providerEntered, first.then(() => assert.fail('Expected reclaimed lease to send'))]);
        await execute({ send: async ({ to }) => {
          calls.push(to);
          return 'accepted';
        } });
      } finally {
        finishSend();
        await first;
      }
      assert.deepEqual(calls, [email]);
      assert.equal((await job(id)).status, 'accepted');
      assert.equal((await job(id)).attempts, 1);
      assert.deepEqual(await outcomes(id), ['accepted']);
    });

    await t.test('expired, stale and abandoned sending jobs cannot reach the provider', async () => {
      const stale = await seed({ revision: 3 });
      const expired = await seed({ expired: true });
      const abandoned = await seed({ status: 'sending', attempts: 1 });
      await execute({ send: unexpected });
      assert.equal((await job(stale.id)).status, 'cancelled');
      assert.equal((await job(expired.id)).status, 'expired');
      assert.equal((await job(abandoned.id)).status, 'unknown');
      assert.deepEqual(await outcomes(abandoned.id), ['unknown']);
    });

    await t.test('reservation denial leaves jobs eligible with no send attempt', async () => {
      const fixture = await seed();
      let reservations = 0;
      await execute({ reserve: async () => { reservations++; return false; }, send: unexpected });
      assert.equal(reservations, 1);
      assert.deepEqual(await job(fixture.id), { status: 'pending', attempts: 0, retry_at: null, lease_token: null });
      await execute({ send: async () => 'unknown' });
      assert.equal((await job(fixture.id)).status, 'unknown');
      assert.deepEqual(await outcomes(fixture.id), ['unknown']);
      await execute({ send: unexpected });
      assert.equal((await job(fixture.id)).attempts, 1);
    });

    await t.test('definite retryable failure waits for retry_at before sending again', async () => {
      const fixture = await seed();
      await execute({ send: async () => 'retryable' });
      const failed = await job(fixture.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.attempts, 1);
      assert.ok(failed.retry_at > clock);
      await execute({ send: unexpected });
      clock = new Date(+failed.retry_at + 1000);
      await execute({ send: async () => 'accepted' });
      assert.equal((await job(fixture.id)).status, 'accepted');
      assert.deepEqual(await outcomes(fixture.id), ['failed', 'accepted']);
    });

    await t.test('an authorized test recipient filter leaves the other account queue untouched', async () => {
      const allowed = await seed();
      const other = await seed();
      const recipients = [];
      await execute({ recipientFilter: allowed.email, send: async ({ to }) => {
        recipients.push(to);
        return 'accepted';
      } });
      assert.deepEqual(recipients, [allowed.email]);
      assert.equal((await job(allowed.id)).status, 'accepted');
      assert.deepEqual(await job(other.id), { status: 'pending', attempts: 0, retry_at: null, lease_token: null });
      await pool.query('INSERT INTO notification_settings(user_id,global_opt_out) VALUES($1,true)', [other.owner]);
      await execute({ recipientFilter: other.email, send: unexpected });
      assert.equal((await job(other.id)).status, 'cancelled');
      assert.equal((await job(other.id)).attempts, 0);
    });

    await t.test('overlapping daily runs expand one qualifying weekly occurrence', async () => {
      clock = new Date('2024-03-11T00:00:00Z');
      const fixture = await seed();
      await pool.query('DELETE FROM notification_jobs WHERE id=$1', [fixture.id]);
      const run = () => execute({ recipientFilter: fixture.email, reserve: async () => false, send: unexpected });
      await Promise.all([run(), run()]);
      const { rows: occurrences } = await pool.query(
        'SELECT id,status FROM notification_jobs WHERE user_id=$1 AND type=$2', [fixture.owner, 'weekly_summary'],
      );
      assert.equal(occurrences.length, 1);
      assert.equal(occurrences[0].status, 'pending');
      await execute({ recipientFilter: fixture.email, send: async () => 'accepted' });
      await execute({ recipientFilter: fixture.email, send: unexpected });
      assert.deepEqual(await outcomes(occurrences[0].id), ['accepted']);
    });
  } finally {
    await pool.query('DELETE FROM notification_logs WHERE user_id=ANY($1::uuid[])', [owners]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]);
    await pool.end();
  }
});
