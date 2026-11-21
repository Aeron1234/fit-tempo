import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { workoutSessionResponseSchema, workoutSessionsResponseSchema } from '@fit-tempo/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('workout timer reload, exact compatible volume and durable completion replay', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID();
  const password = 'SyntheticPhase15Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase15-${id}@example.invalid`;
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
    assert.equal((await request('/me/workout-sessions')).status, 401);
    const hash = await argon2.hash(password);
    await db.query('INSERT INTO users (id,email,password_hash,verified_at) VALUES ($1,$2,$3,now()),($4,$5,$3,now())',
      [owner, email(owner), hash, peer, email(peer)]);
    await Promise.all([ownerClient.login(owner), peerClient.login(peer)]);

    const base = '/me/workout-sessions';
    const exercise = await request('/me/exercises', 'POST', {
      name: 'Test lift', equipment: 'Barbell', instructions: null, measurementType: 'externalLoad',
    });
    assert.equal(exercise.status, 201);
    const lift = exercise.data.id;
    const timed = '14000000-0000-4000-8000-000000000002';
    const liftTarget = { exerciseId: lift, targetSets: 2, targetReps: 8, targetLoadKg: '12.5',
      targetMeters: null, targetSeconds: null, restSeconds: 45 };
    const timedTarget = { ...liftTarget, exerciseId: timed, targetLoadKg: null, targetReps: null, targetSeconds: '30' };
    const routine = await request('/me/routines', 'POST', {
      name: 'Mixed routine', durationMinutes: 15, level: null, exercises: [liftTarget, timedTarget, liftTarget],
    });
    assert.equal(routine.status, 201, JSON.stringify(routine));
    const input = { routineId: routine.data.id, expectedRoutineRevision: 0 };
    assert.equal((await request(base, 'POST', input, false)).status, 403);
    assert.equal((await peerClient.request(base, 'POST', input)).status, 404);
    const started = await request(base, 'POST', input);
    assert.equal(started.status, 201, JSON.stringify(started));
    let current = workoutSessionResponseSchema.parse(started).data;
    const path = base + '/' + current.id;
    assert.equal(current.status, 'inProgress');
    assert.equal((await peerClient.request(path)).status, 404);
    assert.deepEqual(workoutSessionsResponseSchema.parse(await peerClient.request(base)).data, []);
    const patch = async (action, fields = {}) => {
      const response = await request(path, 'PATCH', { expectedRevision: current.revision, action, ...fields });
      assert.equal(response.status, 200, JSON.stringify(response));
      current = workoutSessionResponseSchema.parse(response).data;
    };
    const liftSet = { setOrder: 1, measurement: { type: 'external_load', reps: 7, loadKg: '12.25' } };
    const timedSet = { setOrder: 1, measurement: { type: 'timed', durationSeconds: '23' } };
    const bad = [
      { exerciseIndex: 0, set: { ...liftSet, measurement: { ...liftSet.measurement, reps: 0 } } },
      { exerciseIndex: 0, set: { ...liftSet, measurement: { ...liftSet.measurement, loadKg: '-5' } } },
      { exerciseIndex: 1, set: { ...timedSet, measurement: { type: 'timed', durationSeconds: '0' } } },
      { exerciseIndex: 1, set: liftSet },
    ];
    for (const fields of bad) {
      assert.equal((await request(path, 'PATCH', { ...fields, action: 'saveSet', expectedRevision: current.revision })).status, 400);
    }
    await patch('saveSet', { exerciseIndex: 0, set: liftSet });
    await patch('saveSet', { exerciseIndex: 1, set: timedSet });
    await patch('saveSet', { exerciseIndex: 2, set: { ...liftSet, measurement: { type: 'external_load', reps: 1, loadKg: '0.125' } } });
    assert.deepEqual(current.volume, [{ exerciseId: lift, name: 'Test lift', kgReps: '85.875' }]);
    await patch('startRest', { seconds: 45 });
    assert.ok(current.restEndsAt);
    await patch('pause');
    const paused = current;
    await new Promise(resolve => setTimeout(resolve, 1100));
    const reloaded = workoutSessionResponseSchema.parse(await request(path)).data;
    assert.deepEqual(reloaded, paused);
    assert.equal(reloaded.status, 'paused');
    assert.equal(reloaded.activeSince, null);
    assert.equal(reloaded.restEndsAt, null);
    assert.ok(reloaded.restRemainingSeconds > 0);
    assert.deepEqual(reloaded.snapshot.exercises[1].actualSets, [timedSet]);
    await patch('resume');
    assert.equal(current.status, 'inProgress');
    assert.ok(current.activeSince && current.restEndsAt);
    await patch('pause');
    assert.equal((await request(path, 'PATCH', { expectedRevision: current.revision - 1, action: 'resume' })).status, 409);
    const key = { expectedRevision: current.revision, clientOperationId: randomUUID() };
    const responses = await Promise.all(Array.from({ length: 4 }, () => request(path + '/complete', 'POST', key)));
    for (const response of responses) {
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.deepEqual(response.data, responses[0].data);
    }
    const completed = workoutSessionResponseSchema.parse(responses[0]).data;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.elapsedSeconds, current.elapsedSeconds);
    assert.equal(completed.restRemainingSeconds, 0);
    assert.deepEqual(completed.snapshot.exercises, current.snapshot.exercises);
    assert.deepEqual((await request(path + '/complete', 'POST', key)).data, completed);
    assert.equal((await request(path + '/complete', 'POST', { ...key, expectedRevision: completed.revision })).error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await request(path, 'PATCH', { expectedRevision: completed.revision, action: 'resume' })).status, 409);
    assert.equal((await peerClient.request(path + '/complete', 'POST', key)).status, 404);
    assert.deepEqual((await request(path)).data, completed);
    const sets = await db.query('SELECT exercise_index FROM workout_sets WHERE session_id=$1 ORDER BY exercise_index', [completed.id]);
    assert.deepEqual(sets.rows.map(row => row.exercise_index), [0, 1, 2]);
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

