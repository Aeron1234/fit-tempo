import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FoodRecognitionPage } from '../src/pages/FoodRecognition.tsx';
import { reviewedMealDraft } from '../src/pages/food-recognition-form.ts';

test('recognition never converts model portions to measured serving data', () => {
  const fields = new globalThis.FormData();
  fields.set('time', '2026-11-20T11:30');
  fields.set('mealType', 'lunch');
  const id = 'c1cc241c-afd4-4eba-aab6-9e9429d73e31';
  assert.equal(reviewedMealDraft([{name:'Rice',estimate:null,grams:''}], fields, 'Asia/Manila', id).success, false);
  assert.equal(reviewedMealDraft([{name:'Rice',estimate:'50',grams:''}], fields, 'Asia/Manila', id).success, false);
  const result = reviewedMealDraft([{name:'Edited rice',estimate:null,grams:'100.00'}], fields, 'Asia/Manila', id);
  assert.equal(result.success, true);
  assert.equal(result.data.occurredAt, '2026-11-20T03:30:00.000Z');
  assert.equal(result.data.items[0].quantity, '100');
  assert.equal(result.data.items[0].manual.name, 'Edited rice');
  assert.ok(Object.values(result.data.items[0].manual.nutrients).every(value => value === null));
});

test('only the active owner can see the fixture chooser and manual fallback is always available', () => {
  const client = new QueryClient();
  let snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } };
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  client.setQueryData(['private', 'owner', 'food-recognition'], { data: {
    enabled: true, fixtures: [{ id: 'synthetic-rice-bowl', label: 'Synthetic sample' }],
  } });
  client.setQueryData(['private', 'peer', 'food-recognition'], { data: { enabled: false, fixtures: [] } });
  const render = () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(MemoryRouter, null, h(FoodRecognitionPage, { session }))));
  try {
    const owner = render();
    assert.match(owner, /Synthetic sample/);
    assert.match(owner, /Analyze sample/);
    assert.match(owner, /\/fixtures\/synthetic-rice-bowl/);
    assert.match(owner, /Scan nutrition label/);
    assert.doesNotMatch(owner, /<video|Captured product label/);
    assert.doesNotMatch(owner, /type="file"|Confirm and log meal/);
    snapshot = { status: 'authenticated', user: { id: 'peer', role: 'trainee' } };
    assert.match(render(), /recognition is off/);
    assert.match(render(), /Log a meal manually/);
    assert.doesNotMatch(render(), /Synthetic sample|Analyze sample/);
    snapshot = { status: 'checking' };
    assert.equal(render(), '');
  } finally {
    client.clear();
  }
});
