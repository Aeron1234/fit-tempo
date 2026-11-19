import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import sharp from 'sharp';
import { createS3PrivateObjects } from '../dist/storage-s3.js';
import { createSupabasePrivateObjects } from '../dist/storage-supabase.js';

const objectKey = () => `private/${randomUUID()}/${randomUUID()}/${randomUUID()}`;

test('S3 adapter aborts a stalled provider request', async () => {
  let received = false;
  const server = createServer(() => { received = true; });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const storage = createS3PrivateObjects({
      bucket: 'test', region: 'test', forcePathStyle: true,
      endpoint: `http://127.0.0.1:${server.address().port}`,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    });
    await assert.rejects(storage.readLimited(objectKey(), 1024, AbortSignal.timeout(1000)),
      { name: 'AbortError' });
    assert.equal(received, true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Supabase rejects oversized and disallowed MIME uploads', {
  skip: process.env.FIT_TEMPO_LIVE_STORAGE_TEST !== '1',
}, async () => {
  const e = process.env;
  const storage = createSupabasePrivateObjects({
    bucket: e.STORAGE_BUCKET, region: e.STORAGE_REGION, endpoint: e.STORAGE_ENDPOINT,
    credentials: { accessKeyId: e.STORAGE_ACCESS_KEY, secretAccessKey: e.STORAGE_SECRET_KEY },
  });
  const signal = () => AbortSignal.timeout(10000);
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#134e4a' } })
    .jpeg().toBuffer();
  const control = objectKey();
  try {
    await storage.putPrivate(control, jpeg, 'image/jpeg', signal());
    assert.deepEqual(await storage.readLimited(control, 1024, signal()), jpeg);
  } finally {
    await storage.remove(control);
  }

  async function expectRejection(bytes, mime, statuses, reason) {
    const key = objectKey();
    try {
      await storage.putPrivate(key, bytes, mime, signal());
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      const detail = [error?.name, error?.Code, error?.message].join(' ');
      const matched = statuses.includes(status) && reason.test(detail);
      assert.ok(matched, `Unexpected provider response (HTTP ${status ?? 'unavailable'})`);
      return;
    }
    await storage.remove(key);
    assert.fail('Supabase unexpectedly accepted a disallowed fixture');
  }

  const oversized = Buffer.alloc(2_097_153);
  jpeg.copy(oversized);
  await expectRejection(oversized, 'image/jpeg', [400, 413], /EntityTooLarge|PayloadTooLarge|size|too large|maximum/i);
  await expectRejection(Buffer.from('synthetic fixture'), 'text/plain', [400, 403, 415], /mime|media type|content.type/i);
});
