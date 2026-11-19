import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { ImageMime, PrivateObjects } from './storage/index.js';
import { StorageError } from './storage/index.js';

/** The bucket must have public access blocked and no public object ACL or policy. */
export function createS3PrivateObjects(options: {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}): PrivateObjects {
  if (!options.bucket || !options.region) throw new Error('Private storage requires bucket and region.');
  const client = new S3Client({ region: options.region, endpoint: options.endpoint,
    forcePathStyle: options.forcePathStyle, credentials: options.credentials,
    requestHandler: undefined, maxAttempts: 1 });
  const bucket = options.bucket;
  const validKey = (key: string) => {
    if (!/^(pending|private)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key))
      throw new StorageError(400, 'INVALID_OBJECT_KEY', 'Invalid object key.');
    return key;
  };
  return {
    async grantUpload(key, { mimeType, maxBytes, expiresAt }) {
      validKey(key);
      if (!key.startsWith('pending/')) throw new Error('Direct grants must target pending keys.');
      const seconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
      if (seconds < 1 || seconds > 120) throw new Error('Invalid upload grant expiry.');
      const signed = await createPresignedPost(client, {
        Bucket: bucket, Key: key, Expires: seconds,
        Fields: { 'Content-Type': mimeType },
        Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', mimeType]],
      });
      return { url: signed.url, method: 'POST' as const, fields: signed.fields };
    },
    async readLimited(key, maxBytes, signal) {
      validKey(key);
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
      if (response.ContentLength !== undefined && response.ContentLength > maxBytes)
        throw new StorageError(413, 'FILE_TOO_LARGE', 'The file exceeds the upload limit.');
      if (!(response.Body instanceof Readable))
        throw new StorageError(503, 'STORAGE_UNAVAILABLE', 'Object stream unavailable.');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.Body) {
        size += chunk.length;
        if (size > maxBytes) {
          throw new StorageError(413, 'FILE_TOO_LARGE', 'The file exceeds the upload limit.');
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    async putPrivate(key, bytes, mimeType: ImageMime, signal) {
      validKey(key);
      if (!key.startsWith('private/')) throw new Error('Processed files require private keys.');
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes,
        ContentType: mimeType, CacheControl: 'private, no-store' }), { abortSignal: signal });
    },
    async grantRead(key, expiresAt) {
      validKey(key);
      if (!key.startsWith('private/')) throw new Error('Only processed files may be read.');
      const seconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
      if (seconds < 1 || seconds > 30) throw new Error('Invalid read grant expiry.');
      return { url: await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key,
        ResponseCacheControl: 'private, no-store' }), { expiresIn: seconds }) };
    },
    async remove(key) {
      validKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
