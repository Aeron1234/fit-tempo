import { z } from 'zod';
import { revisionSchema, sourceIdentitySchema, uuidSchema } from './common.js';
import { nutrientBasisSchema, nutrientsSchema } from './snapshots.js';

const foodFields = {
  name: z.string().trim().min(1).max(200),
  preparation: z.enum(['raw', 'cooked', 'unknown']),
  basis: nutrientBasisSchema,
  nutrients: nutrientsSchema,
};

export const manualFoodSchema = z.strictObject(foodFields);
export const catalogFoodSchema = z.object({
  ...foodFields,
  id: uuidSchema.nullable(),
  revision: revisionSchema.optional(),
  source: sourceIdentitySchema,
  barcode: z.string().regex(/^\d{1,32}$/).nullable(),
  attribution: z.object({
    label: z.string().min(1),
    url: z.url({ protocol: /^https$/ }).nullable(),
    license: z.string().min(1),
  }),
});
export const foodLookupSchema = z.object({
  data: z.array(catalogFoodSchema),
  meta: z.object({
    status: z.enum(['ok', 'not_found', 'unavailable']),
    manualEntryAvailable: z.literal(true),
  }),
});
export const manualFoodResponseSchema = z.object({ data: z.object({ id: uuidSchema }) });
