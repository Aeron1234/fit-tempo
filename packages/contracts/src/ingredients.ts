import { z } from 'zod';
import { currencySchema, decimalSchema, positiveDecimalSchema, foodUnitSchema, revisionSchema, uuidSchema } from './common.js';
import { instantSchema, localDateSchema } from './time.js';

export const priceCurrencySchema = z.enum(['PHP', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'SGD']);
export const recipeIngredientSchema = z.strictObject({
  foodId: uuidSchema, nutrientRevision: revisionSchema, quantity: positiveDecimalSchema, unit: foodUnitSchema,
});
export const recipeWriteSchema = z.strictObject({
  name: z.string().trim().min(1).max(200), servings: positiveDecimalSchema,
  cookedYieldGrams: positiveDecimalSchema.nullable(), prepMinutes: z.number().int().min(0).max(1440).nullable(),
  items: z.array(recipeIngredientSchema).min(1).max(30),
  steps: z.array(z.string().trim().min(1).max(2000)).max(30),
});
export const recipeEditSchema = recipeWriteSchema.extend({ expectedRevision: revisionSchema });
export const recipeDeleteSchema = z.strictObject({ expectedRevision: revisionSchema });
export const pantryDeleteSchema = z.strictObject({ expectedPantryRevision: revisionSchema, clientOperationId: uuidSchema });
export const pantryWriteSchema = pantryDeleteSchema.extend({
  foodId: uuidSchema, quantity: decimalSchema, unit: foodUnitSchema, expiresOn: localDateSchema.nullable(),
});
export const ingredientPriceWriteSchema = z.strictObject({
  foodId: uuidSchema, amount: decimalSchema.nullable(), currency: priceCurrencySchema,
  unitQuantity: positiveDecimalSchema, unit: foodUnitSchema, priceBasis: z.enum(['unit', 'package']),
  storeName: z.string().trim().max(120).nullable(), recordedAt: instantSchema,
});
export const recipeRecordSchema = recipeWriteSchema.extend({
  id: uuidSchema, revision: revisionSchema, editable: z.boolean(),
  name: z.string().min(1).max(240), steps: z.array(z.string().min(1).max(2000)).max(100),
  items: z.array(recipeIngredientSchema.extend({
    foodName: z.string(), gramsPerUnit: positiveDecimalSchema.nullable(), conversionFoodRevision: revisionSchema.nullable(),
  })),
});
export const recipesResponseSchema = z.object({ data: z.array(recipeRecordSchema) });
export const pantryResponseSchema = z.object({ data: z.object({
  revision: revisionSchema,
  items: z.array(z.object({
    id: uuidSchema, foodId: uuidSchema, foodName: z.string(), quantity: decimalSchema,
    unit: foodUnitSchema, expiresOn: localDateSchema.nullable(),
  })),
}) });
export const ingredientPricesResponseSchema = z.object({ data: z.array(ingredientPriceWriteSchema.extend({
  id: uuidSchema, foodName: z.string(), currency: currencySchema,
})) });
