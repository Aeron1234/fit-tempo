import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { waterResponseSchema, hydrationGoalsResponseSchema } from '@fit-tempo/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('water retries, committed crossings, edit recomputation and scheduled streaks', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID();
  const password = 'Syntheticphase18Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase18-${id}@example.invalid`;
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
    assert.equal((await request('/me/water')).status, 401);
    const hash = await argon2.hash(password);
    await db.query('INSERT INTO users (id,email,password_hash,verified_at) VALUES ($1,$2,$3,now()),($4,$5,$3,now())',
      [owner, email(owner), hash, peer, email(peer)]);
    await Promise.all([ownerClient.login(owner), peerClient.login(peer)]);
    const zone = 'UTC';
    assert.equal((await request('/me/preferences', 'PATCH', { timeZone: zone })).status, 200);
    const timestamp = new Date().toISOString();
    const today = timestamp.slice(0, 10);
    const previousDay = new Date(Date.parse(today + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
    const dayPath = '/me/water?date=' + today;
    const reviewed = async () => hydrationGoalsResponseSchema.parse(await request('/me/goals')).data;
    const current = async () => waterResponseSchema.parse(await request(dayPath)).data;
    const add = (amountMl, clientOperationId = randomUUID()) => ({
      amountMl, occurredAt: timestamp, clientOperationId,
    });
    assert.equal((await request('/me/water', 'POST', add('10'), false)).status, 403);
    for (const amount of ['0', '-1', '1e3', '0.0000001']) {
      assert.equal((await request('/me/water', 'POST', add(amount))).status, 400);
    }
    assert.equal((await current()).totalMl, null);
    await db.query(`INSERT INTO daily_tracking_status(id,user_id,category,recorded_local_date,recorded_time_zone,state,entry_count,confirmed_at)
      VALUES($1,$2,'hydration',$3,'UTC','complete',0,now())`, [randomUUID(), owner, previousDay]);
    assert.equal((await request('/me/water?date=' + previousDay)).data.totalMl, '0');
    const one = add('150');
    const repeats = await Promise.all([request('/me/water', 'POST', one), request('/me/water', 'POST', one)]);
    assert.equal(repeats[0].status, 201, JSON.stringify(repeats[0]));
    assert.deepEqual(repeats[0], repeats[1]);
    assert.equal((await request('/me/water', 'POST', { ...one, amountMl: '151' })).status, 409);
    const instantSpelling = timestamp.endsWith('.000Z') ? timestamp.replace('.000Z', 'Z') : timestamp.replace(/(\d)0Z$/, '$1Z');
    if (instantSpelling !== timestamp) {
      assert.equal((await request('/me/water', 'POST', { ...one, occurredAt: instantSpelling })).status, 409);
    }
    assert.equal((await current()).totalMl, '150');
    assert.equal((await current()).entries.length, 1);
    const first = repeats[0].data;
    const firstGoal = await request('/me/goals', 'POST', { targetMl: '200' });
    assert.equal(firstGoal.status, 201, JSON.stringify(firstGoal));
    assert.equal((await request('/me/goals', 'POST', { targetMl: '80' })).status, 409);
    assert.equal((await reviewed()).milestones.length, 0);
    const [second, third] = await Promise.all([
      request('/me/water', 'POST', add('30')),
      request('/me/water', 'POST', add('25')),
    ]);
    assert.equal(second.status, 201, JSON.stringify(second));
    assert.equal(third.status, 201, JSON.stringify(third));
    assert.equal((await current()).totalMl, '205');
    assert.deepEqual((await reviewed()).milestones.map(row => row.goalId), [firstGoal.data.id]);
    const firstPath = '/me/water/' + first.id;
    assert.equal((await peerClient.request(firstPath, 'DELETE')).status, 404);
    assert.equal((await peerClient.request('/me/goals/' + firstGoal.data.id, 'PATCH', { status: 'retired' })).status, 404);
    assert.deepEqual((await peerClient.request('/me/goals')).data, { goals: [], milestones: [], workoutStreak: 0 });

    await db.query(`UPDATE daily_tracking_status SET state='complete',confirmed_at=now()
      WHERE user_id=$1 AND category='hydration' AND recorded_local_date=$2`, [owner, today]);
    const moved = await request(firstPath, 'PATCH', { amountMl: '150', occurredAt: previousDay + 'T12:00:00Z' });
    assert.equal(moved.status, 200, JSON.stringify(moved));
    assert.equal(moved.data.localDate, previousDay);
    assert.equal((await current()).totalMl, '55');
    assert.equal((await request('/me/water?date=' + previousDay)).data.totalMl, '150');
    const { rows: statusRows } = await db.query(`SELECT recorded_local_date::text AS date,state,entry_count,confirmed_at
      FROM daily_tracking_status WHERE user_id=$1 AND category='hydration' ORDER BY recorded_local_date`, [owner]);
    assert.deepEqual(statusRows, [
      { date: previousDay, state: 'partial', entry_count: 1, confirmed_at: null },
      { date: today, state: 'partial', entry_count: 2, confirmed_at: null },
    ]);
    assert.equal((await request(firstPath, 'PATCH', { amountMl: '150', occurredAt: timestamp })).status, 200);
    assert.equal((await current()).totalMl, '205');
    assert.equal((await reviewed()).milestones.length, 1);
    assert.equal((await request('/me/goals/' + firstGoal.data.id, 'PATCH', { status: 'retired' })).status, 200);
    const secondGoal = await request('/me/goals', 'POST', { targetMl: '200' });
    assert.equal(secondGoal.status, 201, JSON.stringify(secondGoal));
    assert.equal((await reviewed()).milestones.length, 1);
    assert.equal((await request(firstPath, 'DELETE')).status, 204);
    assert.deepEqual(await request('/me/water', 'POST', one), repeats[0]);
    assert.equal((await current()).totalMl, '55');
    assert.equal((await request('/me/water', 'POST', add('150'))).status, 201);
    assert.equal((await current()).totalMl, '205');
    assert.deepEqual(new Set((await reviewed()).milestones.map(row => row.goalId)), new Set([firstGoal.data.id,secondGoal.data.id]));
    const routine = '14000000-0000-4000-8000-000000000003';
    async function schedule(daysAgo, status, linkedCompletion = false) {
      const times = [new Date(Date.parse(today + 'T00:00:00Z') - daysAgo * 86_400_000 + 12 * 3600000)];
      times.push(new Date(times[0].getTime() + 3600000));
      const id = randomUUID();
      await db.query(`INSERT INTO scheduled_workouts(id,user_id,routine_id,starts_at,ends_at,
        recorded_time_zone,recorded_local_date,status)
        VALUES($1,$2,$3,$4,$5,'UTC',($4::timestamptz AT TIME ZONE 'UTC')::date,$6)`,
      [id,owner,routine,...times,status]);
      if (linkedCompletion) {
        await db.query(`INSERT INTO workout_sessions(id,user_id,scheduled_workout_id,routine_snapshot,started_at,ended_at,
          recorded_time_zone,recorded_local_date,status,actual_duration_seconds)
          VALUES($1,$2,$3,'{}',$4,$5,'UTC',($4::timestamptz AT TIME ZONE 'UTC')::date,'completed',3600)`,
        [randomUUID(),owner,id,...times]);
      }
    }
    await schedule(7, 'missed');
    await schedule(5, 'completed', true);
    const restDate = new Date(Date.parse(today + 'T00:00:00Z') - 4 * 86_400_000);
    await db.query('INSERT INTO schedule_settings(user_id,rest_days) VALUES($1,$2)', [owner,[restDate.getUTCDay()]]);
    await schedule(2, 'completed', true);
    await schedule(1, 'cancelled');
    await schedule(-1, 'planned');
    assert.equal((await reviewed()).workoutStreak, 2);
    await schedule(1, 'planned');
    assert.equal((await reviewed()).workoutStreak, 0);
    await schedule(-2, 'completed', true);
    assert.equal((await reviewed()).workoutStreak, 1);
  } finally {
    await db.query('DELETE FROM workout_sessions WHERE user_id=ANY($1)', [[owner,peer]]);
    await db.query('DELETE FROM milestone_events WHERE user_id=ANY($1)', [[owner,peer]]);
    await db.query('DELETE FROM users WHERE id=ANY($1)', [[owner,peer]]);
    await new Promise(resolve => server.close(resolve));
    await db.end();
  }
});
