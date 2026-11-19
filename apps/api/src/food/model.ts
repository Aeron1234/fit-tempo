import { decimalSchema, type Nutrients } from '@fit-tempo/contracts';

type Source = 'curated' | 'user' | 'usda' | 'open_food_facts';

export type CatalogFood = {
  id: string | null;
  revision?: number;
  name: string;
  source: { source: Source; sourceRecordId: string; revision: number };
  preparation: 'raw' | 'cooked' | 'unknown';
  basis: { kind: 'per_100g'; grams: '100' } | { kind: 'per_serving'; grams: string | null };
  nutrients: Nutrients;
  attribution: { label: string; url: string | null; license: string };
  barcode: string | null;
};

export function decimal(value: unknown, factor = 1): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value) * factor;
  if (!Number.isFinite(number) || number < 0 || (number > 0 && number < 0.000001)) return null;
  const wire = number.toFixed(6).replace(/\.?0+$/, '');
  return decimalSchema.safeParse(wire).success ? wire : null;
}

export function attribution(source: Source, id: string): CatalogFood['attribution'] {
  if (source === 'usda') return {
    label: 'USDA FoodData Central', url: `https://fdc.nal.usda.gov/food-details/${id}/nutrients`, license: 'CC0 1.0',
  };
  if (source === 'open_food_facts') return {
    label: 'Open Food Facts contributors', url: `https://world.openfoodfacts.org/product/${id}`, license: 'ODbL 1.0',
  };
  return { label: source === 'user' ? 'Manual entry' : 'Fit Tempo catalog', url: null, license: 'Local data' };
}

export function readNutrients(values: Record<string, unknown>): Nutrients {
  return {
    energyKcal: decimal(values.energyKcal),
    proteinG: decimal(values.proteinG),
    carbsG: decimal(values.carbsG),
    fatG: decimal(values.fatG),
    fiberG: decimal(values.fiberG),
    sodiumMg: decimal(values.sodiumMg),
  };
}

export const fixtures: readonly CatalogFood[] = [
  {
    id: 'bf8d62ee-c463-4034-aa71-a163242fb0a1',
    name: 'Rice, cooked (sample)',
    source: { source: 'curated', sourceRecordId: 'bf8d62ee-c463-4034-aa71-a163242fb0a1', revision: 0 },
    preparation: 'cooked',
    basis: { kind: 'per_100g', grams: '100' },
    nutrients: readNutrients({ energyKcal: '130', proteinG: '2.7', carbsG: '28', fatG: '0.3' }),
    attribution: { label: 'Fit Tempo synthetic fixture', url: null, license: 'Synthetic fixture' },
    barcode: null,
  },
  {
    id: 'bf8d62ee-c463-4034-aa71-a163242fb0a2',
    name: 'Oat bites (sample)',
    source: { source: 'curated', sourceRecordId: 'bf8d62ee-c463-4034-aa71-a163242fb0a2', revision: 0 },
    preparation: 'unknown',
    basis: { kind: 'per_serving', grams: null },
    nutrients: readNutrients({ energyKcal: '165', carbsG: '22', fatG: '0' }),
    attribution: { label: 'Fit Tempo synthetic fixture', url: null, license: 'Synthetic fixture' },
    barcode: '2000000000008',
  },
];
