import { z } from 'zod';
import {
  instantSchema, localDateSchema, mealTypeSchema, nutritionSnapshotSchema, recipeSnapshotSchema,
  revisionSchema, timeZoneSchema, trackingDayStateSchema, uuidSchema,
} from '@fit-tempo/contracts';

const nutrientKeys = z.enum(['energyKcal', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sodiumMg']);
const totals = z.record(nutrientKeys, z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable());
const mealRow = z.object({
  id: uuidSchema, revision: revisionSchema, mealType: mealTypeSchema, occurredAt: instantSchema, timeZone: timeZoneSchema,
  localDate: localDateSchema, imageId: uuidSchema.nullable(), totals, missingNutrients: z.array(nutrientKeys),
  items: z.array(z.object({ id: uuidSchema, snapshot: nutritionSnapshotSchema, recipeSnapshot: recipeSnapshotSchema.optional() })),
});
export const mealsResponse = z.object({ data: z.object({
  date: localDateSchema, timeZone: timeZoneSchema, preferredTimeZone: timeZoneSchema, meals: z.array(mealRow),
  nextCursor: z.string().nullable(), status: trackingDayStateSchema,
}) });
export type MealRow = z.infer<typeof mealRow>;
