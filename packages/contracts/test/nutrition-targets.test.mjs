import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateDay, estimateNutritionTargets, nutritionTargetWriteSchema } from '../dist/index.js';

const adult = { age: 30, heightCm: 180, weightKg: 85, equation: 'male', activity: 'moderate', goal: 'maintain' };

test('estimates maintenance and rounds goal calories and individual macros', () => {
  assert.deepEqual(estimateNutritionTargets(adult), {
    maintenanceKcal: 3386, energyKcal: 3386, proteinG: 212, carbsG: 381, fatG: 113,
  });
  assert.equal(estimateNutritionTargets({ ...adult, goal: 'build' }).energyKcal, 3555);
  assert.equal(estimateNutritionTargets({ ...adult, goal: 'lose' }).energyKcal, 3047);
});

test('macro coverage distinguishes incomplete, unknown, unrecorded, and confirmed zero', () => {
  const day = { date: '2026-11-24', timezone: 'Asia/Manila' };
  const partial = aggregateDay({ ...day, status: 'partial', items: [
    { calories: '80', protein: null, carbs: '4', fat: null },
    { calories: null, protein: '0', carbs: null, fat: null },
  ] });
  assert.deepEqual(partial.carbs, { unit: 'g', knownSubtotal: '4', missingItemCount: 1 });
  assert.deepEqual(partial.fat, { unit: 'g', knownSubtotal: null, missingItemCount: 2 });
  assert.equal(partial.protein.knownSubtotal, '0');
  assert.equal(aggregateDay({ ...day, status: 'unrecorded', items: [] }).fat.knownSubtotal, null);
  assert.equal(aggregateDay({ ...day, status: 'complete', items: [] }).fat.knownSubtotal, '0');
});

test('excludes unsupported estimates and allows manual values without profile data', () => {
  assert.equal(estimateNutritionTargets({ ...adult, age: 17 }), null);
  assert.equal(estimateNutritionTargets({ ...adult, weightKg: 65, goal: 'lose' }), null);
  const manual = { revision: 0, clientOperationId: 'c1cc241c-afd4-4eba-aab6-9e9429d73e31',
    energyKcal: 2200, proteinG: 100, carbsG: 0, fatG: 90 };
  assert.equal(nutritionTargetWriteSchema.safeParse(manual).success, true);
  assert.equal(nutritionTargetWriteSchema.safeParse({ ...manual, proteinG: -1 }).success, false);
});
