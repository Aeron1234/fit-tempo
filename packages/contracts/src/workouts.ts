import { z } from 'zod';
import { uuidSchema, revisionSchema } from './common.js';
import { instantSchema } from './time.js';
import { workoutSetSnapshotSchema, workoutSnapshotSchema } from './snapshots.js';

export const workoutStartSchema = z.strictObject({
  routineId: uuidSchema, expectedRoutineRevision: revisionSchema, variantId: uuidSchema.optional(),
  scheduledWorkoutId: uuidSchema.optional(),
});

const revision = { expectedRevision: revisionSchema };
const exerciseIndex = z.number().int().min(0).max(99);
const setOrder = z.number().int().min(1).max(100);
export const workoutPatchSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...revision, action: z.literal('pause') }),
  z.strictObject({ ...revision, action: z.literal('resume') }),
  z.strictObject({ ...revision, action: z.literal('startRest'), seconds: z.number().int().min(1).max(86400) }),
  z.strictObject({ ...revision, action: z.literal('clearRest') }),
  z.strictObject({ ...revision, action: z.literal('saveSet'), exerciseIndex, set: workoutSetSnapshotSchema.unwrap().extend({ setOrder }) }),
  z.strictObject({ ...revision, action: z.literal('removeSet'), exerciseIndex, setOrder }),
]);
export const workoutCompleteSchema = z.strictObject({ ...revision, clientOperationId: uuidSchema });
export const workoutSessionSchema = z.object({
  id: uuidSchema, revision: revisionSchema,
  status: z.enum(['inProgress', 'paused', 'completed', 'abandoned']),
  startedAt: instantSchema, endedAt: instantSchema.nullable(),
  elapsedSeconds: z.number().int().nonnegative(), activeSince: instantSchema.nullable(),
  restRemainingSeconds: z.number().int().nonnegative(), restEndsAt: instantSchema.nullable(),
  snapshot: workoutSnapshotSchema,
  volume: z.array(z.object({ exerciseId: uuidSchema, name: z.string(), kgReps: z.string().regex(/^\d+(?:\.\d{1,6})?$/) })),
});
export const workoutSessionResponseSchema = z.object({ data: workoutSessionSchema });
export const workoutSessionsResponseSchema = z.object({ data: z.array(workoutSessionSchema) });
export type WorkoutSession = z.infer<typeof workoutSessionSchema>;
export type WorkoutPatch = z.infer<typeof workoutPatchSchema>;

