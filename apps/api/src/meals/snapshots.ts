import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  decimalSchema, nutritionSnapshotSchema, recipeSnapshotSchema, type MealItemWrite, type RecipeSnapshot,
  type Nutrients, type NutritionSnapshot,
} from '@fit-tempo/contracts';

export class MealError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'REVISION_CONFLICT',
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
  }
}

export const missing = (resource: string) => new MealError(404, 'NOT_FOUND', `${resource} is unavailable.`);
export const invalid = (message: string) => new MealError(400, 'VALIDATION_ERROR', message);
const multiplier = 1_000_000n;
const nutrientCodes = ['energyKcal', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sodiumMg'] as const;

function micros(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * multiplier + BigInt(fraction.padEnd(6, '0'));
}

function wire(value: bigint) {
  const fraction = (value % multiplier).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${value / multiplier}.${fraction}` : String(value / multiplier);
}

function roundedDivide(numerator: bigint, denominator: bigint) {
  return (numerator + denominator / 2n) / denominator;
}

function bounded(value: bigint) {
  const result = wire(value);
  if (!decimalSchema.safeParse(result).success) throw invalid('This quantity produces a nutrient or mass outside the supported range.');
  return result;
}

function rangeNutrients(values: Record<string, string | null | undefined>): Nutrients {
  return {
    energyKcal: values.energyKcal ?? null,
    proteinG: values.proteinG ?? null,
    carbsG: values.carbsG ?? null,
    fatG: values.fatG ?? null,
    fiberG: values.fiberG ?? null,
    sodiumMg: values.sodiumMg ?? null,
  };
}

function quantities(input: MealItemWrite, basis: NutritionSnapshot['basis'], nutrients: Nutrients) {
  const amount = micros(input.quantity);
  // Keep the exact rational mass until after calculating consumption.
  let mass: { numerator: bigint; denominator: bigint } | null = null;
  let gramsPerUnit: string | null = null;
  switch (input.unit) {
    case 'g': mass = { numerator: amount, denominator: 1n }; break;
    case 'kg': mass = { numerator: amount * 1000n, denominator: 1n }; break;
    case 'mg': mass = { numerator: amount, denominator: 1000n }; break;
    case 'serving':
      if (basis.kind === 'per_serving' && basis.grams !== null) {
        gramsPerUnit = basis.grams;
        mass = { numerator: amount * micros(basis.grams), denominator: multiplier };
      }
      break;
  }
  const roundedGrams = mass && roundedDivide(mass.numerator, mass.denominator);
  if (roundedGrams === 0n) throw invalid('This portion is below the supported gram precision.');
  const grams = roundedGrams === null ? null : bounded(roundedGrams);

  const ratio = basis.kind === 'per_serving' && input.unit === 'serving'
    ? { numerator: amount, denominator: multiplier }
    : basis.grams && mass
      ? { numerator: mass.numerator, denominator: mass.denominator * micros(basis.grams) }
      : null;

  const consumedNutrients = rangeNutrients(Object.fromEntries(nutrientCodes.map(code => {
    const value = nutrients[code];
    return [code, value !== null && ratio
      ? bounded(roundedDivide(micros(value) * ratio.numerator, ratio.denominator))
      : null];
  })));

  return { grams, gramsPerUnit, consumedNutrients };
}

type FoodRow = {
  id: string;
  name: string;
  revision: string;
  source_kind: NutritionSnapshot['source']['source'];
  source_record_id: string;
  source_revision: string;
  preparation: 'raw' | 'cooked' | 'unspecified';
  basis: 'per100g' | 'perServing';
  basis_grams: string | null;
};

async function readFood(db: PoolClient, userId: string, input: Extract<MealItemWrite, {foodId: string}>) {
  const result = await db.query<FoodRow>(`
    SELECT id, name, revision, source_kind, source_record_id, source_revision, preparation, basis,
      trim_scale(basis_grams)::text AS basis_grams
    FROM foods WHERE id = $1 AND ((owner_id = $2 AND visibility = 'private')
      OR (owner_id IS NULL AND visibility = 'approved'))
    FOR SHARE
  `, [input.foodId, userId]);
  const row = result.rows[0];
  if (!row) throw missing('Food');
  const revision = Number(row.revision);
  if (revision !== input.nutrientRevision) {
    throw new MealError(409, 'REVISION_CONFLICT', 'The selected food changed. Choose it again.', revision);
  }
  const nutrients = await db.query<{ nutrient_code: keyof Nutrients; amount: string | null }>(`
    SELECT nutrient_code, trim_scale(amount)::text AS amount FROM food_nutrients
    WHERE food_id = $1 FOR SHARE
  `, [row.id]);
  return {
    foodId: row.id, foodRevision: revision, name: row.name.slice(0, 200),
    source: { source: row.source_kind, sourceRecordId: row.source_record_id, revision: Number(row.source_revision) },
    preparation: row.preparation === 'unspecified' ? 'unknown' as const : row.preparation,
    basis: row.basis === 'per100g'
      ? { kind: 'per_100g' as const, grams: '100' as const }
      : { kind: 'per_serving' as const, grams: row.basis_grams },
    nutrients: rangeNutrients(Object.fromEntries(nutrients.rows.map(value => [value.nutrient_code, value.amount]))),
  };
}

export type MealItem = { id: string; snapshot: NutritionSnapshot; recipeSnapshot?: RecipeSnapshot };

async function snapshotRecipe(db: PoolClient, userId: string, input: Extract<MealItemWrite, { recipeId: string }>): Promise<MealItem> {
  const { rows: [recipe] } = await db.query<{
    name: string; owner_id: string | null; revision: string; servings: string; yield_grams: string | null;
  }>(`
    SELECT name, owner_id, revision, trim_scale(servings)::text AS servings,
      trim_scale(cooked_yield_grams)::text AS yield_grams
    FROM recipes WHERE id=$1 AND archived_at IS NULL AND
      ((owner_id=$2 AND visibility='private') OR (owner_id IS NULL AND visibility='approved'))
    FOR SHARE
  `, [input.recipeId, userId]);
  if (!recipe) throw missing('Recipe');
  if (Number(recipe.revision) !== input.recipeRevision) {
    throw new MealError(409, 'REVISION_CONFLICT', 'The selected recipe changed. Choose it again.', Number(recipe.revision));
  }
  const { rows } = await db.query<{ food_id: string; revision: string; amount: string; unit: MealItemWrite['unit'] }>(`
    SELECT i.food_id, f.revision, trim_scale(i.quantity)::text AS amount, i.unit
    FROM recipe_items i JOIN foods f ON f.id=i.food_id WHERE i.recipe_id=$1 ORDER BY i.position, i.id
    FOR SHARE OF f
  `, [input.recipeId]);
  if (!rows.length) throw invalid('The recipe needs at least one ingredient.');
  const ingredients = [];
  for (const row of rows) {
    ingredients.push((await snapshotItem(db, userId, {
      foodId: row.food_id, nutrientRevision: Number(row.revision), quantity: row.amount, unit: row.unit,
    })).snapshot);
  }
  const capturedAt = new Date().toISOString();
  const recipeSnapshot = recipeSnapshotSchema.parse({
    snapshotVersion: 1, capturedAt, recipeId: input.recipeId, recipeRevision: input.recipeRevision,
    name: recipe.name.slice(0, 200), servings: recipe.servings, ingredients,
    yield: recipe.yield_grams === null ? { value: recipe.servings, unit: 'serving' } : { value: recipe.yield_grams, unit: 'g' },
  });
  const totals = mealTotals(ingredients.map(snapshot => ({ id: snapshot.foodId, snapshot })));
  const scale = (portion: string) => rangeNutrients(Object.fromEntries(nutrientCodes.map(code => {
    const total = totals.totals[code];
    return [code, total === null || totals.missingNutrients.includes(code) ? null
      : bounded(roundedDivide(micros(total) * micros(portion), micros(recipe.servings)))];
  })));
  const weight = recipe.yield_grams === null ? null : roundedDivide(micros(recipe.yield_grams) * multiplier, micros(recipe.servings));
  const servingGrams = weight && bounded(weight);
  const consumedWeight = servingGrams ? roundedDivide(micros(recipe.yield_grams!) * micros(input.quantity), micros(recipe.servings)) : null;
  const grams = consumedWeight ? bounded(consumedWeight) : null;
  const snapshot = nutritionSnapshotSchema.parse({
    snapshotVersion: 1, capturedAt, foodId: input.recipeId, foodName: recipeSnapshot.name, foodRevision: input.recipeRevision,
    source: { source: recipe.owner_id === null ? 'curated' : 'user', sourceRecordId: input.recipeId, revision: input.recipeRevision },
    preparation: 'unknown', basis: { kind: 'per_serving', grams: servingGrams || null }, basisNutrients: scale('1'),
    quantity: { value: input.quantity, unit: input.unit }, grams,
    gramConversion: grams && servingGrams ? { foodId: input.recipeId, foodRevision: input.recipeRevision,
      unit: 'serving', gramsPerUnit: servingGrams } : null,
    consumedNutrients: scale(input.quantity),
  });
  return { id: randomUUID(), snapshot, recipeSnapshot };
}

export async function snapshotItem(db: PoolClient, userId: string, input: MealItemWrite): Promise<MealItem> {
  if ('recipeId' in input) return snapshotRecipe(db, userId, input);
  const itemId = randomUUID();
  const food = 'manual' in input
    ? { ...input.manual, foodId: itemId, foodRevision: 0,
      source: { source: 'user' as const, sourceRecordId: itemId, revision: 0 } }
    : await readFood(db, userId, input);
  const { grams, gramsPerUnit, consumedNutrients } = quantities(input, food.basis, food.nutrients);
  const snapshot = nutritionSnapshotSchema.parse({
    snapshotVersion: 1,
    capturedAt: new Date().toISOString(),
    foodId: food.foodId,
    foodName: food.name,
    foodRevision: food.foodRevision,
    source: food.source,
    preparation: food.preparation,
    basis: food.basis,
    basisNutrients: food.nutrients,
    quantity: { value: input.quantity, unit: input.unit },
    grams,
    gramConversion: gramsPerUnit === null ? null : {
      foodId: food.foodId, foodRevision: food.foodRevision, unit: input.unit, gramsPerUnit,
    },
    consumedNutrients,
  });
  return { id: itemId, snapshot };
}

export function mealTotals(items: MealItem[]) {
  const missingNutrients: (keyof Nutrients)[] = [];
  const totals: Record<string, string | null> = {};
  for (const code of nutrientCodes) {
    let sum = 0n;
    let known = false;
    let missing = false;
    for (const item of items) {
      const value = item.snapshot.consumedNutrients?.[code] ?? null;
      if (value === null) {
        missing = true;
      } else {
        known = true;
        sum += micros(value);
      }
    }
    if (missing) missingNutrients.push(code);
    totals[code] = known ? wire(sum) : null;
  }
  return { totals: rangeNutrients(totals), missingNutrients };
}
