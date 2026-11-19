import { z } from 'zod';
import { timeZoneSchema } from '@fit-tempo/contracts';

export const preferences = z.object({
  timeZone: timeZoneSchema, massUnit: z.enum(['kg', 'lb']), theme: z.enum(['system', 'light', 'dark']),
});
export const preferencesResponse = z.object({ data: preferences });
