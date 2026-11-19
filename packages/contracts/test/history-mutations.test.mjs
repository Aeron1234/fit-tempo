import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nutritionSnapshotSchema, recipeSnapshotSchema, workoutSnapshotSchema,
  exerciseSnapshotSchema, nutrientsSchema, scheduleAcceptRequestSchema,
  scheduleAcceptanceResponseSchema, pantryDeductionResponseSchema,
  trackingDaySchema, resourceVisibilitySchema, fileReferenceSchema,
} from '../dist/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const capturedAt = '2026-11-16T04:00:00Z';
const unknown = { energyKcal: null, proteinG: null, carbsG: null, fatG: null, fiberG: null, sodiumMg: null };
const food = {
  snapshotVersion: 1, capturedAt, foodId: id, foodName: 'Fixture rice', foodRevision: 2,
  source: { source: 'curated', sourceRecordId: id, revision: 2 }, preparation: 'cooked',
  basis: { kind: 'per_100g', grams: '100' }, basisNutrients: { ...unknown, energyKcal: '0' },
  quantity: { value: '100', unit: 'g' }, grams: '100', gramConversion: null,
  consumedNutrients: { ...unknown, energyKcal: '0' },
};

test('snapshot parsing preserves explicit zero and unknowns without inventing conversions', () => {
  const snapshot = nutritionSnapshotSchema.parse(food);
  assert.equal(snapshot.consumedNutrients.energyKcal, '0');
  assert.equal(snapshot.consumedNutrients.proteinG, null);
  assert.equal(snapshot.grams, '100');
  assert.equal(nutritionSnapshotSchema.safeParse({ ...food, quantity: { value: '1', unit: 'cup' }, grams: '240' }).success, false);
  const conversion = { foodId: id, foodRevision: 2, unit: 'cup', gramsPerUnit: '240' };
  assert.equal(nutritionSnapshotSchema.safeParse({ ...food, quantity: { value: '1', unit: 'cup' }, grams: '240', gramConversion: conversion }).success, true);
  assert.equal(nutritionSnapshotSchema.safeParse({ ...food, quantity: { value: '1', unit: 'cup' }, grams: '240', gramConversion: { ...conversion, foodId: other } }).success, false);
  assert.equal(nutrientsSchema.safeParse({ ...unknown, invented: '1' }).success, false);
  assert.equal(nutritionSnapshotSchema.safeParse({ ...food, consumedNutrients: { ...unknown, proteinG: '20' } }).success, false);
  assert.equal(nutritionSnapshotSchema.safeParse({ ...food, grams: null }).success, false);
  const perServing = { ...food, quantity: { value: '1', unit: 'serving' }, grams: null, basis: { kind: 'per_serving', grams: null } };
  assert.equal(nutritionSnapshotSchema.safeParse(perServing).success, true);
});

test('recipe snapshot is self-contained and detached from a later input edit', () => {
  const original = structuredClone(food);
  const snapshot = recipeSnapshotSchema.parse({ snapshotVersion: 1, capturedAt, recipeId: id, recipeRevision: 2, name: 'Fixture recipe', servings: '2', yield: { value: '400', unit: 'g' }, ingredients: [original] });
  original.foodName = 'Changed catalog';
  assert.equal(snapshot.ingredients[0].foodName, 'Fixture rice');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.ingredients), true);
  assert.equal(Object.isFrozen(snapshot.ingredients[0].consumedNutrients), true);
  assert.throws(() => { snapshot.ingredients[0].foodName = 'Overwrite'; }, TypeError);
});

test('workout measurements reject mixed units, duplicate sets and malformed empty targets', () => {
  const timedSet = { setOrder: 1, measurement: { type: 'timed', durationSeconds: '20' } };
  const exercise = { exerciseId: id, exerciseRevision: 0, name: 'Fixture hold', restSeconds: '30', targets: [timedSet], actualSets: [timedSet] };
  assert.equal(workoutSnapshotSchema.safeParse({ snapshotVersion: 1, capturedAt, routineId: id, routineRevision: 0, variantId: null, name: 'Fixture routine', exercises: [exercise] }).success, true);
  assert.equal(exerciseSnapshotSchema.safeParse({ ...exercise, targets: [] }).success, false);
  assert.equal(exerciseSnapshotSchema.safeParse({ ...exercise, actualSets: [timedSet, timedSet] }).success, false);
  assert.equal(exerciseSnapshotSchema.safeParse({ ...exercise, actualSets: [{ setOrder: 1, measurement: { type: 'external_load', reps: 2, loadKg: '10' } }] }).success, false);
});

test('requests exclude client authority and mutation responses increment once', () => {
  assert.equal(scheduleAcceptRequestSchema.safeParse({ expectedScheduleRevision: 2, clientOperationId: id, userId: other }).success, false);
  const data = { proposalId: id, clientOperationId: id, previousRevision: 2, revision: 3, appliedAt: capturedAt, changedWorkoutIds: [id] };
  assert.equal(scheduleAcceptanceResponseSchema.safeParse({ data }).success, true);
  assert.equal(scheduleAcceptanceResponseSchema.safeParse({ data: { ...data, revision: 4 } }).success, false);
  assert.equal(scheduleAcceptanceResponseSchema.safeParse({ data: { ...data, changedWorkoutIds: [id, id] } }).success, false);
  const lot = { pantryItemId: id, deducted: { value: '2', unit: 'count' }, remainingQuantity: '0' };
  const deduction = { mealPlanId: id, clientOperationId: id, previousRevision: 2, revision: 3, deductedAt: capturedAt, lots: [lot] };
  assert.equal(pantryDeductionResponseSchema.safeParse({ data: deduction }).success, true);
  assert.equal(pantryDeductionResponseSchema.safeParse({ data: { ...deduction, lots: [lot, lot] } }).success, false);
  assert.equal(pantryDeductionResponseSchema.safeParse({ data: { ...deduction, lots: [{ ...lot, remainingQuantity: '-1' }] } }).success, false);
});

test('daily state distinguishes missing, partial and explicitly confirmed zero days', () => {
  const day = { localDate: '2026-11-16', timeZone: 'Asia/Manila', category: 'nutrition', state: 'unrecorded', entryCount: 0, confirmedAt: null, revision: 0 };
  assert.equal(trackingDaySchema.safeParse(day).success, true);
  assert.equal(trackingDaySchema.safeParse({ ...day, state: 'complete', confirmedAt: capturedAt }).success, true);
  assert.equal(trackingDaySchema.safeParse({ ...day, state: 'complete' }).success, false);
  assert.equal(trackingDaySchema.safeParse({ ...day, state: 'partial' }).success, false);
  assert.equal(trackingDaySchema.safeParse({ ...day, state: 'partial', entryCount: 1 }).success, true);
  assert.equal(trackingDaySchema.safeParse({ ...day, entryCount: 1 }).success, false);
});

test('visibility records preserve ownership and readiness rather than granting access', () => {
  assert.equal(resourceVisibilitySchema.safeParse({ scope: 'private' }).success, false);
  assert.equal(resourceVisibilitySchema.safeParse({ scope: 'shared', state: 'approved' }).success, true);
  assert.equal(fileReferenceSchema.safeParse({ fileId: id, ownerUserId: other, state: 'ready' }).success, true);
  // Shape acceptance cannot authorize a different owner's file. The service checks the actor.
  assert.equal(fileReferenceSchema.safeParse({ fileId: id, state: 'ready' }).success, false);
});
