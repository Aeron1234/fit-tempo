import { z } from 'zod';
import { decimalSchema, positiveDecimalSchema, quantitySchema, revisionSchema, sourceIdentitySchema, uuidSchema, foodUnitSchema } from './common.js';
import { instantSchema } from './time.js';

export const nutrientsSchema = z.strictObject({
  energyKcal: decimalSchema.nullable(),
  proteinG: decimalSchema.nullable(),
  carbsG: decimalSchema.nullable(),
  fatG: decimalSchema.nullable(),
  fiberG: decimalSchema.nullable(),
  sodiumMg: decimalSchema.nullable(),
}).readonly();

export const nutrientBasisSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('per_100g'), grams: z.literal('100') }).readonly(),
  z.strictObject({ kind: z.literal('per_serving'), grams: positiveDecimalSchema.nullable() }).readonly(),
]);

export const gramConversionSchema = z.strictObject({
  foodId: uuidSchema,
  foodRevision: revisionSchema,
  unit: foodUnitSchema,
  gramsPerUnit: positiveDecimalSchema,
}).readonly();

export const nutritionSnapshotSchema = z.strictObject({
  snapshotVersion: z.literal(1),
  capturedAt: instantSchema,
  foodId: uuidSchema,
  foodName: z.string().min(1).max(200),
  foodRevision: revisionSchema,
  source: sourceIdentitySchema,
  preparation: z.enum(['raw', 'cooked', 'unknown']),
  basis: nutrientBasisSchema,
  basisNutrients: nutrientsSchema,
  quantity: quantitySchema,
  grams: positiveDecimalSchema.nullable(),
  gramConversion: gramConversionSchema.nullable(),
  consumedNutrients: nutrientsSchema,
}).superRefine((value, context) => {
  const conversion = value.gramConversion;
  if (conversion && (conversion.foodId !== value.foodId || conversion.foodRevision !== value.foodRevision || conversion.unit !== value.quantity.unit)) {
    context.addIssue({ code: 'custom', path: ['gramConversion'], message: 'Conversion must identify this food revision and quantity unit.' });
  }
  if (value.grams !== null && ['cup', 'tbsp', 'tsp', 'count', 'serving', 'ml', 'l'].includes(value.quantity.unit) && conversion === null) {
    context.addIssue({ code: 'custom', path: ['gramConversion'], message: 'Converting this unit to grams requires a validated food-specific mapping.' });
  }
  const hasConsumptionBasis = value.basis.kind === 'per_100g'
    ? value.grams !== null
    : value.quantity.unit === 'serving' || (value.grams !== null && value.basis.grams !== null);
  for (const code of ['energyKcal', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sodiumMg'] as const) {
    if (value.consumedNutrients[code] !== null && (!hasConsumptionBasis || value.basisNutrients[code] === null)) {
      context.addIssue({ code: 'custom', path: ['consumedNutrients', code], message: 'Known consumed nutrients require a known nutrient and resolvable quantity basis.' });
    }
  }
}).readonly();

export const recipeSnapshotSchema = z.strictObject({
  snapshotVersion: z.literal(1),
  capturedAt: instantSchema,
  recipeId: uuidSchema,
  recipeRevision: revisionSchema,
  name: z.string().min(1).max(200),
  servings: positiveDecimalSchema,
  yield: quantitySchema,
  ingredients: z.array(nutritionSnapshotSchema).min(1).max(100).readonly(),
}).readonly();

const repetitionsSchema = z.number().int().min(1).max(10000);
const setOrderSchema = z.number().int().min(1).max(1000);
export const workoutMeasurementSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('external_load'), reps: repetitionsSchema, loadKg: decimalSchema }).readonly(),
  z.strictObject({ type: z.literal('bodyweight'), reps: repetitionsSchema }).readonly(),
  z.strictObject({ type: z.literal('timed'), durationSeconds: positiveDecimalSchema }).readonly(),
  z.strictObject({ type: z.literal('distance'), distanceMeters: positiveDecimalSchema, durationSeconds: positiveDecimalSchema.nullable() }).readonly(),
]);

export const workoutSetSnapshotSchema = z.strictObject({
  setOrder: setOrderSchema,
  measurement: workoutMeasurementSchema,
}).readonly();

export const exerciseSnapshotSchema = z.strictObject({
  exerciseId: uuidSchema,
  exerciseRevision: revisionSchema,
  name: z.string().min(1).max(200),
  restSeconds: decimalSchema,
  targets: z.array(workoutSetSnapshotSchema).min(1).max(100).readonly(),
  actualSets: z.array(workoutSetSnapshotSchema).max(100).readonly(),
}).superRefine((value, context) => {
  for (const field of ['targets', 'actualSets'] as const) {
    const orders = value[field].map((set) => set.setOrder);
    if (new Set(orders).size !== orders.length) {
      context.addIssue({ code: 'custom', path: [field], message: 'Set order must be unique within an exercise.' });
    }
  }
  const type = value.targets[0]?.measurement.type;
  if (type && [...value.targets, ...value.actualSets].some((set) => set.measurement.type !== type)) {
    context.addIssue({ code: 'custom', path: ['actualSets'], message: 'An exercise must use one compatible measurement type.' });
  }
}).readonly();

export const workoutSnapshotSchema = z.strictObject({
  snapshotVersion: z.literal(1),
  capturedAt: instantSchema,
  routineId: uuidSchema,
  routineRevision: revisionSchema,
  variantId: uuidSchema.nullable(),
  name: z.string().min(1).max(200),
  exercises: z.array(exerciseSnapshotSchema).min(1).max(100).readonly(),
}).readonly();

export type Nutrients = z.infer<typeof nutrientsSchema>;
export type NutritionSnapshot = z.infer<typeof nutritionSnapshotSchema>;
export type RecipeSnapshot = z.infer<typeof recipeSnapshotSchema>;
export type WorkoutSnapshot = z.infer<typeof workoutSnapshotSchema>;
