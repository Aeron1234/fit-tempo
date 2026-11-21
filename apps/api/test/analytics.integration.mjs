import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { analyticsResponseSchema } from '@fit-tempo/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('weekly analytics matches daily coverage and its email-ready summary', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID();
  const password = 'Syntheticphase20Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase20-${id}@example.invalid`;
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
    const ownerClient = client();
    const peerClient = client();
    const { request } = ownerClient;
    const endpoint = '/me/analytics?from=2024-03-04&to=2024-03-10';
    assert.equal((await request(endpoint)).status, 401);
    const hash = await argon2.hash(password);
    await db.query('INSERT INTO users (id,email,password_hash,verified_at) VALUES ($1,$2,$3,now()),($4,$5,$3,now())',
      [owner, email(owner), hash, peer, email(peer)]);
    await Promise.all([ownerClient.login(owner), peerClient.login(peer)]);
    const zone = 'America/New_York';
    assert.equal((await request('/me/preferences', 'PATCH', { timeZone: zone })).status, 200);
    assert.equal((await request('/me/analytics?from=2024-03-04&to=2024-03-09')).status, 400);
    assert.equal((await request('/me/analytics?from=2024-03-04')).status, 400);

    const manual = (energyKcal, proteinG) => ({
      manual: { name: 'Synthetic meal item', preparation: 'cooked', basis: { kind: 'per_serving', grams: null },
        nutrients: { energyKcal, proteinG, carbsG: null, fatG: null, fiberG: null, sodiumMg: null } },
      quantity: '1', unit: 'serving',
    });
    const meal = (date, items) => ({
      clientOperationId: randomUUID(), mealType: 'lunch', occurredAt: date + 'T16:00:00Z', items,
    });
    assert.equal((await request('/me/meals', 'POST', meal('2024-03-05', [manual('150', '8.1')]))).status, 201);
    assert.equal((await request('/me/tracking-days/2024-03-06/nutrition', 'PUT', { state: 'complete' })).status, 200);
    assert.equal((await request('/me/meals', 'POST', meal('2024-03-07', [manual('225', '14.2'), manual('175', null)]))).status, 201);
    assert.equal((await request('/me/tracking-days/2024-03-07/nutrition', 'PUT', { state: 'complete' })).status, 200);
    assert.equal((await request('/me/meals', 'POST', meal('2024-03-08', [manual(null, null)]))).status, 201);
    assert.equal((await peerClient.request('/me/meals', 'POST', meal('2024-03-07', [manual('999', '90')]))).status, 201);

    const workout = randomUUID();
    await db.query(`INSERT INTO workout_sessions
      (id,user_id,routine_snapshot,started_at,ended_at,recorded_time_zone,recorded_local_date,status,actual_duration_seconds)
      VALUES ($1,$2,'{}','2024-03-10T16:00Z','2024-03-10T16:30Z',$3,'2024-03-10','completed',1500),
        ($4,$2,'{}','2024-03-10T16:10Z','2024-03-10T16:40Z',$3,'2024-03-10','completed',1200)`,
      [workout, owner, zone, randomUUID()]);
    await db.query(`INSERT INTO workout_sessions
      (id,user_id,routine_snapshot,started_at,ended_at,recorded_time_zone,recorded_local_date,status,actual_duration_seconds)
      VALUES ($1,$2,'{}','2024-03-04T04:50Z','2024-03-04T05:20Z',$3,'2024-03-03','completed',1800),
        ($4,$2,'{}','2024-03-04T05:05Z','2024-03-04T05:30Z',$3,'2024-03-04','completed',1500)`,
      [randomUUID(), owner, zone, randomUUID()]);
    await db.query(`INSERT INTO activity_logs (id,user_id,type,occurred_at,recorded_time_zone,recorded_local_date,
      duration_seconds,distance_meters,source,linked_workout_id)
      VALUES ($1,$2,'walking','2024-03-10T16:00Z',$3,'2024-03-10',1500,220,'workout',$4),
        ($5,$2,'walking','2024-03-10T18:00Z',$3,'2024-03-10',600,800.125,'manual',NULL)`,
      [randomUUID(), owner, zone, workout, randomUUID()]);
    await db.query(`INSERT INTO weight_logs (id,user_id,weight_kg,measured_at,recorded_local_date,recorded_time_zone)
      VALUES ($1,$2,72,'2024-03-05T16:00Z','2024-03-05',$3),
        ($4,$2,71.5,'2024-03-10T16:00Z','2024-03-10',$3),
        ($5,$2,72.8,'2024-02-26T16:00Z','2024-02-26',$3)`, [randomUUID(), owner, zone, randomUUID(), randomUUID()]);
    await db.query(`INSERT INTO daily_tracking_status(id,user_id,category,recorded_local_date,recorded_time_zone,state,entry_count,confirmed_at)
      VALUES ($1,$2,'hydration','2024-03-09',$3,'complete',0,now())`, [randomUUID(), owner, zone]);
    await db.query(`INSERT INTO water_logs(id,user_id,amount_ml,occurred_at,recorded_time_zone,recorded_local_date,client_operation_id)
      VALUES ($1,$2,625.5,'2024-03-10T16:00Z',$3,'2024-03-10',$4)`, [randomUUID(), owner, zone, randomUUID()]);

    const result = await request(endpoint);
    assert.equal(result.status, 200, JSON.stringify(result));
    const { data } = analyticsResponseSchema.parse(result);
    assert.equal(data.timeZone, zone);
    assert.deepEqual(data.current.days.map(day => day.date), Array.from({ length: 7 }, (_, i) => '2024-03-0' + (i + 4)).slice(0, 6).concat('2024-03-10'));
    for (const day of data.current.days) {
      assert.deepEqual(day.nutrition, (await request('/me/dashboard?date=' + day.date)).data);
    }
    assert.deepEqual(data.current.nutrition, {
      loggedDays: 4,
      calories: { knownSubtotal: '550', average: '137.5', missingItemCount: 1, knownDays: 3 },
      protein: { knownSubtotal: '22.3', average: '5.575', missingItemCount: 2, knownDays: 3 },
    });
    assert.deepEqual(data.current.hydration, { loggedDays: 2, totalMl: '625.5', averageMl: '312.75' });
    assert.deepEqual(data.current.workouts, { completedCount: 3, durationSeconds: 1500, missingDurationCount: 0, overlapCount: 2 });
    assert.deepEqual(data.current.activity, { standaloneCount: 1, linkedExcludedCount: 1, durationSeconds: 600,
      distanceMeters: '800.125', missingDurationCount: 0, missingDistanceCount: 0 });
    assert.deepEqual(data.current.weight, { start: { date: '2024-03-05', kg: '72' },
      end: { date: '2024-03-10', kg: '71.5' }, changeKg: '-0.5' });
    assert.equal(data.previous.from, '2024-02-26');
    assert.equal(data.previous.to, '2024-03-03');
    assert.equal(data.previous.weight.changeKg, null);
    assert.equal(data.previous.workouts.durationSeconds, 1800);
    assert.equal(data.previous.nutrition.calories.average, null);
    const { weeklyEmailMetrics } = await import('../dist/analytics.js');
    for (const week of [data.current, data.previous]) {
      const { days, ...summary } = week;
      assert.equal(days.length, 7);
      assert.deepEqual(weeklyEmailMetrics(week), summary);
    }
  } finally {
    await db.query('DELETE FROM activity_logs WHERE user_id IN ($1,$2)', [owner, peer]);
    await db.query('DELETE FROM users WHERE id IN ($1,$2)', [owner, peer]);
    await db.end();
    await new Promise(resolve => server.close(resolve));
  }
});
