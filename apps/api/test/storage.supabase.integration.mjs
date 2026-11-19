import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createPrivateStorageService } from '../dist/storage/index.js';

test('API-mediated private upload checks owner, MIME, size and expiry', async () => {
  let time = Date.parse('2026-11-17T00:00:00Z');
  const rows = new Map(), pending = new Map();
  const metadata = {
    async createPending(row) { rows.set(row.id, row); },
    async findOwned(userId, id) { const row = rows.get(id); return row?.userId === userId ? row : null; },
  };
  const objects = {
    async grantUpload(key) { return { url: `/api/v1/me/uploads/${key.split('/')[2]}/content`, method: 'PUT' }; },
    async putPending(key, bytes, mime) { pending.set(key, { bytes, mime }); },
  };
  const service = createPrivateStorageService({ metadata, objects, now: () => new Date(time) });
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  const grant = await service.authorize({ userId: 'owner', kind: 'food_photo', mimeType: 'image/jpeg', declaredBytes: jpeg.length });
  const key = rows.get(grant.id).objectKey;
  await assert.rejects(service.receiveUpload({ userId: 'other', id: grant.id, mimeType: 'image/jpeg', bytes: jpeg }),
    error => error.status === 404);
  await assert.rejects(service.receiveUpload({ userId: 'owner', id: grant.id, mimeType: 'image/png', bytes: jpeg }),
    error => error.code === 'INVALID_FILE_TYPE');
  await assert.rejects(service.receiveUpload({ userId: 'owner', id: grant.id, mimeType: 'image/jpeg', bytes: Buffer.alloc(2_097_153, 0xff) }),
    error => error.status === 413);
  assert.equal(pending.size, 0);
  assert.deepEqual(await service.receiveUpload({ userId: 'owner', id: grant.id, mimeType: 'image/jpeg', bytes: jpeg }), { id: grant.id });
  assert.equal(pending.get(key).mime, 'image/jpeg');
  const late = await service.authorize({ userId: 'owner', kind: 'food_photo', mimeType: 'image/jpeg', declaredBytes: jpeg.length });
  time += 121_000;
  await assert.rejects(service.receiveUpload({ userId: 'owner', id: late.id, mimeType: 'image/jpeg', bytes: jpeg }),
    error => error.code === 'FILE_EXPIRED');
});
