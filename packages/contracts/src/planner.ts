import { z } from 'zod';
import { decimalSchema, positiveDecimalSchema, revisionSchema, uuidSchema } from './common.js';
import { priceCurrencySchema } from './ingredients.js';
export const plannerInputSchema = z.strictObject({
    budget: z.strictObject({ amount: decimalSchema, currency: priceCurrencySchema }),
    servings: positiveDecimalSchema,
    maxPrepMinutes: z.number().int().min(0).max(1440),
    pantryRevision: revisionSchema,
    excludedIngredientIds: z.array(uuidSchema).max(100),
});
export const plannerSuggestSchema = plannerInputSchema.extend({ recipes: z.array(z.strictObject({ recipeId: uuidSchema, recipeRevision: revisionSchema })).min(1).max(10).optional() });
export const planConfirmSchema = plannerInputSchema.extend({
    expectedEstimateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recipes: z.array(z.strictObject({ recipeId: uuidSchema, recipeRevision: revisionSchema })).min(1).max(10),
    clientOperationId: uuidSchema,
});
export const planDeductSchema = z.strictObject({ expectedPantryRevision: revisionSchema, clientOperationId: uuidSchema });
export type PlannerInput = z.infer<typeof plannerInputSchema>;
export type PlannerItem = {
    foodId: string;
    foodName: string;
    quantity: string;
    unit: string;
    availableQuantity: string;
    shortageQuantity: string | null;
    quantityUnknown: boolean;
    consumedCost: string | null;
    additionalCost: string | null;
    checkoutCost: string | null;
    packageQuantity: string | null;
    leftovers: string | null;
};
export type PlannerEstimate = {
    estimateDigest: string;
    priceSnapshots: unknown[];
    recipes: {
        recipeId: string;
        recipeRevision: number;
        name: string;
        servings: string;
    }[];
    recipeDetails: unknown[];
    budgetAmount: string;
    missingConsumedPrices: string[];
    pantryRevision: number;
    items: PlannerItem[];
    currency: string;
    knownConsumedCost: string;
    knownAdditionalCost: string;
    knownCheckoutCost: string;
    missingPrices: string[];
    missingQuantities: string[];
    missingPackagePrices: string[];
    withinBudget: boolean | null;
    budgetBasis: 'package_checkout';
    allocations: {
        lotId: string;
        quantity: string;
        unit: string;
        foodName: string;
        expiresOn: string | null;
    }[];
    assumptions: string[];
};
export type SavedMealPlan = {
    id: string;
    estimate: PlannerEstimate;
    deducted: boolean;
    createdAt: string;
};
const plannerItemSchema = z.object({ foodId: uuidSchema, foodName: z.string(), quantity: decimalSchema, unit: z.string(), availableQuantity: decimalSchema, shortageQuantity: decimalSchema.nullable(), quantityUnknown: z.boolean(), consumedCost: decimalSchema.nullable(), additionalCost: decimalSchema.nullable(), checkoutCost: decimalSchema.nullable(), packageQuantity: decimalSchema.nullable(), leftovers: decimalSchema.nullable() });
export const plannerEstimateSchema = z.object({ estimateDigest: z.string(), priceSnapshots: z.array(z.unknown()), recipes: z.array(z.object({ recipeId: uuidSchema, recipeRevision: revisionSchema, name: z.string(), servings: positiveDecimalSchema })), recipeDetails: z.array(z.unknown()), budgetAmount: decimalSchema, missingConsumedPrices: z.array(z.string()), pantryRevision: revisionSchema, items: z.array(plannerItemSchema), currency: priceCurrencySchema, knownConsumedCost: decimalSchema, knownAdditionalCost: decimalSchema, knownCheckoutCost: decimalSchema, missingPrices: z.array(z.string()), missingQuantities: z.array(z.string()), missingPackagePrices: z.array(z.string()), withinBudget: z.boolean().nullable(), budgetBasis: z.literal('package_checkout'), allocations: z.array(z.object({ lotId: uuidSchema, quantity: decimalSchema, unit: z.string(), foodName: z.string(), expiresOn: z.string().nullable() })), assumptions: z.array(z.string()) });
export const plannerSuggestionsResponseSchema = z.object({ data: z.array(plannerEstimateSchema) });
export const mealPlansResponseSchema = z.object({ data: z.array(z.object({ id: uuidSchema, estimate: plannerEstimateSchema, deducted: z.boolean(), createdAt: z.string() })) });
export const shoppingListResponseSchema = z.object({ data: z.array(z.object({ id: uuidSchema, mealPlanId: uuidSchema, foodName: z.string(), shortageQuantity: decimalSchema.nullable(), unit: z.string(), purchased: z.boolean() })) });
