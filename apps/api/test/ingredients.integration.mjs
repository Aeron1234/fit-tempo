import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('recipe meal history, pantry revision contention and unknown package prices', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID();
  const password = 'SyntheticPhase12Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase12-${id}@example.invalid`;
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
        return { status: response.status, ...await response.json() };
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
    assert.equal((await request('/me/meals')).status, 401);
    const hash = await argon2.hash(password);
    await db.query('INSERT INTO users (id,email,password_hash,verified_at) VALUES ($1,$2,$3,now()),($4,$5,$3,now())',
      [owner, email(owner), hash, peer, email(peer)]);
    await Promise.all([ownerClient.login(owner), peerClient.login(peer)]);

    const food = { name: 'Synthetic flour', preparation: 'raw', basis: { kind: 'per_100g', grams: '100' },
      nutrients: { energyKcal: '360', proteinG: '12', carbsG: null, fatG: null, fiberG: null, sodiumMg: null } };
    const foodId = (await request('/me/foods', 'POST', food)).data.id;
    const peerFood = (await peerClient.request('/me/foods', 'POST', food)).data.id;
    const recipe = {
      name: 'Synthetic rolls', cookedYieldGrams: '150', servings: '2', prepMinutes: 30,
      items: [{ foodId, nutrientRevision: 0, quantity: '100', unit: 'g' }],
      steps: ['Mix', 'Cook'],
    };
    assert.equal((await request('/me/recipes', 'POST', recipe, false)).status, 403);
    assert.equal((await request('/me/recipes', 'POST', { ...recipe, servings: '0' })).status, 400);
    assert.equal((await request('/me/recipes', 'POST', { ...recipe, items: [{ ...recipe.items[0], foodId: peerFood }] })).status, 404);
    const created = await request('/me/recipes', 'POST', recipe);
    assert.equal(created.status, 201, JSON.stringify(created));
    const recipePath = `/me/recipes/${created.data.id}`;
    const list = (await request('/me/recipes')).data;
    assert.equal(list[0].cookedYieldGrams, '150');
    assert.deepEqual(list[0].steps, recipe.steps);
    assert.equal(list[0].items[0].unit, 'g');
    assert.deepEqual((await peerClient.request('/me/recipes')).data, []);

    const date = '2026-11-19';
    const log = { clientOperationId: randomUUID(), mealType: 'lunch', occurredAt: `${date}T04:00:00.000Z`,
      items: [{ recipeId: created.data.id, recipeRevision: 0, quantity: '1.5', unit: 'serving' }] };
    assert.equal((await peerClient.request('/me/meals', 'POST', log)).status, 404);
    const meal = await request('/me/meals', 'POST', log);
    assert.equal(meal.status, 201, JSON.stringify(meal));
    assert.equal(meal.data.totals.energyKcal, '270');
    assert.equal(meal.data.totals.proteinG, '9');
    const history = async () => (await request(`/me/meals?date=${date}`)).data.meals[0].items[0];
    const original = await history();
    assert.equal(original.snapshot.grams, '112.5');
    assert.equal(original.recipeSnapshot.yield.value, '150');
    assert.equal(original.recipeSnapshot.ingredients[0].basis.kind, 'per_100g');
    assert.equal(original.recipeSnapshot.ingredients[0].quantity.value, '100');
    const edit = { ...recipe, expectedRevision: 0, cookedYieldGrams: '210',
      items: [{ ...recipe.items[0], quantity: '1', unit: 'cup' }] };
    assert.equal((await request(recipePath, 'PATCH', edit)).status, 200);
    assert.equal((await request(recipePath, 'PATCH', edit)).status, 409);
    const updated = (await request('/me/recipes')).data[0];
    assert.equal(updated.items[0].unit, 'cup');
    assert.equal(updated.items[0].gramsPerUnit, null);
    assert.deepEqual(await history(), original);
    assert.equal((await request('/me/meals', 'POST', { ...log, clientOperationId: randomUUID() })).status, 409);
    const unknown = await request('/me/meals', 'POST', {
      ...log, occurredAt: '2026-11-20T04:00:00.000Z', clientOperationId: randomUUID(),
      items: [{ ...log.items[0], recipeRevision: 1 }],
    });
    assert.equal(unknown.status, 201);
    assert.equal(unknown.data.totals.energyKcal, null);
    assert.ok(unknown.data.missingNutrients.includes('energyKcal'));
    assert.equal((await request(recipePath, 'DELETE', { expectedRevision: 1 })).status, 200);
    assert.deepEqual(await history(), original);

    const lot = { foodId, quantity: '2.5', unit: 'cup', expiresOn: '2026-12-01',
      expectedPantryRevision: 0, clientOperationId: randomUUID() };
    const competitor = { ...lot, clientOperationId: randomUUID(), quantity: '3' };
    const race = await Promise.all([request('/me/pantry', 'POST', lot),request('/me/pantry', 'POST', competitor)]);
    assert.deepEqual(race.map(result => result.status).sort(), [201,409]);
    const winner = race[0].status === 201 ? lot : competitor;
    const saved = race.find(result => result.status === 201).data;
    assert.deepEqual((await request('/me/pantry', 'POST', winner)).data, saved);
    assert.equal((await request('/me/pantry', 'POST', { ...winner, quantity: '45' })).status, 409);
    assert.equal((await request(`/me/pantry/${saved.id}`, 'PATCH', { ...lot, clientOperationId: randomUUID() })).status, 409);
    const pantry = (await request('/me/pantry')).data;
    assert.equal(pantry.revision, 1);
    assert.equal(pantry.items[0].expiresOn, lot.expiresOn);
    assert.equal(pantry.items[0].quantity, winner.quantity);
    assert.equal(pantry.items[0].unit, 'cup');
    const changedLot = await request(`/me/pantry/${saved.id}`, 'PATCH', {
      ...lot, expectedPantryRevision: 1, clientOperationId: randomUUID(), quantity: '0', expiresOn: null,
    });
    assert.equal(changedLot.status, 200);
    assert.equal((await request('/me/pantry')).data.items[0].quantity, '0');
    const deletion = { expectedPantryRevision: 2, clientOperationId: randomUUID() };
    const removed = await request(`/me/pantry/${saved.id}`, 'DELETE', deletion);
    assert.equal(removed.status, 200);
    assert.deepEqual((await request(`/me/pantry/${saved.id}`, 'DELETE', deletion)).data, removed.data);
    assert.equal((await request('/me/pantry')).data.revision, 3);

    const price = { foodId, amount: null, currency: 'PHP', unitQuantity: '500', unit: 'g', priceBasis: 'package',
      storeName: null, recordedAt: '2026-11-19T04:00:00.000Z' };
    assert.equal((await request('/me/ingredient-prices', 'POST', { ...price, currency: 'ZZZ' })).status, 400);
    assert.equal((await request('/me/ingredient-prices', 'POST', { ...price, unitQuantity: '0' })).status, 400);
    assert.equal((await request('/me/ingredient-prices', 'POST', { ...price, foodId: peerFood })).status, 404);
    assert.equal((await request('/me/ingredient-prices', 'POST', price)).status, 201);
    assert.equal((await request('/me/ingredient-prices', 'POST', { ...price, amount: '0', currency: 'USD' })).status, 201);
    const prices = (await request('/me/ingredient-prices')).data;
    assert.equal(prices.find(row => row.currency === 'PHP').amount, null);
    assert.equal(prices.find(row => row.currency === 'USD').amount, '0');
    assert.ok(prices.every(row => row.priceBasis === 'package' && row.unitQuantity === '500'));
    assert.deepEqual((await peerClient.request('/me/ingredient-prices')).data, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    try {
      for (const statement of ['DELETE FROM meals WHERE user_id = ANY($1)', 'DELETE FROM recipes WHERE owner_id = ANY($1)',
        'DELETE FROM pantry_items WHERE user_id = ANY($1)', 'DELETE FROM ingredient_prices WHERE user_id = ANY($1)',
        'DELETE FROM users WHERE id = ANY($1)']) {
        await db.query(statement, [[owner, peer]]);
      }
    } finally {
      await db.end();
    }
  }
});
