import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailJsAccountSender, EmailJsAccountSendError } from '../dist/auth/emailjs.js';

const settings = {
  serviceId: 'service_fictional',
  publicKey: 'synthetic-public',
  privateKey: 'synthetic-private',
  verifyTemplateId: 'template_verify',
  resetTemplateId: 'template_reset',
};
const recipient = 'phase21@example.invalid';
const verifyUrl = 'https://fit-tempo.example.invalid/verify-email?token=synthetic-verification';
const resetUrl = 'https://fit-tempo.example.invalid/reset-password?token=synthetic-reset';
const verification = { to: recipient, kind: 'verify_email', url: verifyUrl };

test('account email uses fixed templates and private server authorization after reserving capacity', async () => {
  let reserved = 0;
  const requests = [];
  const sender = createEmailJsAccountSender({
    ...settings,
    reserve: async () => { reserved += 1; return true; },
    transport: async (input, init) => {
      assert.equal(reserved, requests.length + 1);
      requests.push({ input, init });
      return new Response('OK', { status: 200 });
    },
  });

  // This tests provider acceptance at the HTTP boundary using a mock transport.
  await sender.send(verification);
  await sender.send({ to: recipient, kind: 'reset_password', url: resetUrl });
  assert.equal(requests.length, 2);
  for (const [{ input, init }, url, template] of [
    [requests[0], verifyUrl, settings.verifyTemplateId],
    [requests[1], resetUrl, settings.resetTemplateId],
  ]) {
    assert.equal(String(input), 'https://api.emailjs.com/api/v1.0/email/send');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), {
      service_id: settings.serviceId,
      template_id: template,
      user_id: settings.publicKey,
      accessToken: settings.privateKey,
      template_params: { to_email: recipient, action_url: url },
    });
  }
});

test('pacing refusal or outage fails closed without contacting EmailJS', async () => {
  const outageDetail = 'internal pacing connection detail';
  for (const reserve of [
    async () => false,
    async () => { throw new Error(outageDetail); },
  ]) {
    let requests = 0;
    const sender = createEmailJsAccountSender({
      ...settings, reserve,
      transport: async () => { requests += 1; return new Response('OK'); },
    });
    await assert.rejects(sender.send(verification), error => {
      assert.ok(error instanceof EmailJsAccountSendError);
      assert.equal(error.outcome, 'unavailable');
      assert.ok(!error.message.includes(outageDetail));
      return true;
    });
    assert.equal(requests, 0);
  }
});

test('provider rejection and ambiguous transport failures are sanitized and never retried', async () => {
  const providerDetail = [recipient, verifyUrl, settings.privateKey].join(' ');
  for (const [outcome, fail] of [
    ['rejected', () => new Response(providerDetail, { status: 429 })],
    ['unknown', () => new Response(providerDetail, { status: 408 })],
    ['unknown', () => new Response(providerDetail, { status: 503 })],
    ['unknown', () => { throw new Error(providerDetail); }],
    ['unknown', () => { throw new DOMException(providerDetail, 'TimeoutError'); }],
  ]) {
    let requests = 0;
    let reservations = 0;
    const sender = createEmailJsAccountSender({
      ...settings,
      reserve: async () => { reservations += 1; return true; },
      transport: async () => { requests += 1; return fail(); },
    });
    await assert.rejects(sender.send(verification), error => {
      assert.ok(error instanceof EmailJsAccountSendError);
      assert.equal(error.outcome, outcome);
      for (const secret of [recipient, verifyUrl, settings.privateKey]) {
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.stack.includes(secret));
      }
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(reservations, 1);
  }
});

test('EmailJS is opt-in and requires private authorization, Redis and fixed distinct templates', async () => {
  const { readEnvironment } = await import('../dist/config/env.js');
  const config = {
    EMAIL_ADAPTER: 'emailjs',
    EMAILJS_SERVICE_ID: 'service_fixture',
    EMAILJS_PUBLIC_KEY: 'public_fixture',
    EMAILJS_PRIVATE_KEY: 'private_fixture',
    EMAILJS_VERIFY_TEMPLATE_ID: 'template_verify',
    EMAILJS_RESET_TEMPLATE_ID: 'template_reset',
    DATABASE_URL: 'postgresql://localhost/fixture_test',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    CSRF_SECRET: 'y'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
  };
  assert.equal(readEnvironment({}).EMAIL_ADAPTER, 'test-mailbox');
  assert.equal(readEnvironment(config).EMAIL_ADAPTER, 'emailjs');
  for (const key of ['EMAILJS_PRIVATE_KEY', 'REDIS_URL', 'EMAILJS_RESET_TEMPLATE_ID']) {
    assert.throws(() => readEnvironment({ ...config, [key]: undefined }), /EmailJS requires/);
  }
  assert.throws(() => readEnvironment({ ...config, EMAILJS_RESET_TEMPLATE_ID: config.EMAILJS_VERIFY_TEMPLATE_ID }), /distinct templates/);
  assert.throws(() => readEnvironment({ ...config, APP_MODE: 'synthetic-demo' }), /EmailJS requires/);
  assert.throws(() => readEnvironment({ NODE_ENV: 'production' }), /Production requires EmailJS/);
  assert.throws(() => readEnvironment({ ...config, NODE_ENV: 'production' }), /HTTPS frontend origin/);
  assert.equal(readEnvironment({ ...config, NODE_ENV: 'production', FRONTEND_URL: 'https://fit-tempo.example' }).EMAIL_ADAPTER, 'emailjs');
});
