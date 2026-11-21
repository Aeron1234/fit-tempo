import { z } from 'zod';
import { positiveDecimalSchema, uuidSchema } from './common.js';
import { instantSchema, localDateSchema, timeZoneSchema } from './time.js';

export const waterWriteSchema = z.strictObject({ amountMl: positiveDecimalSchema, occurredAt: instantSchema });
export const waterCreateSchema = waterWriteSchema.extend({ clientOperationId: uuidSchema });
export const waterQuerySchema = z.strictObject({ date: localDateSchema.optional() });
export const waterEntrySchema = waterWriteSchema.extend({ id: uuidSchema, timeZone: timeZoneSchema, localDate: localDateSchema });
export const waterEntryResponseSchema = z.object({ data: waterEntrySchema });
export const waterResponseSchema = z.object({ data: z.object({
  date: localDateSchema, timeZone: timeZoneSchema,
  totalMl: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable(),
  entries: z.array(waterEntrySchema),
}) });
export const hydrationGoalCreateSchema = z.strictObject({ targetMl: positiveDecimalSchema });
export const hydrationGoalPatchSchema = z.strictObject({ status: z.literal('retired') });
export const hydrationGoalSchema = z.object({
  id: uuidSchema, targetMl: positiveDecimalSchema, effectiveFrom: localDateSchema, effectiveUntil: localDateSchema.nullable(),
  status: z.enum(['active', 'paused', 'retired']),
});
export const hydrationGoalResponseSchema = z.object({ data: hydrationGoalSchema });
export const hydrationGoalsResponseSchema = z.object({ data: z.object({
  goals: z.array(hydrationGoalSchema),
  milestones: z.array(z.object({ id: uuidSchema, goalId: uuidSchema, occurredAt: instantSchema })),
  workoutStreak: z.number().int().nonnegative(),
}) });
