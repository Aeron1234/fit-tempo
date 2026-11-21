import { z } from 'zod'
import { positiveDecimalSchema } from './common.js'

export const foodRecognitionFixtureSchema = z.enum(['synthetic-rice-bowl'])
export const foodRecognitionRequestSchema = z.strictObject({ fixtureId: foodRecognitionFixtureSchema })
export const foodRecognitionCandidateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  portionGrams: positiveDecimalSchema.nullable(),
})
export const foodRecognitionOutputSchema = z.strictObject({
  candidates: z.array(foodRecognitionCandidateSchema).max(8),
})
export const foodRecognitionResponseSchema = z.object({
  data: foodRecognitionOutputSchema.extend({ fixtureId: foodRecognitionFixtureSchema }),
})
export const foodRecognitionCapabilitiesResponseSchema = z.object({
  data: z.object({
    enabled: z.boolean(),
    fixtures: z.array(z.object({ id: foodRecognitionFixtureSchema, label: z.string().min(1) })),
  }),
})
