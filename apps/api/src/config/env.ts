import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
  APP_MODE: z.enum(['local', 'synthetic-demo']).default('local'),
  FOOD_ADAPTER: z.enum(['fixtures', 'live']).default('fixtures'),
  USDA_API_KEY: z.string().trim().min(1).optional(),
  OPEN_FOOD_FACTS_USER_AGENT: z.string().trim().min(8).max(200).regex(/^[\x20-\x7e]+$/).optional(),
  AI_ADAPTER: z.enum(['disabled', 'synthetic', 'groq-synthetic']).default('disabled'),
  GROQ_API_KEY: z.string().trim().min(1).optional(),
  GROQ_MODEL: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/).optional(),
  EMAIL_ADAPTER: z.enum(['test-mailbox', 'emailjs']).default('test-mailbox'),
  EMAILJS_SERVICE_ID: z.string().trim().min(1).optional(),
  EMAILJS_PUBLIC_KEY: z.string().trim().min(1).optional(),
  EMAILJS_PRIVATE_KEY: z.string().trim().min(1).optional(),
  EMAILJS_VERIFY_TEMPLATE_ID: z.string().trim().min(1).optional(),
  EMAILJS_RESET_TEMPLATE_ID: z.string().trim().min(1).optional(),
  SCHEDULER_MODE: z.enum(['manual-dry-run', 'hobby-daily']).default('manual-dry-run'),
  CRON_SECRET: z.string().regex(/^[!-~]{32,256}$/).optional(),
  NOTIFICATION_TEST_RECIPIENT: z.email().optional(),
  EMAILJS_REMINDER_TEMPLATE_ID: z.string().trim().min(1).optional(),
  EMAILJS_SUMMARY_TEMPLATE_ID: z.string().trim().min(1).optional(),
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

  const authFields = [result.data.DATABASE_URL, result.data.JWT_ACCESS_SECRET, result.data.CSRF_SECRET];
  const email = result.data;
  if (email.NODE_ENV === 'production' &&
      (email.EMAIL_ADAPTER !== 'emailjs' || email.APP_MODE !== 'local' || new URL(email.FRONTEND_URL).protocol !== 'https:')) {
    throw new Error('Production requires EmailJS, local app mode and an HTTPS frontend origin.');
  }
  if (email.EMAIL_ADAPTER === 'emailjs') {
    const origin = new URL(email.FRONTEND_URL);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (!authFields.every(Boolean) || !email.REDIS_URL || email.APP_MODE !== 'local' ||
        !(email.EMAILJS_SERVICE_ID && email.EMAILJS_PUBLIC_KEY && email.EMAILJS_PRIVATE_KEY &&
          email.EMAILJS_VERIFY_TEMPLATE_ID && email.EMAILJS_RESET_TEMPLATE_ID) ||
        email.EMAILJS_VERIFY_TEMPLATE_ID === email.EMAILJS_RESET_TEMPLATE_ID ||
        (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) {
      throw new Error('EmailJS requires auth, Redis, local app mode, a secure frontend origin, credentials and two distinct templates.');
    }
  }
  if (authFields.some(Boolean) && !authFields.every(Boolean)) {
    throw new Error('Database and auth secret configuration must be supplied together.');
  }
  if (result.data.REDIS_URL && !authFields.every(Boolean)) {
    throw new Error('Redis limits require the complete auth configuration.');
  }
  if (email.NOTIFICATION_TEST_RECIPIENT && (
    email.SCHEDULER_MODE !== 'hobby-daily' || email.EMAIL_ADAPTER !== 'emailjs' || !email.CRON_SECRET ||
    !email.EMAILJS_REMINDER_TEMPLATE_ID || !email.EMAILJS_SUMMARY_TEMPLATE_ID ||
    new Set([email.EMAILJS_VERIFY_TEMPLATE_ID, email.EMAILJS_RESET_TEMPLATE_ID,
      email.EMAILJS_REMINDER_TEMPLATE_ID, email.EMAILJS_SUMMARY_TEMPLATE_ID]).size !== 4
  )) {
    throw new Error('Scheduled inbox testing requires Hobby mode, cron authentication, EmailJS and distinct notification templates.');
  }
  if (result.data.AI_ADAPTER !== 'disabled' && !result.data.REDIS_URL) {
    throw new Error('Food recognition requires Redis quotas.');
  }
  if (result.data.AI_ADAPTER === 'synthetic' && result.data.APP_MODE !== 'synthetic-demo') {
    throw new Error('The mock food recognizer requires synthetic-demo mode.');
  }
  if (result.data.AI_ADAPTER === 'groq-synthetic' && !(result.data.GROQ_API_KEY && result.data.GROQ_MODEL)) {
    throw new Error('Groq synthetic food recognition requires a server key and model.');
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
