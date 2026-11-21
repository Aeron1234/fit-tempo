import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { activityResponseSchema, weightResponseSchema, measurementsResponseSchema } from '@fit-tempo/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('manual tracking keeps history private and linked workouts are deduplicated', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID();
  const password = 'Syntheticphase17Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase17-${id}@example.invalid`;
  try {
    await once(server, 'listening');
    function client() {
      const cookies = new Map();
      let csrf;
      async function request(path, method = 'GET', body, useCsrf = true) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
          method, signal: AbortSignal.timeout(8000),
          headers: {
            origin, cookie: [...cookies.values()].join('; '),
            ...(csrf && useCsrf ? { 'x-csrf-token': csrf } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        for (const value of response.headers.getSetCookie()) {
          const pair = value.split(';')[0];
          cookies.set(pair.split('=')[0], pair);
        }
        return response.status === 204 ? { status: 204 } : { status: response.status, ...await response.json() };
      }
      async function login(id) {
        csrf = (await request('/auth/csrf')).data.csrfToken;
        assert.equal((await request('/auth/login', 'POST', { email: email(id), password })).status, 200);
        csrf = (await request('/auth/csrf')).data.csrfToken;
      }
      return { request, login };
    }

    const ownerClient = client(), peerClient = client();
    const { request } = ownerClient;
    assert.equal((await request('/me/activity')).status, 401);
    const hash = await argon2.hash(password);
    await db.query('INSERT INTO users (id,email,password_hash,verified_at) VALUES ($1,$2,$3,now()),($4,$5,$3,now())',
      [owner, email(owner), hash, peer, email(peer)]);
    await Promise.all([ownerClient.login(owner), peerClient.login(peer)]);
    const workout = randomUUID();
    const activeWorkout = randomUUID();
    const zeroWorkout = randomUUID();
    const instant = '2026-03-08T17:30:00.000Z';
    await db.query(`INSERT INTO workout_sessions(id,user_id,routine_snapshot,started_at,ended_at,
      recorded_time_zone,recorded_local_date,status,actual_duration_seconds)
      VALUES ($1,$2,'{}',$4,$4,'Asia/Manila','2026-03-09','completed',1200),
        ($3,$2,'{}',$4,NULL,'Asia/Manila','2026-03-09','active',NULL),
        ($5,$2,'{}',$4,$4,'Asia/Manila','2026-03-09','completed',0)`, [workout, owner, activeWorkout, instant, zeroWorkout]);
    const range = '?from=2026-03-08&to=2026-03-11';
    const manual = { type: 'walking', occurredAt: instant, durationSeconds: 61, distanceMeters: '0.125' };
    const link = { type: 'running', occurredAt: '2026-03-10T00:00:00Z', durationSeconds: null, distanceMeters: null, linkedWorkoutId: workout };
    assert.equal((await request('/me/activity', 'POST', manual, false)).status, 403);
    assert.equal((await request('/me/activity', 'POST', { ...manual, durationSeconds: -1 })).status, 400);
    assert.equal((await request('/me/activity', 'POST', { ...manual, distanceMeters: '1e3' })).status, 400);
    assert.equal((await request('/me/activity', 'POST', { ...link, linkedWorkoutId: activeWorkout })).status, 404);
    assert.equal((await peerClient.request('/me/activity', 'POST', link)).status, 404);
    const written = await request('/me/activity', 'POST', manual);
    assert.equal(written.status, 201, JSON.stringify(written));
    assert.equal(written.data.localDate, '2026-03-09');
    const concurrent = await Promise.all([request('/me/activity', 'POST', link), request('/me/activity', 'POST', link)]);
    assert.deepEqual(concurrent.map(item => item.status).sort(), [201, 409], JSON.stringify(concurrent));
    const linked = concurrent.find(item => item.status === 201).data;
    assert.equal(linked.occurredAt, instant);
    assert.equal(linked.durationSeconds, 1200);
    assert.equal(linked.source, 'workout');
    assert.equal((await peerClient.request('/me/activity/' + written.data.id, 'PATCH', manual)).status, 404);
    assert.equal((await peerClient.request('/me/activity/' + written.data.id, 'DELETE')).status, 404);
    const activities = activityResponseSchema.parse(await request('/me/activity' + range)).data;
    assert.deepEqual(activities.totals, { durationSeconds: 61, distanceMeters: '0.125', manualCount: 1, linkedCount: 1 });
    assert.equal(activities.entries.length, 2);
    const zero = await request('/me/activity', 'POST', { ...link, linkedWorkoutId: zeroWorkout });
    assert.equal(zero.status, 201, JSON.stringify(zero));
    assert.equal(zero.data.durationSeconds, 0);
    const zeroRead = activityResponseSchema.parse(await request('/me/activity' + range)).data;
    assert.equal(zeroRead.entries.find(entry => entry.id === zero.data.id).durationSeconds, 0);

    const weight = { measuredAt: instant, weightKg: '73.012345', note: 'Synthetic' };
    const measurement = { measuredAt: instant, measurementType: 'Waist', valueCm: '80.125' };
    assert.equal((await request('/me/weight', 'POST', { ...weight, weightKg: '0' })).status, 400);
    assert.equal((await request('/me/measurements', 'POST', { ...measurement, valueCm: '0' })).status, 400);
    assert.equal((await request('/me/weight', 'POST', weight)).status, 201);
    assert.equal((await request('/me/measurements', 'POST', measurement)).status, 201);
    assert.equal((await request('/me/preferences', 'PATCH', { timeZone: 'UTC' })).status, 200);
    assert.equal((await request('/me/weight', 'POST', { measuredAt: '2026-03-11T00:00:00Z', weightKg: '73' })).status, 201);
    const weights = weightResponseSchema.parse(await request('/me/weight' + range)).data;
    assert.equal(weights.timeZone, 'UTC');
    assert.deepEqual(weights.entries.map(entry => [entry.localDate, entry.timeZone, entry.weightKg]), [
      ['2026-03-11', 'UTC', '73'], ['2026-03-09', 'Asia/Manila', '73.012345'],
    ]);
    const measurements = measurementsResponseSchema.parse(await request('/me/measurements' + range)).data;
    assert.deepEqual(measurements.entries.map(entry => [entry.localDate, entry.timeZone, entry.valueCm]), [
      ['2026-03-09', 'Asia/Manila', '80.125'],
    ]);
    for (const path of ['/me/activity', '/me/weight', '/me/measurements']) {
      assert.deepEqual((await peerClient.request(path + range)).data.entries, []);
    }
    const edited = await request('/me/activity/' + written.data.id, 'PATCH', { ...manual, durationSeconds: 62 });
    assert.equal(edited.status, 200);
    assert.deepEqual([edited.data.localDate, edited.data.timeZone], ['2026-03-09','Asia/Manila']);
    assert.equal((await request('/me/activity/' + written.data.id, 'DELETE')).status, 204);
    assert.deepEqual((await request('/me/activity' + range)).data.totals,
      { durationSeconds: null, distanceMeters: null, manualCount: 0, linkedCount: 2 });
  } finally {
    await db.query('DELETE FROM activity_logs WHERE user_id=ANY($1)', [[owner,peer]]);
    await db.query('DELETE FROM workout_sessions WHERE user_id=ANY($1)', [[owner,peer]]);
    await db.query('DELETE FROM users WHERE id=ANY($1)', [[owner,peer]]);
    await new Promise(resolve => server.close(resolve));
    await db.end();
  }
});
