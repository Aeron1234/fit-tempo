import { z } from 'zod';
import { decimalSchema, positiveDecimalSchema, revisionSchema, uuidSchema } from './common.js';

const name = z.string().trim().min(1).max(200);
const equipment = z.string().trim().min(1).max(120).nullable();
const measurementType = z.enum(['externalLoad', 'bodyweight', 'timed', 'distance']);
const durationMinutes = z.number().int().min(1).max(1440);
const level = z.enum(['beginner', 'intermediate', 'advanced']).nullable();
const editableRecord = { id: uuidSchema, revision: revisionSchema, editable: z.boolean() };

export const exerciseWriteSchema = z.strictObject({
  name, equipment, measurementType,
  instructions: z.string().trim().min(1).max(4000).nullable(),
});
export const exerciseEditSchema = exerciseWriteSchema.extend({ expectedRevision: revisionSchema });
export const exercisesResponseSchema = z.object({ data: z.array(exerciseWriteSchema.extend(editableRecord)) });

export const routineTargetSchema = z.strictObject({
  exerciseId: uuidSchema,
  targetSets: z.number().int().min(1).max(100),
  targetReps: z.number().int().min(1).max(10000).nullable(),
  targetLoadKg: decimalSchema.nullable(),
  targetSeconds: positiveDecimalSchema.nullable(),
  targetMeters: positiveDecimalSchema.nullable(),
  restSeconds: z.number().int().min(0).max(86400).nullable(),
});
export const routineWriteSchema = z.strictObject({
  name, durationMinutes, level,
  exercises: z.array(routineTargetSchema).min(1).max(100),
});
export const routineEditSchema = routineWriteSchema.extend({ expectedRevision: revisionSchema });
const routineExerciseRecord = routineTargetSchema.extend({ exerciseName: name, equipment, measurementType });
const variant = z.object({ id: uuidSchema, revision: revisionSchema, name, durationMinutes, exercises: z.array(routineExerciseRecord) });
export const routinesResponseSchema = z.object({
  data: z.array(variant.extend({ ...editableRecord, level, shorterVariants: z.array(variant) })),
});
export const exerciseMutationResponseSchema = z.object({ data: z.object({ id: uuidSchema, revision: revisionSchema }) });
export const routineArchiveSchema = z.strictObject({ expectedRevision: revisionSchema });
