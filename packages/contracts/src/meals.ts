import { z } from 'zod';
import { manualFoodSchema } from './catalog.js';
import { foodUnitSchema, positiveDecimalSchema, revisionSchema, uuidSchema } from './common.js';
import { instantSchema, localDateSchema, timeZoneSchema } from './time.js';

export const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const portion = { quantity: positiveDecimalSchema, unit: foodUnitSchema };
export const mealItemWriteSchema = z.union([
  z.strictObject({ foodId: uuidSchema, nutrientRevision: revisionSchema, ...portion }),
  z.strictObject({ recipeId: uuidSchema, recipeRevision: revisionSchema, quantity: positiveDecimalSchema, unit: z.literal('serving') }),
  z.strictObject({ manual: manualFoodSchema, ...portion }),
]);
const writeFields = {
  clientOperationId: uuidSchema,
  mealType: mealTypeSchema,
  occurredAt: instantSchema,
  timeZone: timeZoneSchema.optional(),
  imageId: uuidSchema.nullable().optional(),
};
export const mealWriteSchema = z.strictObject({
  ...writeFields, items: z.array(mealItemWriteSchema).min(1).max(30),
});
export const mealEditSchema = z.strictObject({
  ...writeFields, expectedRevision: revisionSchema,
  items: z.array(z.union([mealItemWriteSchema, z.strictObject({ itemId: uuidSchema })])).min(1).max(30),
});
export const mealDeleteSchema = z.strictObject({ clientOperationId: uuidSchema, expectedRevision: revisionSchema });
export const mealItemEditSchema = mealDeleteSchema.extend({ item: mealItemWriteSchema });
export const mealDayQuerySchema = z.strictObject({
  date: localDateSchema.optional(), cursor: z.string().min(1).max(160).optional(),
});

export type MealType = z.infer<typeof mealTypeSchema>;
export type MealItemWrite = z.infer<typeof mealItemWriteSchema>;
export type MealWrite = z.infer<typeof mealWriteSchema>;
export type MealEdit = z.infer<typeof mealEditSchema>;
