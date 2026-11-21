import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)
    || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('notification capability, transactional cancellation and account email independence', async () => {
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  const owner = randomUUID(), peer = randomUUID();
  const email = `phase22-${owner}@example.invalid`;
  const password = 'SyntheticPhase22Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
    EMAIL_ADAPTER: 'test-mailbox', AI_ADAPTER: 'disabled', SCHEDULER_MODE: 'hobby-daily', FOOD_ADAPTER: 'fixtures',
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const cookies = new Map();
  const path = '/me/notification-preferences';
  let csrfToken;
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    async function request(route, method = 'GET', body, includeCsrf = true) {
      const response = await fetch(base + route, {
        method, signal: AbortSignal.timeout(5000),
        headers: {
          origin, cookie: [...cookies.values()].join('; '),
          ...(includeCsrf && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0];
        cookies.set(pair.split('=')[0], pair);
      }
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await request('/health')).body.data.capabilities.scheduler, 'hobby-daily');
    assert.equal((await request(path)).status, 401);
    const hash = await argon2.hash(password);
    await db.query(`INSERT INTO users (id,email,password_hash,verified_at)
      VALUES ($1,$2,$3,now()),($4,$5,$3,now())`, [owner, email, hash, peer, `phase22-${peer}@example.invalid`]);
    csrfToken = (await request('/auth/csrf')).body.data.csrfToken;
    assert.equal((await request('/auth/login', 'POST', { email, password })).status, 200);
    csrfToken = (await request('/auth/csrf')).body.data.csrfToken;
    const empty = (await request(path)).body.data;
    assert.equal(empty.mode, 'hobby-daily');
    assert.equal(empty.nextSendAt, null);
    assert.equal(empty.timeZone, 'Asia/Manila');
    assert.ok(empty.types.every(item => !item.enabled));
    const enabled = Object.fromEntries(empty.types.map(item => [item.type, item.type === 'weekly_summary']));
    const save = { revision: empty.revision, globalOptOut: false, quietStart: '22:00', quietEnd: '06:30', enabled };
    assert.equal((await request(path, 'PUT', save, false)).status, 403);
    assert.equal((await request(path, 'PUT', { ...save, userId: peer })).status, 400);
    assert.equal((await request(path, 'PUT', { ...save, preferredLocalTime: '13:00' })).status, 400);
    assert.equal((await request(path, 'PUT', { ...save, quietEnd: null })).status, 400);
    for (const type of ['workout_reminder', 'hydration_reminder']) {
      assert.equal(empty.types.find(item => item.type === type).supported, false);
      const unsupported = await request(path, 'PUT', { ...save, enabled: { ...enabled, [type]: true } });
      assert.equal(unsupported.status, 400);
      assert.equal(unsupported.body.error.code, 'SCHEDULER_UNSUPPORTED');
    }
    const saved = await request(path, 'PUT', save);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.quietStart, '22:00');
    assert.equal(saved.body.data.quietEnd, '06:30');
    assert.equal(saved.body.data.types.find(item => item.type === 'weekly_summary').enabled, true);
    assert.equal((await request(path, 'PUT', save)).status, 409);

    async function addJob(userId, status) {
      const id = randomUUID();
      await db.query(`INSERT INTO notification_jobs
        (id,user_id,type,occurrence_identity,scheduled_at,expires_at,status,retry_at,lease_owner,lease_token,lease_expires_at)
        VALUES ($1,$2,'weekly_summary',$1::uuid::text,now(),now()+interval '1 day',$3,
          CASE WHEN $3='failed' THEN now() ELSE NULL END, $4, $5, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)`,
      [id, userId, status, status === 'leased' ? 'fixture' : null, status === 'leased' ? randomUUID() : null]);
      return id;
    }

    const job = await addJob(owner, 'pending');
    assert.equal((await request('/me/preferences', 'PATCH', { timeZone: 'America/New_York' })).status, 200);
    const zoned = (await request(path)).body.data;
    assert.equal(zoned.timeZone, 'America/New_York');
    assert.equal(zoned.revision, saved.body.data.revision + 1);
    assert.equal((await db.query('SELECT status FROM notification_jobs WHERE id=$1', [job])).rows[0].status, 'cancelled');
    const pendingJobs = await Promise.all(['pending', 'leased', 'failed'].map(status => addJob(owner, status)));
    const sendingJob = await addJob(owner, 'sending');
    const acceptedJob = await addJob(owner, 'accepted');
    const peerJob = await addJob(peer, 'pending');
    const stopped = await request(path, 'PUT', { ...save, revision: zoned.revision, globalOptOut: true });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.data.globalOptOut, true);
    assert.deepEqual((await db.query(`SELECT status,retry_at,lease_token FROM notification_jobs WHERE id=ANY($1::uuid[])`, [pendingJobs])).rows,
      pendingJobs.map(() => ({ status: 'cancelled', retry_at: null, lease_token: null })));
    for (const [id, status] of [[sendingJob, 'sending'], [acceptedJob, 'accepted'], [peerJob, 'pending']]) {
      assert.equal((await db.query('SELECT status FROM notification_jobs WHERE id=$1', [id])).rows[0].status, status);
    }
    assert.equal((await request('/auth/forgot-password', 'POST', { email })).status, 202);
    assert.equal((await db.query(`SELECT 1 FROM verification_tokens
      WHERE user_id=$1 AND purpose='reset_password' AND expires_at>now()`, [owner])).rowCount, 1);
  } finally {
    await db.query('DELETE FROM users WHERE id=ANY($1)', [[owner, peer]]);
    await db.end();
    await new Promise(resolve => server.close(resolve));
  }
});
