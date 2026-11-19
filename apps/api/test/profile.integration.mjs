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

test('profile writes, CSRF, ownership and dashboard recorded-day coverage', async () => {
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  const id = randomUUID(), peer = randomUUID(), meal = randomUUID();
  const email = `phase09-${id}@example.invalid`;
  const password = 'SyntheticPhase09Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const cookies = new Map();
  let csrfToken;
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    async function request(path, method = 'GET', body, includeCsrf = true) {
      const response = await fetch(base + path, {
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
    assert.equal((await request('/me/profile')).status, 401);
    const hash = await argon2.hash(password);
    await db.query(`INSERT INTO users (id,email,password_hash,verified_at)
      VALUES ($1,$2,$3,now()),($4,$5,$3,now())`, [id, email, hash, peer, `phase09-${peer}@example.invalid`]);
    await db.query('INSERT INTO profiles (user_id,display_name) VALUES ($1,$2)', [peer, 'Other member']);
    csrfToken = (await request('/auth/csrf')).body.data.csrfToken;
    assert.equal((await request('/auth/login', 'POST', { email, password })).status, 200);
    csrfToken = (await request('/auth/csrf')).body.data.csrfToken;
    assert.equal((await request('/me/profile')).body.data.displayName, null);
    assert.equal((await request('/me/profile', 'PATCH', { displayName: 'Fixture' }, false)).status, 403);
    assert.equal((await request('/me/profile', 'PATCH', { userId: peer, displayName: 'Fixture' })).status, 400);
    assert.deepEqual((await request('/me/profile', 'PATCH', { displayName: 'Fixture', heightCm: '170.5' })).body.data,
      { displayName: 'Fixture', heightCm: '170.5' });
    assert.equal((await db.query('SELECT display_name FROM profiles WHERE user_id=$1', [peer])).rows[0].display_name, 'Other member');
    assert.equal((await request('/me/preferences', 'PATCH', { timeZone: 'UTC', massUnit: 'lb' })).status, 200);
    await db.query(`INSERT INTO daily_tracking_status
      (id,user_id,category,recorded_local_date,recorded_time_zone,state,confirmed_at)
      VALUES ($1,$2,'nutrition','2026-11-17','Asia/Manila','complete',now())`, [randomUUID(), id]);
    await db.query(`INSERT INTO meals (id,user_id,meal_type,occurred_at,recorded_time_zone,recorded_local_date)
      VALUES ($1,$2,'breakfast','2026-11-16T16:30:00Z','Asia/Manila','2026-11-17')`, [meal, peer]);
    const dashboard = await request('/me/dashboard?date=2026-11-17');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.data.timezone, 'Asia/Manila');
    assert.equal(dashboard.body.data.status, 'complete');
    assert.deepEqual(dashboard.body.data.protein, { unit: 'g', knownSubtotal: '0', missingItemCount: 0 });
    const ownedMeal = randomUUID();
    await db.query(`INSERT INTO meals (id,user_id,meal_type,occurred_at,recorded_time_zone,recorded_local_date)
      VALUES ($1,$2,'breakfast','2026-11-16T16:30:00Z','Asia/Manila','2026-11-17')`, [ownedMeal, id]);
    await db.query(`INSERT INTO meal_items (id,meal_id,quantity,unit,nutrition_snapshot)
      VALUES ($1,$2,1,'serving',$3),($4,$2,1,'serving',$5),($6,$7,1,'serving',$8)`,
    [randomUUID(), ownedMeal, { consumedNutrients: { energyKcal: '225', proteinG: '14.2' } },
      randomUUID(), { consumedNutrients: { energyKcal: '175', proteinG: null } },
      randomUUID(), meal, { consumedNutrients: { energyKcal: '999', proteinG: '99' } }]);
    await db.query(`UPDATE daily_tracking_status SET entry_count=1 WHERE user_id=$1 AND category='nutrition'`, [id]);
    const completed = (await request('/me/dashboard?date=2026-11-17')).body.data;
    assert.equal(completed.status, 'complete');
    assert.deepEqual(completed.protein, { unit: 'g', knownSubtotal: '14.2', missingItemCount: 1 });
    assert.deepEqual(completed.calories, { unit: 'kcal', knownSubtotal: '400', missingItemCount: 0 });
    assert.equal((await request('/me/dashboard?date=2026-11-16')).body.data.status, 'unrecorded');
    assert.equal((await request('/me/dashboard?date=2026-02-29')).status, 400);
  } finally {
    server.close();
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[id, peer]]);
    await db.end();
  }
});
