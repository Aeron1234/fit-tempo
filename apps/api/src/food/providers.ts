import { z } from 'zod';
import { attribution, decimal, readNutrients, type CatalogFood } from './model.js';

const nutrient = z.object({
  nutrientId: z.number(), unitName: z.string(), value: z.unknown(),
});
const usdaResponse = z.object({ foods: z.array(z.unknown()) });
const usdaFood = z.object({
  fdcId: z.number().int().positive().safe(),
  description: z.string().trim().min(1),
  dataType: z.enum(['Foundation', 'SR Legacy']),
  foodNutrients: z.array(z.unknown()).optional(),
});
const offResponse = z.object({
  status: z.enum(['success', 'success_with_warnings']),
  product: z.object({
    code: z.string().regex(/^\d{8,14}$/),
    product_name: z.string().trim().min(1).optional(),
    nutrition: z.object({ input_sets: z.array(z.unknown()).optional() }).optional(),
  }),
});
const offInputSet = z.object({
  preparation: z.literal('as_sold'),
  per: z.enum(['100g', 'serving']),
  source: z.string().optional(),
  last_updated_t: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1).optional(),
  nutrients: z.record(z.string(), z.unknown()),
});
const offMeasure = z.object({
  value: z.unknown(), unit: z.string(), modifier: z.string().nullable().optional(),
});

function preparation(description: string): CatalogFood['preparation'] {
  const raw = /(?:^|[,;])\s*raw(?:$|[,;])/i.test(description);
  const cooked = /(?:^|[,;])\s*cooked(?:$|[,;])/i.test(description);
  if (raw === cooked) return 'unknown';
  return raw ? 'raw' : 'cooked';
}

export async function lookupUsda(query: string, apiKey: string): Promise<CatalogFood[]> {
  const url = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
  url.searchParams.set('api_key', apiKey);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ query, pageSize: 8, dataType: ['Foundation', 'SR Legacy'] }),
  });
  if (!response.ok) throw new Error('USDA FoodData Central unavailable');
  const { foods } = usdaResponse.parse(await response.json());
  const matches = foods.slice(0, 8).flatMap<CatalogFood>(value => {
    const parsed = usdaFood.safeParse(value);
    if (!parsed.success) return [];
    const food = parsed.data;
    const extracted = (food.foodNutrients ?? []).flatMap(raw => {
      const result = nutrient.safeParse(raw);
      return result.success ? [result.data] : [];
    });
    const read = (id: number, unit: string) =>
      extracted.find(measure => measure.nutrientId === id && measure.unitName.toUpperCase() === unit)?.value;
    const sourceRecordId = String(food.fdcId);
    return [{
      id: null,
      name: food.description.slice(0, 200),
      source: { source: 'usda', sourceRecordId, revision: 0 },
      preparation: preparation(food.description),
      basis: { kind: 'per_100g', grams: '100' },
      nutrients: readNutrients({
        energyKcal: read(1008, 'KCAL'), proteinG: read(1003, 'G'), carbsG: read(1005, 'G'),
        fatG: read(1004, 'G'), fiberG: read(1079, 'G'), sodiumMg: read(1093, 'MG'),
      }),
      attribution: attribution('usda', sourceRecordId),
      barcode: null,
    }];
  });
  if (foods.length && !matches.length) throw new Error('USDA data did not match the supported catalog schema');
  return matches;
}

export async function lookupBarcode(barcode: string, userAgent: string): Promise<CatalogFood | null> {
  const url = new URL(`https://world.openfoodfacts.org/api/v3.5/product/${encodeURIComponent(barcode)}`);
  url.searchParams.set('product_type', 'food');
  url.searchParams.set('fields', 'code,product_name,nutrition');
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(3000),
    headers: { accept: 'application/json', 'user-agent': userAgent },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Open Food Facts unavailable');
  const { product } = offResponse.parse(await response.json());
  if (product.code.replace(/^0+/, '') !== barcode.replace(/^0+/, ''))
    throw new Error('Unexpected product barcode');
  // Read one source set, preserving its basis. Never use normalized 100-unit
  // fields, which can represent mass or volume or combine distinct sources.
  const sets = (product.nutrition?.input_sets ?? []).flatMap(value => {
    const parsed = offInputSet.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const selected = sets.find(set => set.source === 'packaging') ?? sets[0];
  if (!selected) throw new Error('Product basis cannot be mapped safely');
  const read = (name: string, unit: 'kcal' | 'g' | 'mg') => {
    const measure = offMeasure.safeParse(selected.nutrients[name]);
    if (!measure.success || (measure.data.modifier && measure.data.modifier !== '=')) return null;
    const actual = measure.data.unit.toLowerCase();
    if (actual === unit) return decimal(measure.data.value);
    if (actual === 'g' && unit === 'mg') return decimal(measure.data.value, 1000);
    if (actual === 'mg' && unit === 'g') return decimal(measure.data.value, 0.001);
    return null;
  };
  return {
    id: null,
    name: product.product_name?.slice(0, 200) ?? `Product ${product.code}`,
    source: { source: 'open_food_facts', sourceRecordId: product.code, revision: selected.last_updated_t ?? 0 },
    preparation: 'unknown',
    basis: selected.per === 'serving' ? { kind: 'per_serving', grams: null } : { kind: 'per_100g', grams: '100' },
    nutrients: {
      energyKcal: read('energy-kcal', 'kcal'), proteinG: read('proteins', 'g'),
      carbsG: read('carbohydrates', 'g'), fatG: read('fat', 'g'),
      fiberG: read('fiber', 'g'), sodiumMg: read('sodium', 'mg'),
    },
    attribution: attribution('open_food_facts', product.code),
    barcode: product.code,
  };
}
