import { z } from 'zod';

// Phase 03 transport smoke contract. Domain contracts are settled in Phase 04.
export const healthResponseSchema = z.object({
  data: z.object({
    status: z.literal('ok'),
    service: z.literal('fit-tempo-api'),
    mode: z.enum(['local', 'synthetic-demo']),
    capabilities: z.object({
      ai: z.literal(false),
      email: z.literal('test-mailbox'),
      scheduler: z.literal('manual-dry-run'),
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
