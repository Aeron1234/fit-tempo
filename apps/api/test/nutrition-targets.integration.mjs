import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { nutritionTargetsResponseSchema } from '@fit-tempo/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('nutrition targets are isolated and use revision conflicts and durable replay', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID();
  const password = 'Syntheticnutrition-targetsPassword!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `nutrition-targets-${id}@example.invalid`;
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
    assert.equal((await request('/me/nutrition-targets')).status, 401);
    const hash = await argon2.hash(password);
    await db.query('INSERT INTO users (id,email,password_hash,verified_at) VALUES ($1,$2,$3,now()),($4,$5,$3,now())',
      [owner, email(owner), hash, peer, email(peer)]);
    await Promise.all([ownerClient.login(owner), peerClient.login(peer)]);
    const path = '/me/nutrition-targets';
    const save = (revision, energyKcal = 2200) => ({
      revision, clientOperationId: randomUUID(), energyKcal, proteinG: 110, carbsG: 275, fatG: 73,
    });
    const read = async (session = ownerClient) => nutritionTargetsResponseSchema.parse(await session.request(path)).data;
    assert.equal((await read()).targets, null);
    assert.equal((await request(path, 'POST', save(0), false)).status, 403);
    assert.equal((await request(path, 'POST', save(0, -1))).status, 400);
    const first = save(0);
    const accepted = await request(path, 'POST', first);
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.equal(nutritionTargetsResponseSchema.parse(accepted).data.targets.energyKcal, 2200);
    assert.equal((await read(peerClient)).targets, null);
    assert.equal((await read()).latestWeight, null);
    const current = await read();
    assert.equal(current.dayTargets.energyKcal, 2200);
    assert.equal(current.localDate, current.targets.effectiveFrom);
    assert.ok(Date.parse(current.targets.savedAt));
    const now = new Date().toISOString();
    await db.query(`INSERT INTO weight_logs
      (id,user_id,weight_kg,measured_at,recorded_time_zone,recorded_local_date)
      VALUES($1,$2,80,$3,'UTC',$4)`, [randomUUID(), owner, now, now.slice(0,10)]);
    assert.equal((await read()).latestWeight.weightKg, '80');
    assert.equal((await read(peerClient)).latestWeight, null);
    const contenders = await Promise.all([request(path, 'POST', save(1, 2300)), request(path, 'POST', save(1, 2400))]);
    assert.deepEqual(contenders.map(result => result.status).sort(), [200, 409]);
    assert.equal((await read()).revision, 2);
    assert.deepEqual(await request(path, 'POST', first), accepted);
    assert.equal((await request(path, 'POST', { ...first, energyKcal: 2500 })).status, 409);
    const versions = await db.query('SELECT revision FROM nutrition_target_revisions WHERE user_id=$1 ORDER BY revision', [owner]);
    assert.deepEqual(versions.rows.map(row => Number(row.revision)), [1, 2]);
  } finally {
    await db.query('DELETE FROM users WHERE id=ANY($1)', [[owner, peer]]);
    await new Promise(resolve => server.close(resolve));
    await db.end();
  }
});
