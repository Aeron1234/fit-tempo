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

test('recognition defaults off and only explicit synthetic modes can enable it', () => {
  assert.equal(readEnvironment({}).AI_ADAPTER, 'disabled');
  assert.equal(readEnvironment({ ...development, AI_ADAPTER: 'synthetic' }).AI_ADAPTER, 'synthetic');
  assert.throws(() => readEnvironment({ ...development, APP_MODE: 'local', AI_ADAPTER: 'synthetic' }), /synthetic-demo/);
  assert.throws(() => readEnvironment({ ...development, REDIS_URL: undefined, AI_ADAPTER: 'synthetic' }), /Redis quotas/);
  assert.throws(() => readEnvironment({ ...development, AI_ADAPTER: 'gemini-synthetic' }), /server key and model/);
  const gemini = { ...development, AI_ADAPTER: 'gemini-synthetic', GEMINI_API_KEY: 'synthetic-key', GEMINI_MODEL: 'gemini-fixture' };
  assert.equal(readEnvironment(gemini).AI_ADAPTER, 'gemini-synthetic');
  assert.throws(() => readEnvironment({ ...gemini, NODE_ENV: 'production' }), /Production requires EmailJS/);
  assert.throws(() => readEnvironment({ ...development, AI_ADAPTER: 'live' }), /AI_ADAPTER/);
});
