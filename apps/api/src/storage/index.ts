import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

export type FileKind = 'food_photo' | 'profile_image' | 'progress_photo';
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export type StorageMetadata = {
  id: string; userId: string; kind: FileKind; objectKey: string;
  state: 'pending' | 'ready' | 'deleted'; expiresAt: Date | null; mimeType: ImageMime;
};
export type MetadataRepository = {
  createPending(record: StorageMetadata & { mimeType: ImageMime; byteSize: number }): Promise<void>;
  findOwned(userId: string, id: string): Promise<StorageMetadata | null>;
  finalizeIfPending(userId: string, id: string, updated: {
    objectKey: string; mimeType: ImageMime; byteSize: number;
  }): Promise<boolean>;
  markDeleted(userId: string, id: string): Promise<boolean>;
  markExpiredPending(userId: string, id: string, now: Date): Promise<boolean>;
  listExpiredPending(now: Date, limit: number): Promise<StorageMetadata[]>;
  enqueueDeletion(objectKey: string): Promise<void>;
  claimDeletions(limit: number): Promise<Array<{ objectKey: string; attempts: number; claimId: string }>>;
  completeDeletion(objectKey: string, claimId: string): Promise<void>;
  retryDeletion(objectKey: string, claimId: string, attempts: number): Promise<void>;
};
export type PrivateObjects = {
  // Direct grants must enforce key, MIME, size and expiry at the provider. API-mediated grants enforce these at the API.
  grantUpload(key: string, options: { mimeType: ImageMime; maxBytes: number; expiresAt: Date }): Promise<{
    url: string; method: 'POST' | 'PUT'; headers?: Record<string, string>; fields?: Record<string, string>;
  }>;
  readLimited(key: string, maxBytes: number, signal: AbortSignal): Promise<Buffer>;
  putPrivate(key: string, bytes: Buffer, mimeType: ImageMime, signal: AbortSignal): Promise<void>;
  putPending?(key: string, bytes: Buffer, mimeType: ImageMime, signal: AbortSignal): Promise<void>;
  grantRead(key: string, expiresAt: Date): Promise<{ url: string }>;
  remove(key: string): Promise<void>;
};
export class StorageError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const invalid = (code: string, message: string, status = 400) => new StorageError(status, code, message);
const mimeFormat: Record<ImageMime, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_UPLOAD = 2 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const UPLOAD_MS = 2 * 60_000;
const READ_MS = 30_000;
const DEADLINE_MS = 5_000;
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(invalid('STORAGE_TIMEOUT', 'Storage operation timed out.', 503)), DEADLINE_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function signature(bytes: Buffer): ImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Raw upload keys are never returned for reads; only sanitized, re-encoded bytes become ready. */
export function createPrivateStorageService(options: {
  metadata: MetadataRepository; objects: PrivateObjects; now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  async function authorize(input: { userId: string; kind: FileKind; mimeType: ImageMime; declaredBytes: number }) {
    if (!['food_photo','profile_image','progress_photo'].includes(input.kind)) throw invalid('INVALID_FILE_KIND', 'Invalid file kind.');
    if (!(input.mimeType in mimeFormat)) throw invalid('INVALID_FILE_TYPE', 'Only JPEG, PNG and WebP are supported.');
    if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 1 || input.declaredBytes > MAX_UPLOAD)
      throw invalid('FILE_TOO_LARGE', 'The file exceeds the upload limit.', 413);
    const id = randomUUID();
    const key = `pending/${input.userId}/${id}/${randomUUID()}`;
    const expiresAt = new Date(now().getTime() + UPLOAD_MS);
    const grant = await bounded(options.objects.grantUpload(key, {
      mimeType: input.mimeType, maxBytes: MAX_UPLOAD, expiresAt,
    }));
    await options.metadata.createPending({ id, userId: input.userId, kind: input.kind,
      objectKey: key, state: 'pending', expiresAt, mimeType: input.mimeType, byteSize: input.declaredBytes });
    return { id, expiresAt: expiresAt.toISOString(), upload: grant };
  }
  async function owned(userId: string, id: string) {
    const file = await options.metadata.findOwned(userId, id);
    if (!file || file.state === 'deleted') throw invalid('NOT_FOUND', 'File unavailable.', 404);
    return file;
  }
  async function receiveUpload(input: { userId: string; id: string; mimeType: ImageMime; bytes: Buffer }) {
    if (!options.objects.putPending) throw invalid('UPLOAD_UNAVAILABLE', 'Direct upload required.', 503);
    const file = await owned(input.userId, input.id);
    if (file.state !== 'pending') throw invalid('FILE_CONFLICT', 'File is already finalized.', 409);
    if (!file.expiresAt || file.expiresAt <= now()) throw invalid('FILE_EXPIRED', 'Upload grant expired.', 409);
    if (input.bytes.length < 1 || input.bytes.length > MAX_UPLOAD)
      throw invalid('FILE_TOO_LARGE', 'The file exceeds the upload limit.', 413);
    if (file.mimeType !== input.mimeType || signature(input.bytes) !== input.mimeType)
      throw invalid('INVALID_FILE_TYPE', 'Invalid image signature or content type.');
    await bounded(options.objects.putPending(file.objectKey, input.bytes, input.mimeType, AbortSignal.timeout(DEADLINE_MS)));
    return { id: input.id };
  }
  async function finalize(input: { userId: string; id: string }) {
    const file = await owned(input.userId, input.id);
    if (file.state !== 'pending') throw invalid('FILE_CONFLICT', 'File is already finalized.', 409);
    if (!file.expiresAt || file.expiresAt <= now()) throw invalid('FILE_EXPIRED', 'Upload grant expired.', 409);
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const bytes = await bounded(options.objects.readLimited(file.objectKey, MAX_UPLOAD, signal));
    if (bytes.length < 1 || bytes.length > MAX_UPLOAD) throw invalid('FILE_TOO_LARGE', 'The file exceeds the upload limit.', 413);
    const mime = signature(bytes);
    if (!mime || mime !== file.mimeType) throw invalid('INVALID_FILE_TYPE', 'Invalid image signature.');
    let metadata: { format?: string; width?: number; height?: number; pages?: number };
    try { metadata = await bounded(sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).timeout({ seconds: 5 }).metadata()); }
    catch { throw invalid('INVALID_IMAGE', 'Image cannot be decoded.'); }
    if (metadata.format !== mimeFormat[mime] || !metadata.width || !metadata.height ||
        metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1)
      throw invalid('INVALID_IMAGE', 'Image dimensions or format are unsupported.');
    let normalized: Buffer;
    try {
      const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).timeout({ seconds: 5 }).rotate();
      normalized = await bounded(mime === 'image/jpeg' ? image.jpeg({ quality: 85 }).toBuffer()
        : mime === 'image/png' ? image.png().toBuffer() : image.webp({ quality: 85 }).toBuffer());
    } catch { throw invalid('INVALID_IMAGE', 'Image cannot be decoded.'); }
    if (normalized.length > MAX_OUTPUT) throw invalid('FILE_TOO_LARGE', 'Processed image exceeds the limit.', 413);
    const cleanKey = `private/${input.userId}/${input.id}/${randomUUID()}`;
    await bounded(options.objects.putPrivate(cleanKey, normalized, mime, signal));
    let committed = false;
    try {
      committed = await options.metadata.finalizeIfPending(input.userId, input.id,
        { objectKey: cleanKey, mimeType: mime, byteSize: normalized.length });
    } catch (cause) {
      try { await options.metadata.enqueueDeletion(cleanKey); }
      catch { await bounded(options.objects.remove(cleanKey)).catch(() => undefined); }
      throw cause;
    }
    if (!committed) {
      try { await options.metadata.enqueueDeletion(cleanKey); }
      catch { await bounded(options.objects.remove(cleanKey)).catch(() => undefined); }
      throw invalid('FILE_CONFLICT', 'File is already finalized.', 409);
    }
    // The finalize transaction enqueues the raw object for durable removal.
    return { id: input.id, mimeType: mime, byteSize: normalized.length };
  }
  async function access(userId: string, id: string) {
    const file = await owned(userId, id);
    if (file.state !== 'ready') throw invalid('NOT_FOUND', 'File unavailable.', 404);
    return bounded(options.objects.grantRead(file.objectKey, new Date(now().getTime() + READ_MS)));
  }
  async function remove(userId: string, id: string) {
    await owned(userId, id);
    if (!await options.metadata.markDeleted(userId, id)) throw invalid('NOT_FOUND', 'File unavailable.', 404);
    // The metadata transition atomically enqueues deletion; reads are now denied.
  }
  async function expirePending(limit = 100) {
    // Allow signed uploads already in flight to finish before deleting their pending key.
    const cutoff = new Date(now().getTime() - 5 * 60_000);
    const rows = await options.metadata.listExpiredPending(cutoff, Math.min(Math.max(limit, 1), 100));
    for (const file of rows) {
      await options.metadata.markExpiredPending(file.userId, file.id, cutoff);
    }
    return rows.length;
  }
  async function cleanupDeletes(limit = 100) {
    const rows = await options.metadata.claimDeletions(Math.min(Math.max(limit, 1), 100));
    for (const row of rows) {
      try {
        await bounded(options.objects.remove(row.objectKey));
        await options.metadata.completeDeletion(row.objectKey, row.claimId);
      } catch {
        await options.metadata.retryDeletion(row.objectKey, row.claimId, row.attempts + 1);
      }
    }
    return rows.length;
  }
  return { authorize, receiveUpload, finalize, access, remove, expirePending, cleanupDeletes };
}
