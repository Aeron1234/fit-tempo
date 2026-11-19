import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createPrivateStorageService, StorageError } from '../dist/storage/index.js';

test('private grants, content validation, ownership, expiry and deadlines', async () => {
  let time = Date.parse('2026-11-17T00:00:00Z');
  const records = new Map(), blobs = new Map();
  const deletions = new Map();
  const metadata = {
    async createPending(row) { records.set(row.id, { ...row }); },
    async findOwned(userId, id) { const row = records.get(id); return row?.userId === userId ? { ...row } : null; },
    async finalizeIfPending(userId, id, update) {
      const row = records.get(id);
      if (!row || row.userId !== userId || row.state !== 'pending') return false;
      const rawKey = row.objectKey;
      Object.assign(row, update, { state: 'ready' });
      deletions.set(rawKey, { objectKey: rawKey, attempts: 0, claimId: rawKey });
      return true;
    },
    async markDeleted(userId, id) { const row = records.get(id); if (!row || row.userId !== userId) return false; row.state = 'deleted'; deletions.set(row.objectKey, { objectKey: row.objectKey, attempts: 0, claimId: row.objectKey }); return true; },
    async markExpiredPending(userId, id, now) {
      const row = records.get(id);
      if (!row || row.userId !== userId || row.state !== 'pending' || row.expiresAt > now) return false;
      row.state = 'deleted'; deletions.set(row.objectKey, { objectKey: row.objectKey, attempts: 0, claimId: row.objectKey }); return true;
    },
    async listExpiredPending(now, limit) { return [...records.values()].filter(row => row.state === 'pending' && row.expiresAt <= now).slice(0, limit); },
    async enqueueDeletion(key) { deletions.set(key, { objectKey: key, attempts: 0, claimId: key }); },
    async claimDeletions(limit) { return [...deletions.values()].slice(0, limit); },
    async completeDeletion(key) { deletions.delete(key); },
    async retryDeletion(key, _claim, attempts) { deletions.get(key).attempts = attempts; },
  };
  const objects = {
    async grantUpload(key, options) { return { url: `https://private.invalid/upload/${key}`, method: 'PUT', headers: { 'content-type': options.mimeType } }; },
    async readLimited(key, max, signal) { assert.equal(signal.aborted, false); const bytes = blobs.get(key); if (!bytes) throw new Error('Missing upload'); return bytes.subarray(0, max + 1); },
    async putPrivate(key, bytes) { blobs.set(key, bytes); },
    async grantRead(key, expiry) { assert.ok(expiry.getTime() > time); return { url: `https://private.invalid/read/${key}` }; },
    async remove(key) { blobs.delete(key); },
  };
  const service = createPrivateStorageService({ metadata, objects, now: () => new Date(time) });
  const photo = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#456789' } }).jpeg().toBuffer();
  const grant = await service.authorize({ userId: 'owner', kind: 'food_photo', mimeType: 'image/jpeg', declaredBytes: photo.length });
  const rawKey = records.get(grant.id).objectKey;
  assert.ok(grant.upload.url.includes('/upload/pending/owner/'));
  await assert.rejects(service.access('other', grant.id), error => error instanceof StorageError && error.status === 404);
  await assert.rejects(service.access('owner', grant.id), error => error.status === 404);
  blobs.set(rawKey, Buffer.from('<svg><script>alert(1)</script></svg>'));
  await assert.rejects(service.finalize({ userId: 'owner', id: grant.id }), error => error.code === 'INVALID_FILE_TYPE');
  assert.equal(records.get(grant.id).state, 'pending');
  blobs.set(rawKey, photo);
  await service.finalize({ userId: 'owner', id: grant.id });
  assert.equal(records.get(grant.id).state, 'ready');
  assert.equal(blobs.has(rawKey), true);
  assert.equal(await service.cleanupDeletes(), 1);
  assert.equal(blobs.has(rawKey), false);
  assert.ok((await service.access('owner', grant.id)).url.includes('/read/private/owner/'));
  await assert.rejects(service.finalize({ userId: 'owner', id: grant.id }), error => error.status === 409);
  await assert.rejects(service.authorize({ userId: 'owner', kind: 'food_photo', mimeType: 'image/svg+xml', declaredBytes: 50 }), error => error.code === 'INVALID_FILE_TYPE');
  await assert.rejects(service.authorize({ userId: 'owner', kind: 'food_photo', mimeType: 'image/jpeg', declaredBytes: 2_097_153 }), error => error.status === 413);
  const expiring = await service.authorize({ userId: 'owner', kind: 'progress_photo', mimeType: 'image/jpeg', declaredBytes: photo.length });
  blobs.set(records.get(expiring.id).objectKey, photo);
  time += 121_000;
  await assert.rejects(service.finalize({ userId: 'owner', id: expiring.id }), error => error.code === 'FILE_EXPIRED');
  assert.equal(await service.expirePending(), 0);
  time += 5 * 60_000;
  assert.equal(await service.expirePending(), 1);
  assert.equal(records.get(expiring.id).state, 'deleted');
  const slow = createPrivateStorageService({ metadata, objects: {
    ...objects, grantUpload: () => new Promise(() => {}),
  } });
  await assert.rejects(slow.authorize({ userId: 'owner', kind: 'food_photo',
    mimeType: 'image/jpeg', declaredBytes: photo.length }), error => error.code === 'STORAGE_TIMEOUT');
});
