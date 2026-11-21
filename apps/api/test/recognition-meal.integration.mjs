import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import express from 'express';
import { createAuthRouter } from '../dist/auth/router.js';
import { createTestMailbox } from '../dist/auth/mailbox.js';
import { createMealsRouter } from '../dist/meals.js';
import { createFoodRecognitionRouter } from '../dist/food-recognition.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('fixture suggestions do not write a meal before confirmed edited input', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID();
  const password = 'SyntheticPhase19Password!';
  const origin = 'http://localhost:5173';
  const app = express();
  app.use(express.json());
  let reservations = 0;
  const router = createAuthRouter({
    db, sender: createTestMailbox(false), frontendUrl: origin, production: false,
    jwtSecret: randomBytes(48).toString('base64url'), csrfSecret: randomBytes(48).toString('base64url'),
    meals: createMealsRouter(db),
    foodRecognition: createFoodRecognitionRouter({ mode: 'synthetic', reserve: async () => { reservations++; return true; } }),
  });
  app.use('/api/v1/auth', router);
  app.use('/api/v1/me', (req, res, next) => {
    req.url = (req.path.startsWith('/ai/') ? '/phase19' : '/phase11') + req.url;
    return router(req, res, next);
  });
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase19-${id}@example.invalid`;
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


    const { request, login } = client();
    const path = '/me/ai/food-suggestions';
    assert.equal((await request(path)).status, 401);
    await db.query('INSERT INTO users(id,email,password_hash,verified_at) VALUES($1,$2,$3,now())',
      [owner, email(owner), await argon2.hash(password)]);
    await login(owner);
    assert.equal((await request(path, 'POST', { fixtureId: 'synthetic-rice-bowl' }, false)).status, 403);
    assert.equal((await request(path, 'POST', { fixtureId: 'synthetic-rice-bowl', image: 'unapproved' })).status, 400);
    assert.equal(reservations, 0);
    const suggestion = await request(path, 'POST', { fixtureId: 'synthetic-rice-bowl' });
    assert.equal(suggestion.status, 200, JSON.stringify(suggestion));
    assert.equal(reservations, 1);
    assert.ok(suggestion.data.candidates.length > 0);
    assert.ok(suggestion.data.candidates.every(item => item.portionGrams === null));
    const count = async () => (await db.query('SELECT count(*)::int AS n FROM meals WHERE user_id=$1',[owner])).rows[0].n;
    assert.equal(await count(), 0);
    const meal = {
      clientOperationId: randomUUID(), mealType: 'lunch', occurredAt: new Date().toISOString(),
      items: [{ quantity: '125', unit: 'g', manual: {
        name: 'Edited rice', preparation: 'unknown', basis: { kind: 'per_100g', grams: '100' },
        nutrients: { energyKcal: null, proteinG: null, carbsG: null, fatG: null, fiberG: null, sodiumMg: null },
      } }],
    };
    const saved = await request('/me/meals', 'POST', meal);
    assert.equal(saved.status, 201, JSON.stringify(saved));
    assert.equal(await count(), 1);
    assert.deepEqual(await request('/me/meals', 'POST', meal), saved);
    assert.equal(await count(), 1);
  } finally {
    try {
      await new Promise(resolve => server.close(resolve));
      await db.query('DELETE FROM users WHERE id=$1', [owner]);
    } finally { await db.end(); }
  }
});
