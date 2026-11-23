import { z } from 'zod';

// Phase 03 transport smoke contract. Domain contracts are settled in Phase 04.
export const healthResponseSchema = z.object({
  data: z.object({
    status: z.literal('ok'),
    service: z.literal('fit-tempo-api'),
    mode: z.enum(['local', 'synthetic-demo']),
    capabilities: z.object({
      ai: z.boolean(),
      email: z.enum(['test-mailbox', 'emailjs']),
      scheduler: z.enum(['manual-dry-run', 'hobby-daily']),
    }),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './common.js';
export * from './time.js';
export * from './snapshots.js';
export * from './mutations.js';
export * from './transaction.js';
export * from './dashboard.js';
export * from './catalog.js';

export * from './meals.js';
export * from './ingredients.js';
export * from './planner.js';
export * from './exercises.js';
export * from './workouts.js';
export * from './schedule.js';
export * from './activity.js';
export * from './hydration.js';
export * from './food-recognition.js';
export * from './analytics.js';
export * from './nutrition-targets.js';
