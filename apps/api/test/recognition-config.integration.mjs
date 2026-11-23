import assert from 'node:assert/strict';
import test from 'node:test';
import { readEnvironment } from '../dist/config/env.js';

const development = {
  APP_MODE: 'synthetic-demo',
  DATABASE_URL: 'postgres://fixture:fixture@localhost/fixture_test',
  JWT_ACCESS_SECRET: 'fixture-access-secret-0000000000000',
  CSRF_SECRET: 'fixture-csrf-secret-000000000000000',
  REDIS_URL: 'redis://localhost:6379',
};

test('recognition defaults off and hosted Groq can analyze approved samples with Redis and EmailJS', () => {
  assert.equal(readEnvironment({}).AI_ADAPTER, 'disabled');
  assert.equal(readEnvironment({ ...development, AI_ADAPTER: 'synthetic' }).AI_ADAPTER, 'synthetic');
  assert.throws(() => readEnvironment({ ...development, APP_MODE: 'local', AI_ADAPTER: 'synthetic' }), /synthetic-demo/);
  assert.throws(() => readEnvironment({ ...development, REDIS_URL: undefined, AI_ADAPTER: 'synthetic' }), /Redis quotas/);
  assert.throws(() => readEnvironment({ ...development, AI_ADAPTER: 'groq-synthetic' }), /server key and model/);
  const groq = { ...development, AI_ADAPTER: 'groq-synthetic', GROQ_API_KEY: 'synthetic-key', GROQ_MODEL: 'qwen/qwen3.8-27b' };
  assert.equal(readEnvironment(groq).AI_ADAPTER, 'groq-synthetic');
  assert.throws(() => readEnvironment({ ...groq, NODE_ENV: 'production' }), /Production requires EmailJS/);
  const hosted = { ...groq, NODE_ENV: 'production', APP_MODE: 'local',
    FRONTEND_URL: 'https://staging.example.invalid', EMAIL_ADAPTER: 'emailjs',
    EMAILJS_SERVICE_ID: 'fixture', EMAILJS_PUBLIC_KEY: 'fixture', EMAILJS_PRIVATE_KEY: 'fixture',
    EMAILJS_VERIFY_TEMPLATE_ID: 'verify', EMAILJS_RESET_TEMPLATE_ID: 'reset' };
  assert.equal(readEnvironment(hosted).AI_ADAPTER, 'groq-synthetic');
  assert.throws(() => readEnvironment({ ...hosted, GROQ_API_KEY: undefined }), /server key and model/);
  assert.throws(() => readEnvironment({ ...hosted, AI_ADAPTER: 'synthetic' }), /synthetic-demo/);
  assert.throws(() => readEnvironment({ ...development, AI_ADAPTER: 'live' }), /AI_ADAPTER/);
});
