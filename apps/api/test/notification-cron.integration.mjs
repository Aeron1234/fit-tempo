import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createNotificationCron } from '../dist/notification-cron.js';
import { createNotificationEmailSender } from '../dist/notification-emailjs.js';

async function invoke(handler, authorization, method = 'GET') {
  const result = { status: 200, headers: {} };
  const response = {
    set(key, value) { result.headers[key] = value; return this; },
    status(value) { result.status = value; return this; },
    sendStatus(value) { return this.status(value); },
    json(value) { result.body = value; return this; },
  };
  await handler({ method, get: key => key === 'authorization' ? authorization : undefined }, response);
  return result;
}

test('cron fails closed and requires an exact bearer on GET', async () => {
  const secret = 'fixture-private-cron-secret-only';
  let runs = 0;
  const run = async () => ({ accepted: ++runs });
  assert.equal((await invoke(createNotificationCron(undefined, run), `Bearer ${secret}`)).status, 401);
  const handler = createNotificationCron(secret, run);
  for (const value of [undefined, secret, `bearer ${secret}`, `Bearer ${secret} extra`]) {
    assert.equal((await invoke(handler, value)).status, 401);
  }
  assert.equal((await invoke(handler, `Bearer ${secret}`, 'POST')).status, 405);
  assert.equal((await invoke(handler, `Bearer ${secret}`, 'HEAD')).status, 405);
  assert.equal((await invoke(createNotificationCron(secret), `Bearer ${secret}`)).status, 503);
  assert.equal(runs, 0);
  assert.deepEqual(await invoke(handler, `Bearer ${secret}`), {
    status: 200, headers: { 'Cache-Control': 'no-store' }, body: { data: { accepted: 1 } },
  });
});

test('scheduled EmailJS uses the authorized recipient, bounded transport and distinct fixed templates', async () => {
  const calls = [];
  let status = 200;
  const send = createNotificationEmailSender({
    recipient: 'authorized@example.invalid', serviceId: 'fixture-service', publicKey: 'fixture-public',
    privateKey: 'fixture-private', templateId: 'fixture-reminder', summaryTemplateId: 'fixture-summary',
    frontendUrl: 'https://fit-tempo.example',
    transport: async (url, init) => {
      calls.push({ url, init });
      return new Response('fixture', { status });
    },
  });
  const to = 'authorized@example.invalid';
  assert.equal(await send({ to: 'other@example.invalid', type: 'weekly_summary' }), 'rejected');
  assert.equal(await send({ to, type: 'workout_reminder' }), 'rejected');
  assert.equal(calls.length, 0);
  assert.equal(await send({ to, type: 'weekly_summary' }), 'accepted');
  status = 429;
  assert.equal(await send({ to, type: 'milestone' }), 'retryable');
  status = 503;
  assert.equal(await send({ to, type: 'weekly_summary' }), 'unknown');
  assert.equal(calls.length, 3);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.emailjs.com/api/v1.0/email/send');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body), {
    service_id: 'fixture-service', user_id: 'fixture-public', accessToken: 'fixture-private',
    template_id: 'fixture-summary', template_params: {
      to_email: to, notification_label: 'Weekly summary', settings_url: 'https://fit-tempo.example/app/notifications',
    },
  });
  assert.equal(JSON.parse(calls[1].init.body).template_id, 'fixture-reminder');
});

test('the mounted cron route serves an authenticated PostgreSQL dry run', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const database = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && database.pathname.endsWith('_test'));
  const secret = 'fixture-only-cron-authentication-secret';
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: database.href,
    JWT_ACCESS_SECRET: 'fixture-only-access-secret-do-not-use',
    CSRF_SECRET: 'fixture-only-csrf-secret-do-not-use',
    FRONTEND_URL: 'http://localhost:5173',
    APP_MODE: 'local',
    FOOD_ADAPTER: 'fixtures',
    AI_ADAPTER: 'disabled',
    EMAIL_ADAPTER: 'test-mailbox',
    SCHEDULER_MODE: 'manual-dry-run',
    CRON_SECRET: secret,
  });
  delete process.env.REDIS_URL;
  delete process.env.NOTIFICATION_TEST_RECIPIENT;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const path = `http://127.0.0.1:${server.address().port}/api/cron/process-notifications`;
    const denied = await fetch(path, { signal: AbortSignal.timeout(5_000) });
    assert.equal(denied.status, 401);
    const run = await fetch(path, {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(run.status, 200);
    assert.equal(run.headers.get('cache-control'), 'no-store');
    const { data } = await run.json();
    assert.equal(data.accepted, 0);
    assert.equal(data.enqueued, 0);
    assert.equal(typeof data.remaining, 'number');
    assert.equal(typeof data.runId, 'string');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
