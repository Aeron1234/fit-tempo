import { mealWriteSchema } from '@fit-tempo/contracts';
import { canonicalMealDecimal, resolveMealInstant } from './meal-form';
import type { ProductLabel } from './product-photo';

export type RecognitionCandidateDraft = { name: string; estimate: string | null; grams: string; label?: ProductLabel };
const unknownNutrients = {
  energyKcal: null, proteinG: null, carbsG: null, fatG: null, fiberG: null, sodiumMg: null,
};

export function reviewedMealDraft(candidates: RecognitionCandidateDraft[], fields: FormData,
  timeZone: string, clientOperationId: string) {
  return mealWriteSchema.safeParse({
    clientOperationId,
    occurredAt: resolveMealInstant(String(fields.get('time')), timeZone),
    timeZone,
    mealType: fields.get('mealType'),
    items: candidates.map(candidate => ({
      manual: {
        name: candidate.name, preparation: 'unknown',
        basis: candidate.label?.basis === 'per_serving'
          ? { kind: 'per_serving', grams: canonicalMealDecimal(candidate.label.grams) || null }
          : { kind: 'per_100g', grams: '100' },
        nutrients: candidate.label
          ? Object.fromEntries(Object.entries(candidate.label.nutrients).map(([key, amount]) => [key, canonicalMealDecimal(amount) || null]))
          : unknownNutrients,
      },
      quantity: canonicalMealDecimal(candidate.grams), unit: 'g',
    })),
  });
}
