import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('admin RBAC, suspension, redacted audits and immutable shared-food snapshots', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const adminId = randomUUID(), traineeId = randomUUID(), jobId = randomUUID();
  const password = 'Phase24SyntheticPassword!';
  const origin = 'http://localhost:5173';
  const email = id => `phase24-${id}@example.invalid`;
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'test', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    EMAIL_ADAPTER: 'test-mailbox', AI_ADAPTER: 'disabled', SCHEDULER_MODE: 'manual-dry-run',
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  delete process.env.NOTIFICATION_TEST_RECIPIENT;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  let sharedFood, privateFood, category, exercise;
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
      async function login(id, expected = 200) {
        csrf = (await request('/auth/csrf')).data.csrfToken;
        assert.equal((await request('/auth/login', 'POST', { email: email(id), password })).status, expected);
        csrf = (await request('/auth/csrf')).data.csrfToken;
      }
      async function refresh() {
        csrf = (await request('/auth/csrf')).data.csrfToken;
        return request('/auth/refresh', 'POST');
      }
      return { request, login, refresh };
    }
    const admin = client(), trainee = client(), refreshClient = client();
    assert.equal((await admin.request('/admin/users')).status, 401);
    const hash = await argon2.hash(password);
    await db.query(`INSERT INTO users(id,email,password_hash,role_code,verified_at)
      VALUES ($1,$2,$3,'admin',now()),($4,$5,$3,'trainee',now())`,
    [adminId, email(adminId), hash, traineeId, email(traineeId)]);
    await Promise.all([admin.login(adminId), trainee.login(traineeId), refreshClient.login(traineeId)]);
    for (const resource of ['users', 'foods', 'exercises', 'categories', 'audit', 'statistics']) {
      assert.equal((await trainee.request('/admin/' + resource)).status, 403);
      assert.equal((await admin.request('/admin/' + resource)).status, 200);
    }
    const statusPath = '/admin/users/' + traineeId;
    assert.equal((await trainee.request(statusPath, 'PATCH', { active: false })).status, 403);
    assert.equal((await admin.request(statusPath, 'PATCH', { active: false }, false)).status, 403);
    assert.equal((await admin.request(statusPath, 'PATCH', { active: false, role: 'admin' })).status, 400);
    assert.ok((await admin.request('/admin/users/' + adminId, 'PATCH', { active: false })).status >= 400);
    assert.equal((await admin.request('/me/meals?date=2024-04-02')).data.meals.length, 0);

    const createdCategory = await admin.request('/admin/categories', 'POST', { kind: 'food', name: 'Phase 24 ' + adminId });
    assert.equal(createdCategory.status, 201, JSON.stringify(createdCategory));
    category = createdCategory.data.id;
    const createdExercise = await admin.request('/admin/exercises', 'POST', {
      name: 'Phase 24 synthetic row', categoryId: null, visibility: 'approved',
      measurementType: 'externalLoad', equipment: 'Dumbbell', instructions: null,
    });
    assert.equal(createdExercise.status, 201, JSON.stringify(createdExercise));
    exercise = createdExercise.data.id;
    const food = {
      name: 'Phase 24 synthetic rice', preparation: 'cooked', basis: { kind: 'per_100g', grams: '100' },
      nutrients: { energyKcal: '130', proteinG: '2.7', carbsG: null, fatG: null, fiberG: null, sodiumMg: null },
    };
    const createdPrivate = await trainee.request('/me/foods', 'POST', food);
    assert.equal(createdPrivate.status, 201);
    privateFood = createdPrivate.data.id;
    const publish = { ...food, categoryId: category, visibility: 'approved' };
    assert.equal((await admin.request('/admin/foods/' + privateFood, 'PATCH', { ...publish, revision: 0 })).status, 404);
    const createdFood = await admin.request('/admin/foods', 'POST', publish);
    assert.equal(createdFood.status, 201, JSON.stringify(createdFood));
    sharedFood = createdFood.data.id;
    const item = { foodId: sharedFood, nutrientRevision: createdFood.data.revision, quantity: '150', unit: 'g' };
    const meal = () => ({ clientOperationId: randomUUID(), mealType: 'lunch', occurredAt: '2024-04-02T04:00:00Z', items: [item] });
    const stored = await trainee.request('/me/meals', 'POST', meal());
    assert.equal(stored.status, 201, JSON.stringify(stored));
    assert.equal(stored.data.totals.energyKcal, '195');
    const foodPath = '/admin/foods/' + sharedFood;
    const update = { ...publish, name: 'Revised synthetic rice', nutrients: { ...food.nutrients, energyKcal: '250' }, revision: createdFood.data.revision };
    assert.equal((await admin.request(foodPath, 'PATCH', update)).status, 200);
    assert.equal((await admin.request(foodPath, 'PATCH', update)).status, 409);
    assert.equal((await trainee.request('/me/meals', 'POST', meal())).status, 409);
    const retired = await admin.request(foodPath, 'PATCH', {
      ...update, visibility: 'retired', revision: update.revision + 1,
    });
    assert.equal(retired.status, 200);
    assert.equal(retired.data.visibility, 'retired');
    assert.deepEqual((await trainee.request('/foods/' + sharedFood)).data, []);
    assert.equal((await admin.request('/admin/categories/' + category + '?kind=food', 'DELETE')).status, 409);
    const history = (await trainee.request('/me/meals?date=2024-04-02')).data.meals[0];
    assert.equal(history.items[0].snapshot.foodName, food.name);
    assert.equal(history.totals.energyKcal, '195');

    await db.query(`INSERT INTO notification_jobs(id,user_id,type,occurrence_identity,scheduled_at,expires_at,status,lease_owner,lease_token,lease_expires_at)
      VALUES ($1,$2,'weekly_summary',$1::uuid::text,now(),now()+interval '1 hour','leased','phase24-fixture',$1,now()+interval '30 seconds')`, [jobId, traineeId]);
    assert.equal((await admin.request(statusPath, 'PATCH', { active: false })).status, 200);
    assert.equal((await admin.request(statusPath, 'PATCH', { active: false })).status, 200);
    assert.equal((await trainee.request('/auth/me')).status, 401);
    assert.equal((await refreshClient.refresh()).status, 401);
    await client().login(traineeId, 401);
    const { rows: [job] } = await db.query('SELECT status,lease_owner,lease_token,lease_expires_at FROM notification_jobs WHERE id=$1', [jobId]);
    assert.deepEqual(job, { status: 'cancelled', lease_owner: null, lease_token: null, lease_expires_at: null });
    assert.equal((await admin.request(statusPath, 'PATCH', { active: true })).status, 200);
    assert.equal((await trainee.request('/auth/me')).status, 401);
    await trainee.login(traineeId);
    assert.equal((await trainee.request('/me/meals?date=2024-04-02')).data.meals[0].totals.energyKcal, '195');

    const audit = await admin.request('/admin/audit?limit=100');
    assert.equal(audit.status, 200);
    for (const id of [traineeId, sharedFood, exercise, category]) {
      assert.ok(audit.data.some(row => row.targetId === id));
    }
    assert.equal(audit.data.filter(row => row.action === 'account.suspend' && row.targetId === traineeId).length, 1);
    for (const row of audit.data) {
      assert.deepEqual(Object.keys(row).sort(), ['action','id','occurredAt','targetId','targetType'].sort());
    }
    const { rows: auditRows } = await db.query('SELECT redacted_context FROM audit_logs WHERE actor_user_id=$1', [adminId]);
    const serialized = JSON.stringify(auditRows);
    for (const secret of [email(traineeId), password, hash, food.name]) assert.ok(!serialized.includes(secret));
  } finally {
    await db.query('DELETE FROM audit_logs WHERE actor_user_id=$1', [adminId]);
    await db.query('DELETE FROM users WHERE id IN ($1,$2)', [adminId, traineeId]);
    if (sharedFood) await db.query('DELETE FROM foods WHERE id=$1', [sharedFood]);
    if (exercise) await db.query('DELETE FROM exercises WHERE id=$1', [exercise]);
    if (category) await db.query('DELETE FROM food_categories WHERE id=$1', [category]);
    await db.end();
    await new Promise(resolve => server.close(resolve));
  }
});
