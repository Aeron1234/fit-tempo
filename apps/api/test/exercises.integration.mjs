import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { workoutSnapshotSchema, exercisesResponseSchema, routinesResponseSchema } from '@fit-tempo/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('exercise equipment and measurement targets, reviewed variants and immutable completed history', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID();
  const password = 'SyntheticPhase14Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase14-${id}@example.invalid`;
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
    assert.equal((await request('/exercises')).status, 401);
    assert.equal((await request('/me/routines')).status, 401);
    const hash = await argon2.hash(password);
    await db.query('INSERT INTO users (id,email,password_hash,verified_at) VALUES ($1,$2,$3,now()),($4,$5,$3,now())',
      [owner, email(owner), hash, peer, email(peer)]);
    await Promise.all([ownerClient.login(owner), peerClient.login(peer)]);

    assert.equal((await peerClient.request('/me/exercises')).status, 200);
    assert.deepEqual((await peerClient.request('/exercises')).data, (await peerClient.request('/me/exercises')).data);
    const catalog = exercisesResponseSchema.parse(await request('/me/exercises')).data;
    assert.ok(catalog.some(item => item.equipment === 'Stable chair' && item.measurementType === 'bodyweight'));
    const curated = routinesResponseSchema.parse(await request('/me/routines')).data.find(item => item.id.endsWith('000003'));
    assert.ok(curated && !curated.editable);
    assert.equal(curated.shorterVariants[0].durationMinutes, 8);
    assert.deepEqual(curated.shorterVariants[0].exercises.map(item => item.measurementType), ['bodyweight', 'timed']);

    const exercise = { name: 'Synthetic press', equipment: 'Dumbbells', instructions: null, measurementType: 'externalLoad' };
    assert.equal((await request('/me/exercises', 'POST', exercise, false)).status, 403);
    const created = await request('/me/exercises', 'POST', exercise);
    assert.equal(created.status, 201, JSON.stringify(created));
    const exerciseId = created.data.id;
    const exercisePath = '/me/exercises/' + exerciseId;
    assert.ok(!(await peerClient.request('/me/exercises')).data.some(item => item.id === exerciseId));
    assert.equal((await peerClient.request(exercisePath, 'PATCH', { ...exercise, expectedRevision: 0 })).status, 404);

    const target = { exerciseId, targetSets: 1, targetReps: 8, targetLoadKg: '12.5',
      targetSeconds: null, targetMeters: null, restSeconds: 60 };
    const routine = { name: 'Synthetic routine', durationMinutes: 20, level: 'beginner', exercises: [
      target, { ...target, targetReps: 6 },
    ] };
    assert.equal((await peerClient.request('/me/routines', 'POST', routine)).status, 404);
    assert.equal((await request('/me/routines', 'POST', { ...routine, exercises: [{ ...target, targetMeters: '10' }] })).status, 400);
    const saved = await request('/me/routines', 'POST', routine);
    assert.equal(saved.status, 201, JSON.stringify(saved));
    const id = saved.data.id;
    const routinePath = '/me/routines/' + id;
    assert.deepEqual(routinesResponseSchema.parse(await request('/me/routines')).data.find(item => item.id === id)
      .exercises.map(item => item.targetReps), [8, 6]);
    assert.equal((await request(exercisePath, 'PATCH', { ...exercise, measurementType: 'bodyweight', expectedRevision: 0 })).status, 409);

    const capturedAt = '2026-11-20T03:00:00.000Z';
    const snapshot = workoutSnapshotSchema.parse({
      snapshotVersion: 1, capturedAt, routineId: id, routineRevision: 0, variantId: null, name: routine.name,
      exercises: routine.exercises.map((item, index) => ({
        exerciseId, exerciseRevision: 0, name: exercise.name, restSeconds: '60',
        targets: [{ setOrder: 1, measurement: { type: 'external_load', reps: item.targetReps, loadKg: '12.5' } }],
        actualSets: index === 0 ? [{ setOrder: 1, measurement: { type: 'external_load', reps: 7, loadKg: '10' } }] : [],
      })),
    });
    const sessionId = randomUUID();
    await db.query(`INSERT INTO workout_sessions(id,user_id,routine_snapshot,started_at,ended_at,recorded_time_zone,
      recorded_local_date,status,actual_duration_seconds)
      VALUES($1,$2,$3,$4,'2026-11-20T03:20Z','Asia/Manila','2026-11-20','completed',1200)`,
    [sessionId, owner, JSON.stringify(snapshot), capturedAt]);
    await db.query(`INSERT INTO workout_sets(id,session_id,exercise_id,set_order,measurement_type,actual_reps,actual_load_kg)
      VALUES($1,$2,$3,1,'externalLoad',7,10)`, [randomUUID(), sessionId, exerciseId]);

    const renamed = { ...exercise, name: 'Renamed synthetic press', expectedRevision: 0 };
    assert.equal((await request(exercisePath, 'PATCH', renamed)).status, 200);
    assert.equal((await request(exercisePath, 'PATCH', renamed)).status, 409);
    const reordered = await request(routinePath, 'PATCH', { ...routine, exercises: [...routine.exercises].reverse(), expectedRevision: 0 });
    assert.equal(reordered.status, 200);
    const current = (await request('/me/routines')).data.find(item => item.id === id);
    assert.deepEqual(current.exercises.map(item => item.targetReps), [6, 8]);
    assert.equal(current.exercises[0].exerciseName, renamed.name);
    assert.equal((await request(routinePath, 'DELETE', { expectedRevision: 1 })).status, 200);
    assert.ok(!(await request('/me/routines')).data.some(item => item.id === id));

    const history = await db.query('SELECT routine_snapshot FROM workout_sessions WHERE id=$1 AND user_id=$2', [sessionId, owner]);
    assert.deepEqual(workoutSnapshotSchema.parse(history.rows[0].routine_snapshot), snapshot);
    const actual = await db.query('SELECT actual_reps,actual_load_kg::text FROM workout_sets WHERE session_id=$1', [sessionId]);
    assert.equal(actual.rows[0].actual_reps, 7);
    assert.equal(Number(actual.rows[0].actual_load_kg), 10);
    await assert.rejects(db.query(`UPDATE workout_sessions SET routine_snapshot='{}' WHERE id=$1`, [sessionId]));
  } finally {
    await new Promise(resolve => server.close(resolve));
    try {
      await db.query('DELETE FROM workout_sessions WHERE user_id=ANY($1)', [[owner, peer]]);
      await db.query('DELETE FROM workout_routines WHERE user_id=ANY($1)', [[owner, peer]]);
      await db.query('DELETE FROM users WHERE id=ANY($1)', [[owner, peer]]);
    } finally {
      await db.end();
    }
  }
});
