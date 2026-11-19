import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import sharp from 'sharp';
import { createAuthRouter } from '../dist/auth/router.js';
import { createTestMailbox } from '../dist/auth/mailbox.js';
import { createPrivateStorageService } from '../dist/storage/index.js';
import { createPgFileMetadata } from '../dist/storage-pg.js';
import { createSupabasePrivateObjects } from '../dist/storage-supabase.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a disposable migrated PostgreSQL database.');
const origin = 'http://localhost:5173';
const password = 'SyntheticStoragePassword!1';
const db = new Pool({ connectionString: databaseUrl, max: 4 });
const mailbox = createTestMailbox();
const records = new Map(), blobs = new Map();
const deletions = new Map();
let clock = Date.parse('2026-11-17T00:00:00Z');
let stall = false;
const metadata = {
  async createPending(row) { records.set(row.id, { ...row }); },
  async findOwned(userId, id) { const row = records.get(id); return row?.userId === userId ? { ...row } : null; },
  async finalizeIfPending(userId, id, update) {
    const row = records.get(id);
    if (!row || row.userId !== userId || row.state !== 'pending' || row.expiresAt <= new Date(clock)) return false;
    deletions.set(row.objectKey, 0);
    Object.assign(row, update, { state: 'ready', expiresAt: null }); return true;
  },
  async markDeleted(userId, id) {
    const row = records.get(id);
    if (!row || row.userId !== userId || row.state === 'deleted') return false;
    row.state = 'deleted'; deletions.set(row.objectKey, 0); return true;
  },
  async markExpiredPending(userId, id, now) {
    const row = records.get(id);
    if (!row || row.userId !== userId || row.state !== 'pending' || row.expiresAt > now) return false;
    row.state = 'deleted'; deletions.set(row.objectKey, 0); return true;
  },
  async listExpiredPending(now, limit) {
    return [...records.values()].filter(row => row.state === 'pending' && row.expiresAt <= now).slice(0, limit);
  },
  async enqueueDeletion(key) { deletions.set(key, 0); },
  async claimDeletions(limit) { return [...deletions].slice(0, limit).map(([objectKey, attempts]) => ({ objectKey, attempts })); },
  async completeDeletion(key) { deletions.delete(key); },
  async retryDeletion(key, attempts) { deletions.set(key, attempts); },
};
const objects = {
  async grantUpload(key, options) {
    if (stall) return new Promise(() => {});
    return { url: `https://private.invalid/upload/${key}`, method: 'PUT', headers: { 'content-type': options.mimeType } };
  },
  async readLimited(key, maxBytes, signal) {
    assert.equal(signal.aborted, false);
    const bytes = blobs.get(key);
    if (!bytes) throw new Error('Missing synthetic object');
    return bytes.subarray(0, maxBytes + 1);
  },
  async putPrivate(key, bytes) { blobs.set(key, bytes); },
  async putPending(key, bytes) { blobs.set(key, bytes); },
  async grantRead(key) { return { url: `https://private.invalid/read/${key}` }; },
  async remove(key) { blobs.delete(key); },
};
const live = process.env.FIT_TEMPO_LIVE_STORAGE_TEST === '1';
let liveObjects;
if (live) {
  const e = process.env;
  if (!['STORAGE_BUCKET', 'STORAGE_REGION', 'STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'].every(name => e[name]))
    throw new Error('Missing private storage test configuration.');
  liveObjects = createSupabasePrivateObjects({ bucket: e.STORAGE_BUCKET, region: e.STORAGE_REGION,
    endpoint: e.STORAGE_ENDPOINT, credentials: { accessKeyId: e.STORAGE_ACCESS_KEY, secretAccessKey: e.STORAGE_SECRET_KEY } });
}
const pgMetadata = live ? createPgFileMetadata(db) : null;
const storage = live ? createPrivateStorageService({ metadata: pgMetadata, objects: liveObjects })
  : createPrivateStorageService({ metadata, objects, now: () => new Date(clock) });
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use('/api/v1/auth', createAuthRouter({ db, sender: mailbox,
  jwtSecret: randomBytes(48).toString('base64url'), csrfSecret: randomBytes(48).toString('base64url'),
  frontendUrl: origin, production: false, storage }));
