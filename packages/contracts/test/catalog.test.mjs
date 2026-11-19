import assert from 'node:assert/strict';
import test from 'node:test';
import { manualFoodSchema, nutritionSnapshotSchema } from '../dist/index.js';

test('manual serving keeps unknown grams and does not grant a food conversion', () => {
  const id = '6f70d7ee-6e39-4f71-997c-fa35ef710137';
  const nutrients = { energyKcal: '0', proteinG: null, carbsG: '2.5', fatG: null, fiberG: null, sodiumMg: null };
  const input = { name: 'Sample', preparation: 'raw', basis: { kind: 'per_serving', grams: null }, nutrients };
  assert.deepEqual(manualFoodSchema.parse(input), input);
  assert.equal(manualFoodSchema.safeParse({ ...input, ownerId: id }).success, false);
  const snapshot = {
    snapshotVersion: 1, capturedAt: '2026-11-18T00:00:00Z', foodId: id, foodName: input.name,
    foodRevision: 0, source: { source: 'user', sourceRecordId: id, revision: 0 },
    preparation: input.preparation, basis: input.basis, basisNutrients: nutrients,
    quantity: { value: '1', unit: 'serving' }, grams: null, gramConversion: null, consumedNutrients: nutrients,
  };
  assert.equal(nutritionSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(nutritionSnapshotSchema.safeParse({ ...snapshot, grams: '50' }).success, false);
  assert.equal(nutritionSnapshotSchema.safeParse({
    ...snapshot, consumedNutrients: { ...nutrients, proteinG: '0' },
  }).success, false);
});
