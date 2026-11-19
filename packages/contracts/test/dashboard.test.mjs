import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateDay, dashboardFixtures, localDateAt } from '../dist/index.js';

test('nutrition fixtures distinguish missing days, partial days and confirmed zero', () => {
  const results = Object.values(dashboardFixtures).map(aggregateDay);
  assert.deepEqual(results.map(day => day.status), ['unrecorded', 'partial', 'complete', 'complete']);
  assert.deepEqual(results.map(day => day.protein), [
    { unit: 'g', knownSubtotal: null, missingItemCount: 0 },
    { unit: 'g', knownSubtotal: '8.1', missingItemCount: 0 },
    { unit: 'g', knownSubtotal: '0', missingItemCount: 0 },
    { unit: 'g', knownSubtotal: '14.2', missingItemCount: 1 },
  ]);
  assert.deepEqual(results[3].calories, { unit: 'kcal', knownSubtotal: '400', missingItemCount: 0 });
});

test('recorded-day grouping and exact nutrient subtotals preserve unknown values', () => {
  const instant = '2026-11-16T16:30:00Z';
  assert.equal(localDateAt(instant, 'UTC'), '2026-11-16');
  assert.equal(localDateAt(instant, 'Asia/Manila'), '2026-11-17');
  const input = { date: '2026-11-17', timezone: 'Asia/Manila', status: 'complete', items: [
    { calories: '0', protein: '0.1' },
    { calories: null, protein: '0.2' },
    { calories: null, protein: null },
  ] };
  const result = aggregateDay(input);
  assert.equal(result.date, '2026-11-17');
  assert.equal(result.timezone, 'Asia/Manila');
  assert.deepEqual(result.calories, { unit: 'kcal', knownSubtotal: '0', missingItemCount: 2 });
  assert.deepEqual(result.protein, { unit: 'g', knownSubtotal: '0.3', missingItemCount: 1 });
  assert.equal(aggregateDay({ ...input, items: [{ calories: null, protein: null }] }).protein.knownSubtotal, null);
  assert.equal(aggregateDay({ ...input, items: [], hasEntries: true }).protein.knownSubtotal, null);
  assert.throws(() => aggregateDay({ ...input, date: '2026-02-29' }));
});