const server = createServer(app);

function jar() {
  const cookies = new Map();
  return {
    cookies,
    header() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
    absorb(response) {
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(';'); const index = pair.indexOf('=');
        if (index < 0) continue;
        if (pair.slice(index + 1)) cookies.set(pair.slice(0, index), pair.slice(index + 1));
        else cookies.delete(pair.slice(0, index));
      }
    },
  };
}

test('owned HTTP file grants, CSRF, content, expiry, deadline and revoked sessions', async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1/auth`;
  const owner = jar(), other = jar(), anonymous = jar();
  async function request(client, path, { method = 'GET', body, bytes, mimeType = 'image/jpeg', csrf = true } = {}) {
    const response = await fetch(base + path, { method, headers: {
      ...(client.header() ? { cookie: client.header() } : {}),
      ...(method !== 'GET' ? { origin, ...(csrf ? { 'x-csrf-token': client.cookies.get('fitness_dev_csrf') ?? '' } : {}) } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(bytes ? { 'content-type': mimeType } : {}),
    }, body: bytes ?? (body ? JSON.stringify(body) : undefined) });
    client.absorb(response);
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  async function signIn(client) {
    const email = `phase07-${randomBytes(8).toString('hex')}@example.invalid`;
    assert.equal((await request(client, '/csrf')).status, 200);
    assert.equal((await request(client, '/register', { method: 'POST', body: { email, password } })).status, 202);
    const token = new URL(mailbox.messages.at(-1).url).searchParams.get('token');
    assert.equal((await request(client, '/verify-email', { method: 'POST', body: { token } })).status, 200);
    assert.equal((await request(client, '/login', { method: 'POST', body: { email, password } })).status, 200);
    return (await request(client, '/me')).body.data.id;
  }
  const photo = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#456789' } }).jpeg().toBuffer();
  const payload = { kind: 'food_photo', mimeType: 'image/jpeg', declaredBytes: photo.length };
  try {
    const ownerId = await signIn(owner);
    await signIn(other);
    assert.equal((await request(anonymous, '/files/grants', { method: 'POST', body: payload })).status, 403);
    assert.equal((await request(owner, '/files/grants', { method: 'POST', body: payload, csrf: false })).status, 403);
    assert.equal((await request(owner, '/files/grants', { method: 'POST', body: { ...payload, declaredBytes: 2_097_153 } })).status, 413);
    const grant = await request(owner, '/files/grants', { method: 'POST', body: payload });
    assert.equal(grant.status, 201);
    const id = grant.body.data.id;
    if (live) {
      const content = `/files/${id}/content`;
      assert.equal((await request(other, content, { method: 'PUT', bytes: photo })).status, 404);
      assert.equal((await request(owner, content, { method: 'PUT', bytes: photo, csrf: false })).status, 403);
      assert.equal((await request(owner, content, { method: 'PUT', bytes: photo })).status, 204);
      const pending = await pgMetadata.findOwned(ownerId, id);
      assert.equal((await request(owner, `/files/${id}/finalize`, { method: 'POST' })).status, 200);
      const ready = await pgMetadata.findOwned(ownerId, id);
      assert.equal(ready.state, 'ready');
      assert.equal((await request(other, `/files/${id}/access`)).status, 404);
      const access = await request(owner, `/files/${id}/access`);
      assert.equal(access.status, 200);
      const signed = await fetch(access.body.data.url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      assert.equal(signed?.status, 200);
      assert.equal((await sharp(Buffer.from(await signed.arrayBuffer())).metadata()).format, 'jpeg');
      assert.equal((await request(owner, `/files/${id}`, { method: 'DELETE' })).status, 204);
      assert.equal((await request(owner, `/files/${id}/access`)).status, 404);

      // Drive only the two keys generated by this test through the real retry store.
      const keys = [pending.objectKey, ready.objectKey];
      const scoped = { ...pgMetadata, async claimDeletions() {
        const result = await db.query(`UPDATE file_object_deletions SET claim_id=gen_random_uuid(),
          claimed_until=now()+interval '30 seconds' WHERE object_key=ANY($1) AND next_attempt_at<=now()
          AND (claimed_until IS NULL OR claimed_until<now())
          RETURNING object_key AS "objectKey", claim_id AS "claimId", attempts`, [keys]);
        return result.rows;
      } };
      const failing = createPrivateStorageService({ metadata: scoped, objects: {
        ...liveObjects, async remove() { throw new Error('Injected transient failure'); },
      } });
      assert.equal(await failing.cleanupDeletes(2), 2);
      const retry = await db.query(`SELECT attempts,claim_id,claimed_until,next_attempt_at>now() AS deferred
        FROM file_object_deletions WHERE object_key=ANY($1)`, [keys]);
      assert.equal(retry.rowCount, 2);
      for (const row of retry.rows)
        assert.deepEqual(row, { attempts: 1, claim_id: null, claimed_until: null, deferred: true });
      await db.query('UPDATE file_object_deletions SET next_attempt_at=now() WHERE object_key=ANY($1)', [keys]);
      const worker = createPrivateStorageService({ metadata: scoped, objects: liveObjects });
      assert.equal(await worker.cleanupDeletes(2), 2);
      assert.equal((await db.query('SELECT 1 FROM file_object_deletions WHERE object_key=ANY($1)', [keys])).rowCount, 0);
      for (const key of keys) {
        await assert.rejects(liveObjects.readLimited(key, 2_097_152, AbortSignal.timeout(5000)),
          error => error?.$metadata?.httpStatusCode === 404);
      }
      return;
    }
    assert.equal(records.get(id).userId, ownerId);
    assert.ok(grant.body.data.upload.url.includes('/pending/'));
    assert.equal((await request(other, `/files/${id}/access`)).status, 404);
    assert.equal((await request(owner, `/files/${id}/access`)).status, 404);
    assert.equal((await request(other, `/files/${id}/finalize`, { method: 'POST' })).status, 404);
    assert.equal((await request(other, `/files/${id}/content`, { method: 'PUT', bytes: photo })).status, 404);
    assert.equal((await request(owner, `/files/${id}/content`, { method: 'PUT', bytes: photo, csrf: false })).status, 403);
    assert.equal((await request(owner, `/files/${id}/content`, { method: 'PUT', bytes: photo, mimeType: 'image/png' })).status, 400);
    assert.equal((await request(owner, `/files/${id}/content`, { method: 'PUT', bytes: Buffer.alloc(2_097_153) })).status, 413);
    assert.equal((await request(owner, `/files/${id}/content`, { method: 'PUT', bytes: photo })).status, 204);
    blobs.set(records.get(id).objectKey, Buffer.from('<svg><script>alert(1)</script></svg>'));
    assert.equal((await request(owner, `/files/${id}/finalize`, { method: 'POST' })).status, 400);
    blobs.set(records.get(id).objectKey, photo);
    assert.equal((await request(owner, `/files/${id}/finalize`, { method: 'POST' })).status, 200);
    assert.equal((await request(owner, `/files/${id}/access`)).status, 200);
    assert.equal((await request(other, `/files/${id}/access`)).status, 404);
    assert.equal((await request(other, `/files/${id}`, { method: 'DELETE' })).status, 404);
    const expiring = await request(owner, '/files/grants', { method: 'POST', body: payload });
    blobs.set(records.get(expiring.body.data.id).objectKey, photo);
    clock += 121_000;
    assert.equal((await request(owner, `/files/${expiring.body.data.id}/finalize`, { method: 'POST' })).status, 409);
    stall = true;
    assert.equal((await request(owner, '/files/grants', { method: 'POST', body: payload })).status, 503);
    stall = false;
    assert.equal((await request(owner, '/logout', { method: 'POST' })).status, 200);
    assert.equal((await request(owner, `/files/${id}/access`)).status, 401);
  } finally {
    server.close(); await once(server, 'close'); await db.end();
  }
});
