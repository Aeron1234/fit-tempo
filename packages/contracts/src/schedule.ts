import { z } from 'zod';
import { revisionSchema, uuidSchema } from './common.js';
import { instantSchema, localDateSchema } from './time.js';

const weekday = z.number().int().min(0).max(6);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const slot = z.strictObject({
  weekday, start: clock, end: clock,
  equipment: z.array(z.string().trim().min(1).max(120)).max(20),
}).refine(value => value.start < value.end);
const preferences = {
  slots: z.array(slot).max(35), restDays: z.array(weekday).max(7),
};
const expected = { expectedRevision: revisionSchema };
const calendar = { revision: revisionSchema, timeZone: z.string() };
export const availabilityWriteSchema = z.strictObject({ ...preferences, ...expected });
export const availabilityResponseSchema = z.object({ data: z.object({ ...calendar, ...preferences }) });
export const scheduleStartSchema = z.strictObject({ ...expected, routineId: uuidSchema, startsAt: instantSchema });
export const schedulePatchSchema = z.strictObject({ ...expected, status: z.enum(['cancelled', 'skipped']) });
export const scheduleProposalWriteSchema = z.strictObject({ ...expected, workoutId: uuidSchema });
export const scheduleAcceptSchema = z.strictObject({ ...expected, clientOperationId: uuidSchema });

const occurrence = z.object({
  id: uuidSchema, routineId: uuidSchema, variantId: uuidSchema.nullable(), name: z.string(),
  startsAt: instantSchema, endsAt: instantSchema, timeZone: z.string(), localDate: localDateSchema,
  status: z.enum(['planned', 'missed', 'skipped', 'completed', 'cancelled']),
});
export const scheduleResponseSchema = z.object({ data: z.object({ ...calendar, workouts: z.array(occurrence) }) });
export const scheduleProposalSchema = z.object({
  id: uuidSchema, revision: revisionSchema, expiresAt: instantSchema,
  before: occurrence, after: occurrence, beforeExercises: z.array(z.string()), afterExercises: z.array(z.string()),
});
export const scheduleProposalResponseSchema = z.object({
  data: z.object({ proposal: scheduleProposalSchema.nullable(), reason: z.string().nullable() }),
});
export const scheduleAcceptResponseSchema = z.object({
  data: z.object({ id: uuidSchema, revision: revisionSchema, workoutId: uuidSchema }),
});
export type ScheduleOccurrence = z.infer<typeof occurrence>;
export type ScheduleProposal = z.infer<typeof scheduleProposalSchema>;
