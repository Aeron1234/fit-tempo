import { localDateSchema, timeZoneSchema } from '@fit-tempo/contracts';
import { z } from 'zod';

export const coverage = z.object({
  knownSubtotal: z.string().nullable(), missingItemCount: z.number().int().nonnegative(),
});
export const dashboardResponse = z.object({
  data: z.object({
    date: localDateSchema, timezone: timeZoneSchema,
    status: z.enum(['unrecorded', 'partial', 'complete']),
    calories: coverage.extend({ unit: z.literal('kcal') }),
    protein: coverage.extend({ unit: z.literal('g') }), itemCount: z.number().int().nonnegative(),
    carbs: coverage.extend({ unit: z.literal('g') }).optional(),
    fat: coverage.extend({ unit: z.literal('g') }).optional(),
  }),
  meta: z.object({ mode: z.enum(['local', 'synthetic-demo']), fixtureDates: z.array(localDateSchema) }),
});
