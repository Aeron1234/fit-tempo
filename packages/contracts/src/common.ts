import { z } from 'zod';

export const uuidSchema = z.uuid();
export const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const clientOperationIdSchema = uuidSchema;
export const roleSchema = z.enum(['trainee', 'admin']);

// PostgreSQL numeric values cross JSON as canonical decimal strings.
// Bounds are 9 integer and 6 fractional digits. Arithmetic belongs to decimal-aware services.
export const decimalSchema = z.string().max(16)
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{0,5}[1-9])?$/);
export const positiveDecimalSchema = decimalSchema.refine((value) => value !== '0', {
  message: 'A positive decimal is required.',
});
export const unitSchema = z.enum(['g', 'kg', 'mg', 'ml', 'l', 'count', 'serving', 'cup', 'tbsp', 'tsp', 'cm', 'm', 'km', 's', 'min']);
export const foodUnitSchema = z.enum(['g', 'kg', 'mg', 'ml', 'l', 'count', 'serving', 'cup', 'tbsp', 'tsp']);
export const quantitySchema = z.strictObject({ value: positiveDecimalSchema, unit: foodUnitSchema }).readonly();
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const moneySchema = z.strictObject({ amount: decimalSchema, currency: currencySchema }).readonly();

const sourceRecordIdSchema = z.string().min(1).max(128);
export const sourceIdentitySchema = z.strictObject({
  source: z.enum(['curated', 'user', 'usda', 'open_food_facts']),
  sourceRecordId: sourceRecordIdSchema,
  revision: revisionSchema,
}).superRefine((value, context) => {
  if ((value.source === 'curated' || value.source === 'user') && !uuidSchema.safeParse(value.sourceRecordId).success) {
    context.addIssue({ code: 'custom', path: ['sourceRecordId'], message: 'Local sources require a UUID.' });
  }
  if ((value.source === 'usda' || value.source === 'open_food_facts') && !/^\d{1,32}$/.test(value.sourceRecordId)) {
    context.addIssue({ code: 'custom', path: ['sourceRecordId'], message: 'External food sources require their numeric source identity.' });
  }
}).readonly();

// These are trusted server records for authorization checks, never client authority.
export const resourceVisibilitySchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('private'), ownerUserId: uuidSchema }),
  z.strictObject({ scope: z.literal('shared'), state: z.enum(['draft', 'approved', 'retired']) }),
]);
export const fileReferenceSchema = z.strictObject({
  fileId: uuidSchema,
  ownerUserId: uuidSchema,
  state: z.enum(['pending', 'ready', 'deleted']),
});

export const errorCodeSchema = z.enum([
  'VALIDATION_ERROR', 'UNAUTHENTICATED', 'FORBIDDEN', 'CSRF_INVALID', 'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'SCHEDULE_CONFLICT', 'PANTRY_CONFLICT', 'PROPOSAL_EXPIRED',
  'INSUFFICIENT_PANTRY', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'INTERNAL_ERROR',
]);
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1).max(300),
    requestId: uuidSchema,
    currentRevision: revisionSchema.optional(),
  }),
});

export type Role = z.infer<typeof roleSchema>;
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;
export type ResourceVisibility = z.infer<typeof resourceVisibilitySchema>;
export type Quantity = z.infer<typeof quantitySchema>;
export type Money = z.infer<typeof moneySchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
