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

test('manual catalog entry is private, atomic and preserves basis and unknown nutrients', async () => {
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  const id = randomUUID(), peer = randomUUID();
  const email = `phase10-${id}@example.invalid`;
  const password = 'SyntheticPhase10Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
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
    assert.equal((await request('/foods?q=Rice')).status, 401);
    const hash = await argon2.hash(password);
    const peerEmail = `phase10-${peer}@example.invalid`;
    await db.query(`INSERT INTO users (id,email,password_hash,verified_at)
      VALUES ($1,$2,$3,now()),($4,$5,$3,now())`, [id, email, hash, peer, peerEmail]);

    async function signIn(account) {
      cookies.clear();
      csrfToken = (await request('/auth/csrf')).body.data.csrfToken;
      assert.equal((await request('/auth/login', 'POST', { email: account, password })).status, 200);
      csrfToken = (await request('/auth/csrf')).body.data.csrfToken;
    }
    await signIn(email);
    const search = await request('/foods?q=Rice');
    assert.equal(search.status, 200);
    assert.equal(search.body.data[0].basis.kind, 'per_100g');
    const fixture = await request('/foods/barcode/2000000000008');
    assert.equal(fixture.body.data[0].basis.grams, null);
    assert.equal((await request('/foods/barcode/0000000000000')).body.meta.status, 'not_found');

    const food = {
      name: `Synthetic ${id.slice(0, 8)}`,
      preparation: 'raw',
      basis: { kind: 'per_serving', grams: null },
      nutrients: { energyKcal: '0', proteinG: null, carbsG: '2.5', fatG: null, fiberG: null, sodiumMg: null },
    };
    assert.equal((await request('/me/foods', 'POST', food, false)).status, 403);
    assert.equal((await request('/me/foods', 'POST', { ...food, ownerId: peer })).status, 400);
    const created = await request('/me/foods', 'POST', food);
    assert.equal(created.status, 201);
    const path = `/foods/${created.body.data.id}`;
    const detail = (await request(path)).body.data[0];
    assert.deepEqual(detail.basis, food.basis);
    assert.deepEqual(detail.nutrients, food.nutrients);
    assert.equal(detail.preparation, 'raw');
    assert.equal(detail.source.source, 'user');
    assert.equal((await request(`/foods?q=${encodeURIComponent(food.name)}`)).body.data[0].id, detail.id);
    await signIn(peerEmail);
    assert.equal((await request(path)).body.meta.status, 'not_found');
    assert.equal((await request(`/foods?q=${encodeURIComponent(food.name)}`)).body.meta.status, 'not_found');
  } finally {
    server.close();
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[id, peer]]);
    await db.end();
  }
});