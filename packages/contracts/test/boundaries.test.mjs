import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decimalSchema, positiveDecimalSchema, quantitySchema, moneySchema,
  roleSchema, sourceIdentitySchema, revisionSchema, recordedTimeSchema,
  localDateSchema, timeZoneSchema, instantSchema, errorResponseSchema,
  decideMutationPrecondition, healthResponseSchema,
} from '../dist/index.js';

const id = '11111111-1111-4111-8111-111111111111';

test('decimal wire values preserve known zero and reject ambiguous or unbounded amounts', () => {
  for (const value of ['0', '0.000001', '999999999.999999']) assert.equal(decimalSchema.parse(value), value);
  for (const value of [0, NaN, Infinity, '-1', '01', '1.0', '1e3', '0.0000001', '1000000000']) {
    assert.equal(decimalSchema.safeParse(value).success, false, String(value));
  }
  assert.equal(positiveDecimalSchema.safeParse('0').success, false);
  assert.deepEqual(quantitySchema.parse({ value: '1', unit: 'cup' }), { value: '1', unit: 'cup' });
  assert.equal(quantitySchema.safeParse({ value: '1', unit: 'cup', grams: '240' }).success, false);
  assert.equal(moneySchema.safeParse({ amount: '2', currency: 'php' }).success, false);
});

test('recorded dates reject impossible dates and respect timezone midnight and DST', () => {
  for (const value of ['2026-02-29', '2026-04-31', '0000-01-01']) assert.equal(localDateSchema.safeParse(value).success, false);
  assert.equal(localDateSchema.parse('2024-02-29'), '2024-02-29');
  assert.equal(timeZoneSchema.safeParse('Mars/Olympus').success, false);
  for (const value of ['2026-11-16T00:00:00+08:00', '2026-11-16', '0000-01-01T00:00:00Z', '2026-11-16T00:00:00.000001Z']) {
    assert.equal(instantSchema.safeParse(value).success, false, value);
  }
  const event = { occurredAt: '2026-11-15T16:30:00Z', timeZone: 'Asia/Manila', localDate: '2026-11-16' };
  assert.deepEqual(recordedTimeSchema.parse(event), event);
  assert.equal(recordedTimeSchema.safeParse({ ...event, localDate: '2026-11-15' }).success, false);
  for (const occurredAt of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
    assert.equal(recordedTimeSchema.parse({ occurredAt, timeZone: 'America/New_York', localDate: '2026-11-01' }).localDate, '2026-11-01');
  }
});

test('roles, provenance and revisions remain explicit', () => {
  assert.equal(roleSchema.safeParse('superadmin').success, false);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER, '1']) assert.equal(revisionSchema.safeParse(value).success, false);
  assert.equal(sourceIdentitySchema.safeParse({ source: 'user', sourceRecordId: 'someone', revision: 0 }).success, false);
  assert.equal(sourceIdentitySchema.parse({ source: 'open_food_facts', sourceRecordId: '0012345678901', revision: 0 }).sourceRecordId, '0012345678901');
});

test('successful receipt replay takes precedence over a now-stale revision', () => {
  const payloadDigest = 'a'.repeat(64);
  const request = { payloadDigest, expectedRevision: 2, currentRevision: 9, receipt: { payloadDigest, resultReference: id } };
  assert.deepEqual(decideMutationPrecondition(request), { kind: 'replay', resultReference: id });
  assert.deepEqual(decideMutationPrecondition({ ...request, payloadDigest: 'b'.repeat(64) }), { kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(decideMutationPrecondition({ ...request, receipt: null }), { kind: 'conflict', code: 'REVISION_CONFLICT' });
  assert.deepEqual(decideMutationPrecondition({ ...request, receipt: null, currentRevision: 2 }), { kind: 'proceed' });
  assert.equal(errorResponseSchema.safeParse({ error: { code: 'REVISION_CONFLICT', message: 'Review changed records.', requestId: id, currentRevision: 9 } }).success, true);
});

test('Phase 03 health contract remains compatible', () => {
  const payload = { data: { status: 'ok', service: 'fit-tempo-api', mode: 'local', capabilities: { ai: false, email: 'test-mailbox', scheduler: 'manual-dry-run' } } };
  assert.deepEqual(healthResponseSchema.parse(payload), payload);
});
