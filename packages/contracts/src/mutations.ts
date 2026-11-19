import { z } from 'zod';
import { clientOperationIdSchema, decimalSchema, quantitySchema, revisionSchema, uuidSchema } from './common.js';
import { instantSchema, localDateSchema, timeZoneSchema } from './time.js';

export const scheduleAcceptRequestSchema = z.strictObject({
  expectedScheduleRevision: revisionSchema,
  clientOperationId: clientOperationIdSchema,
});
export const pantryDeductRequestSchema = z.strictObject({
  expectedPantryRevision: revisionSchema,
  clientOperationId: clientOperationIdSchema,
});

export const scheduledWorkoutStatusSchema = z.enum(['scheduled', 'missed', 'cancelled', 'completed']);
export const scheduleAcceptanceResponseSchema = z.strictObject({
  data: z.strictObject({
    proposalId: uuidSchema,
    clientOperationId: clientOperationIdSchema,
    previousRevision: revisionSchema,
    revision: revisionSchema,
    appliedAt: instantSchema,
    changedWorkoutIds: z.array(uuidSchema).min(1).max(100),
  }),
}).superRefine(({ data }, context) => {
  if (data.revision !== data.previousRevision + 1) {
    context.addIssue({ code: 'custom', path: ['data', 'revision'], message: 'A committed schedule mutation increments the revision once.' });
  }
  if (new Set(data.changedWorkoutIds).size !== data.changedWorkoutIds.length) {
    context.addIssue({ code: 'custom', path: ['data', 'changedWorkoutIds'], message: 'Changed workout identities must be unique.' });
  }
});

const deductedLotSchema = z.strictObject({
  pantryItemId: uuidSchema,
  deducted: quantitySchema,
  remainingQuantity: decimalSchema,
});
export const pantryDeductionResponseSchema = z.strictObject({
  data: z.strictObject({
    mealPlanId: uuidSchema,
    clientOperationId: clientOperationIdSchema,
    previousRevision: revisionSchema,
    revision: revisionSchema,
    deductedAt: instantSchema,
    lots: z.array(deductedLotSchema).min(1).max(100),
  }),
}).superRefine(({ data }, context) => {
  if (data.revision !== data.previousRevision + 1) {
    context.addIssue({ code: 'custom', path: ['data', 'revision'], message: 'A committed deduction increments the revision once.' });
  }
  const ids = data.lots.map((lot) => lot.pantryItemId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['data', 'lots'], message: 'Allocate each pantry lot only once.' });
  }
});

export const trackingCategorySchema = z.enum(['nutrition', 'hydration', 'activity']);
export const trackingDayStateSchema = z.enum(['unrecorded', 'partial', 'complete']);
export const dayStatusRequestSchema = z.strictObject({
  state: z.enum(['complete', 'reopen']),
});
export const trackingDaySchema = z.strictObject({
  localDate: localDateSchema,
  timeZone: timeZoneSchema,
  category: trackingCategorySchema,
  state: trackingDayStateSchema,
  entryCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  confirmedAt: instantSchema.nullable(),
  revision: revisionSchema,
}).superRefine((value, context) => {
  if ((value.state === 'complete') !== (value.confirmedAt !== null)) {
    context.addIssue({ code: 'custom', path: ['confirmedAt'], message: 'Only a complete day has an explicit confirmation.' });
  }
  if ((value.state === 'unrecorded' && value.entryCount !== 0) || (value.state === 'partial' && value.entryCount === 0)) {
    context.addIssue({ code: 'custom', path: ['entryCount'], message: 'Unrecorded days have no entries and partial days have entries.' });
  }
});
export const dayStatusResponseSchema = z.strictObject({ data: trackingDaySchema });

export type ScheduleAcceptRequest = z.infer<typeof scheduleAcceptRequestSchema>;
export type PantryDeductRequest = z.infer<typeof pantryDeductRequestSchema>;
export type ScheduleAcceptanceResponse = z.infer<typeof scheduleAcceptanceResponseSchema>;
export type PantryDeductionResponse = z.infer<typeof pantryDeductionResponseSchema>;
export type TrackingDay = z.infer<typeof trackingDaySchema>;
