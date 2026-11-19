import { Pool } from 'pg';
import { readEnvironment } from './config/env.js';
import { createPgFileMetadata } from './storage-pg.js';
import { createPrivateStorageService } from './storage/index.js';
import { createSupabasePrivateObjects } from './storage-supabase.js';

const config = readEnvironment();
if (!config.DATABASE_URL || !config.STORAGE_BUCKET || !config.STORAGE_REGION ||
    !config.STORAGE_ACCESS_KEY || !config.STORAGE_SECRET_KEY || !config.STORAGE_ENDPOINT)
  throw new Error('Private storage and database configuration are required.');

const db = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
try {
  const service = createPrivateStorageService({
    metadata: createPgFileMetadata(db),
    objects: createSupabasePrivateObjects({ bucket: config.STORAGE_BUCKET, region: config.STORAGE_REGION,
      endpoint: config.STORAGE_ENDPOINT,
      credentials: { accessKeyId: config.STORAGE_ACCESS_KEY, secretAccessKey: config.STORAGE_SECRET_KEY } }),
  });
  const expired = await service.expirePending(100);
  const deleted = await service.cleanupDeletes(100);
  console.info(`Private storage maintenance: ${expired} pending checked, ${deleted} deletions attempted.`);
} finally {
  await db.end();
}
