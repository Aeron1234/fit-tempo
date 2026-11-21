import { z } from 'zod';
import { positiveDecimalSchema, uuidSchema } from './common.js';
import { instantSchema, localDateSchema, timeZoneSchema } from './time.js';

const activityType = z.enum(['walking', 'running', 'cycling', 'other']);
const duration = z.number().int().positive().max(2_147_483_647);
const measurementType = z.string().trim().min(1).max(80);
const note = z.string().max(1000);
export const activityWriteSchema = z.strictObject({
  type: activityType,
  occurredAt: instantSchema,
  durationSeconds: duration.nullable(),
  distanceMeters: positiveDecimalSchema.nullable(),
  linkedWorkoutId: uuidSchema.nullable().optional(),
}).refine(value => value.linkedWorkoutId
  ? value.durationSeconds === null && value.distanceMeters === null
  : value.durationSeconds !== null || value.distanceMeters !== null, {
  message: 'Enter a duration or distance for manual activity. Linked workouts use their saved data.',
});
export const weightWriteSchema = z.strictObject({
  measuredAt: instantSchema, weightKg: positiveDecimalSchema, note: note.nullable().optional(),
});
export const measurementWriteSchema = z.strictObject({
  measuredAt: instantSchema, measurementType, valueCm: positiveDecimalSchema,
});
const dateRange = { from: localDateSchema, to: localDateSchema };
export const trackingRangeSchema = z.strictObject(dateRange).partial();
const context = { id: uuidSchema, timeZone: timeZoneSchema, localDate: localDateSchema };
export const activityEntrySchema = z.object({
  ...context, type: activityType, occurredAt: instantSchema,
  durationSeconds: duration.or(z.literal(0)).nullable(), distanceMeters: positiveDecimalSchema.nullable(),
  linkedWorkoutId: uuidSchema.nullable(), source: z.enum(['manual', 'workout']),
});
export const weightEntrySchema = weightWriteSchema.extend({ ...context, note: note.nullable() });
export const measurementEntrySchema = measurementWriteSchema.extend(context);
const listing = { ...dateRange, timeZone: timeZoneSchema, truncated: z.boolean().optional() };
export const activityResponseSchema = z.object({ data: z.object({
  ...listing,
  entries: z.array(activityEntrySchema),
  totals: z.object({
    durationSeconds: z.number().int().nonnegative().nullable(),
    distanceMeters: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable(),
    manualCount: z.number().int().nonnegative(),
    linkedCount: z.number().int().nonnegative(),
  }),
}) });
export const weightResponseSchema = z.object({ data: z.object({ ...listing, entries: z.array(weightEntrySchema) }) });
export const measurementsResponseSchema = z.object({ data: z.object({ ...listing, entries: z.array(measurementEntrySchema) }) });
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export type WeightEntry = z.infer<typeof weightEntrySchema>;
export type MeasurementEntry = z.infer<typeof measurementEntrySchema>;
