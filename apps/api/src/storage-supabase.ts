import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createS3PrivateObjects } from './storage-s3.js';
import { StorageError, type ImageMime, type PrivateObjects } from './storage/index.js';

/** Server-side Supabase S3 credentials bypass RLS. Never expose them to the browser. */
export function createSupabasePrivateObjects(options: {
  bucket: string;
  region: string;
  endpoint: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}): PrivateObjects {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.storage\.supabase\.co$/.test(endpoint.hostname) ||
      endpoint.pathname.replace(/\/$/, '') !== '/storage/v1/s3' || endpoint.search || endpoint.hash)
    throw new Error('Supabase Storage requires its direct HTTPS S3 endpoint.');
  const base = createS3PrivateObjects({ ...options, forcePathStyle: true });
  const client = new S3Client({ region: options.region, endpoint: options.endpoint,
    forcePathStyle: true, credentials: options.credentials, maxAttempts: 1 });
  return {
    ...base,
    // A same-origin API route enforces auth, CSRF, exact MIME, <=2 MiB, and expiry.
    async grantUpload(key, { mimeType }) {
      const match = /^pending\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/[0-9a-f-]{36}$/.exec(key);
      if (!match) throw new StorageError(400, 'INVALID_OBJECT_KEY', 'Invalid object key.');
      return { url: `/api/v1/me/uploads/${match[2]}/content`, method: 'PUT' as const,
        headers: { 'Content-Type': mimeType } };
    },
    async putPending(key, bytes, mimeType: ImageMime, signal) {
      if (!/^pending\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key))
        throw new StorageError(400, 'INVALID_OBJECT_KEY', 'Invalid object key.');
      await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes,
        ContentType: mimeType, CacheControl: 'private, no-store' }), { abortSignal: signal });
    },
  };
}
