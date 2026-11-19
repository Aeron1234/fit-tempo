import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { aggregateDay, dashboardFixtures } from '@fit-tempo/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('stored meals reproduce dashboard fixtures and preserve transactional history', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID(), photo = randomUUID();
  const password = 'SyntheticPhase11Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase11-${id}@example.invalid`;
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
    const manual = (energyKcal, proteinG) => ({
      manual: {
        name: 'Synthetic meal item', preparation: 'cooked', basis: { kind: 'per_serving', grams: null },
        nutrients: { energyKcal, proteinG, carbsG: null, fatG: null, fiberG: null, sodiumMg: null },
      },
      quantity: '1', unit: 'serving',
    });
    const meal = (date, items) => ({
      clientOperationId: randomUUID(), mealType: 'lunch', occurredAt: `${date}T04:00:00.000Z`, items,
    });
    const setDay = (date, state) => request(`/me/tracking-days/${date}/nutrition`, 'PUT', { state });
    const dashboard = date => request(`/me/dashboard?date=${date}`);
    const history = date => request(`/me/meals?date=${date}`);
    const completeDate = '2026-11-18';
    const complete = meal(completeDate, [manual('225', '14.2'), manual('175', null)]);
    assert.equal((await request('/me/meals', 'POST', complete, false)).status, 403);
    assert.equal((await request('/me/meals', 'POST', meal('2026-11-16', [manual('150', '8.1')]))).status, 201);
    assert.equal((await setDay('2026-11-17', 'complete')).status, 200);

    const copies = await Promise.all(Array.from({ length: 5 }, () => request('/me/meals', 'POST', complete)));
    for (const result of copies) {
      assert.ok([200, 201].includes(result.status), JSON.stringify(result));
      assert.deepEqual(result.data, copies[0].data);
    }
    const { id, revision } = copies[0].data;
    assert.equal((await history(completeDate)).data.meals.length, 1);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_receipts WHERE user_id=$1 AND client_operation_id=$2',
      [owner, complete.clientOperationId])).rows[0].count, 1);
    assert.equal((await request('/me/meals', 'POST', { ...complete, mealType: 'snack' })).status, 409);
    assert.equal((await setDay(completeDate, 'complete')).status, 200);

    for (const [date, fixture] of Object.entries(dashboardFixtures)) {
      const result = await dashboard(date);
      assert.equal(result.status, 200);
      assert.deepEqual(result.data, aggregateDay(fixture));
    }

    const ownFood = await request('/me/foods', 'POST', {
      ...manual('130', '2.7').manual, name: 'Phase 11 synthetic rice', basis: { kind: 'per_100g', grams: '100' },
    });
    assert.equal(ownFood.status, 201);
    const detail = await request(`/foods/${ownFood.data.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data[0].revision, 0);
    const conversionDate = '2026-11-20';
    const catalogItem = { foodId: ownFood.data.id, nutrientRevision: 0, quantity: '0.15', unit: 'kg' };
    const stored = await request('/me/meals', 'POST', meal(conversionDate, [catalogItem]));
    assert.equal(stored.status, 201, JSON.stringify(stored));
    assert.equal(stored.data.totals.energyKcal, '195');
    assert.equal(stored.data.totals.proteinG, '4.05');
    await db.query('UPDATE foods SET revision=revision+1,name=$2 WHERE id=$1', [ownFood.data.id, 'Revised synthetic food']);
    await db.query("UPDATE food_nutrients SET amount=200 WHERE food_id=$1 AND nutrient_code='energyKcal'", [ownFood.data.id]);
    const storedRow = (await history(conversionDate)).data.meals[0];
    assert.equal(storedRow.items[0].snapshot.foodName, 'Phase 11 synthetic rice');
    assert.equal(storedRow.items[0].snapshot.grams, '150');
    assert.equal(storedRow.totals.energyKcal, '195');
    assert.equal((await request('/me/meals', 'POST', meal(conversionDate, [catalogItem]))).status, 409);
    const itemEdit = await request(`/me/meals/${storedRow.id}/items/${storedRow.items[0].id}`, 'PUT', {
      clientOperationId: randomUUID(), expectedRevision: storedRow.revision,
      item: { ...catalogItem, nutrientRevision: 1, unit: 'cup', quantity: '1' },
    });
    assert.equal(itemEdit.status, 200, JSON.stringify(itemEdit));
    assert.equal(itemEdit.data.totals.energyKcal, null);
    assert.equal((await history(conversionDate)).data.meals[0].items[0].id, storedRow.items[0].id);
    const movedDate = '2026-11-21';
    assert.equal((await setDay(conversionDate, 'complete')).status, 200);
    assert.equal((await setDay(movedDate, 'complete')).status, 200);
    const moved = await request(`/me/meals/${storedRow.id}`, 'PATCH', {
      ...meal(movedDate, [{ itemId: storedRow.items[0].id }]), expectedRevision: itemEdit.data.revision,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved));
    assert.equal((await dashboard(conversionDate)).data.status, 'unrecorded');
    assert.equal((await dashboard(movedDate)).data.status, 'partial');

    const peerFood = await peerClient.request('/me/foods', 'POST', manual('30', '2').manual);
    assert.equal(peerFood.status, 201);
    await db.query(`INSERT INTO files (id,user_id,object_key,kind,mime_type,byte_size,state)
      VALUES ($1,$2,$3,'food_photo','image/jpeg',16,'ready')`, [photo, peer, `phase11/${photo}`]);
    const rollbackDate = '2026-11-19';
    const privateFood = { foodId: peerFood.data.id, nutrientRevision: 0, quantity: '1', unit: 'serving' };
    for (const forbidden of [
      meal(rollbackDate, [manual('25', '1'), privateFood]),
      { ...meal(rollbackDate, [manual('25', '1')]), imageId: photo },
    ]) {
      assert.equal((await request('/me/meals', 'POST', forbidden)).status, 404);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_receipts WHERE user_id=$1 AND client_operation_id=$2',
        [owner, forbidden.clientOperationId])).rows[0].count, 0);
    }
    assert.equal((await history(rollbackDate)).data.meals.length, 0);
    assert.equal((await dashboard(rollbackDate)).data.status, 'unrecorded');

    const before = (await history(completeDate)).data.meals[0];
    const failedEdit = { ...complete, expectedRevision: revision, clientOperationId: randomUUID(),
      items: [manual('50', '3'), privateFood] };
    assert.equal((await request(`/me/meals/${id}`, 'PATCH', failedEdit)).status, 404);
    assert.deepEqual((await history(completeDate)).data.meals[0], before);
    assert.equal((await dashboard(completeDate)).data.status, 'complete');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM meal_history WHERE meal_id=$1', [id])).rows[0].count, 0);
    const edit = { ...complete, expectedRevision: revision, clientOperationId: randomUUID(),
      items: [{ itemId: before.items[0].id }, manual('50', '3')] };
    assert.equal((await peerClient.request(`/me/meals/${id}`, 'PATCH', edit)).status, 404);
    const edited = await request(`/me/meals/${id}`, 'PATCH', edit);
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.equal((await dashboard(completeDate)).data.status, 'partial');
    assert.deepEqual((await dashboard(completeDate)).data.protein, { unit: 'g', knownSubtotal: '17.2', missingItemCount: 0 });
    const after = (await history(completeDate)).data.meals[0];
    assert.deepEqual(after.items[0], before.items[0]);
    assert.equal((await request(`/me/meals/${id}`, 'PATCH', { ...edit, clientOperationId: randomUUID() })).status, 409);
    assert.deepEqual((await request('/me/meals', 'POST', complete)).data, copies[0].data);

    assert.equal((await setDay(completeDate, 'complete')).status, 200);
    const deletion = { clientOperationId: randomUUID(), expectedRevision: edited.data.revision };
    const deleted = await request(`/me/meals/${id}`, 'DELETE', deletion);
    assert.equal(deleted.status, 200);
    assert.deepEqual((await request(`/me/meals/${id}`, 'DELETE', deletion)).data, deleted.data);
    assert.equal((await history(completeDate)).data.meals.length, 0);
    assert.equal((await dashboard(completeDate)).data.status, 'unrecorded');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM meal_history WHERE meal_id=$1', [id])).rows[0].count, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    try {
      await db.query('DELETE FROM meals WHERE user_id = ANY($1)', [[owner, peer]]);
      await db.query('DELETE FROM users WHERE id = ANY($1)', [[owner, peer]]);
    } finally {
      await db.end();
    }
  }
});
