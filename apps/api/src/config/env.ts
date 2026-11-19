import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
  APP_MODE: z.enum(['local', 'synthetic-demo']).default('local'),
  FOOD_ADAPTER: z.enum(['fixtures', 'live']).default('fixtures'),
  USDA_API_KEY: z.string().trim().min(1).optional(),
  OPEN_FOOD_FACTS_USER_AGENT: z.string().trim().min(8).max(200).regex(/^[\x20-\x7e]+$/).optional(),
  AI_ADAPTER: z.literal('disabled').default('disabled'),
  EMAIL_ADAPTER: z.literal('test-mailbox').default('test-mailbox'),
  SCHEDULER_MODE: z.literal('manual-dry-run').default('manual-dry-run'),
  DATABASE_URL: z.string().min(1).optional(),
  JWT_ACCESS_SECRET: z.string().min(32).optional(),
  CSRF_SECRET: z.string().min(32).optional(),
  REDIS_URL: z.url().optional(),
  STORAGE_PROVIDER: z.literal('supabase').optional(),
  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().min(1).optional(),
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_ACCESS_KEY: z.string().min(1).optional(),
  STORAGE_SECRET_KEY: z.string().min(1).optional(),
});

export function readEnvironment(input: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    // Report field names only. Invalid values may contain credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid API configuration fields: ${fields.join(', ')}`);
  }

  if (result.data.NODE_ENV === 'production') {
    throw new Error('Phase 03 local adapters are unavailable in production.');
  }

  const authFields = [result.data.DATABASE_URL, result.data.JWT_ACCESS_SECRET, result.data.CSRF_SECRET];
  if (authFields.some(Boolean) && !authFields.every(Boolean)) {
    throw new Error('Database and auth secret configuration must be supplied together.');
  }
  if (result.data.REDIS_URL && !authFields.every(Boolean)) {
    throw new Error('Redis limits require the complete auth configuration.');
  }
  if (result.data.FOOD_ADAPTER === 'live' && (
    result.data.APP_MODE !== 'local' || !result.data.REDIS_URL ||
    !(result.data.USDA_API_KEY || result.data.OPEN_FOOD_FACTS_USER_AGENT)
  )) {
    throw new Error('Live food lookup requires local mode, Redis, and at least one configured provider.');
  }
  const storageFields = [result.data.STORAGE_REGION, result.data.STORAGE_BUCKET,
    result.data.STORAGE_ACCESS_KEY, result.data.STORAGE_SECRET_KEY];
  if (storageFields.some(Boolean) && !storageFields.every(Boolean)) {
    throw new Error('Private storage requires region, bucket and both access credentials.');
  }
  if (storageFields.every(Boolean) && !authFields.every(Boolean)) {
    throw new Error('Private storage requires the complete auth configuration.');
  }
  if (result.data.STORAGE_ENDPOINT && !storageFields.every(Boolean)) {
    throw new Error('Storage endpoint configuration requires private storage credentials.');
  }
  if (storageFields.every(Boolean) && (!result.data.STORAGE_PROVIDER || !result.data.STORAGE_ENDPOINT)) {
    throw new Error('Private storage requires a provider and endpoint.');
  }
  if (result.data.STORAGE_PROVIDER && !storageFields.every(Boolean)) {
    throw new Error('Private storage provider requires complete storage configuration.');
  }
  if (result.data.STORAGE_PROVIDER && !/^https:\/\/[a-z0-9-]+\.storage\.supabase\.co\/storage\/v1\/s3\/?$/.test(result.data.STORAGE_ENDPOINT ?? '')) {
    throw new Error('Supabase storage requires its HTTPS S3 endpoint.');
  }

  return result.data;
}
