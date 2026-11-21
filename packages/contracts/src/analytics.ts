import { z } from 'zod';
import { localDateSchema, timeZoneSchema } from './time.js';

const amount = z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable();
const signedAmount = z.string().regex(/^-?\d+(?:\.\d{1,6})?$/).nullable();
const count = z.number().int().nonnegative();
const nutrient = z.object({ knownSubtotal: amount, missingItemCount: count });
const weeklyNutrient = nutrient.extend({ average: amount, knownDays: count });
const datedWeight = z.object({ date: localDateSchema, kg: amount.unwrap() });
const nutritionDay = z.object({
  date: localDateSchema, timezone: timeZoneSchema,
  status: z.enum(['unrecorded', 'partial', 'complete']), itemCount: count,
  calories: nutrient.extend({ unit: z.literal('kcal') }),
  protein: nutrient.extend({ unit: z.literal('g') }),
});
const week = z.object({
  from: localDateSchema, to: localDateSchema,
  days: z.array(z.object({ date: localDateSchema, nutrition: nutritionDay, waterMl: amount })).length(7),
  nutrition: z.object({ loggedDays: count, calories: weeklyNutrient, protein: weeklyNutrient }),
  hydration: z.object({ loggedDays: count, totalMl: amount, averageMl: amount }),
  workouts: z.object({ completedCount: count, durationSeconds: count.nullable(), missingDurationCount: count, overlapCount: count }),
  activity: z.object({ standaloneCount: count, linkedExcludedCount: count, durationSeconds: count.nullable(),
    distanceMeters: amount, missingDurationCount: count, missingDistanceCount: count }),
  weight: z.object({ start: datedWeight.nullable(), end: datedWeight.nullable(), changeKg: signedAmount }),
});

export const analyticsQuerySchema = z.strictObject({ from: localDateSchema.optional(), to: localDateSchema.optional() });
export const analyticsResponseSchema = z.object({ data: z.object({ timeZone: timeZoneSchema, current: week, previous: week }) });
export type AnalyticsWeek = z.infer<typeof week>;
