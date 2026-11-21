import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityProgressPage } from '../src/pages/ActivityProgress.tsx';
import { parseTrackingForm } from '../src/pages/activity-progress-form.ts';

const zone = 'Asia/Manila';
const instant = '2026-11-20T00:15:00.000Z';
const sampleDate = '2026-11-20';

test('manual form payloads validate in a runtime without geolocation or motion sensors', () => {
  assert.equal(globalThis.navigator?.geolocation, undefined);
  assert.equal(globalThis.DeviceMotionEvent, undefined);
  const form = fields => {
    const data = new globalThis.FormData();
    data.set('date', sampleDate + 'T08:15');
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  const activity = parseTrackingForm('activity', form({ type: 'walking', seconds: '120', meters: '12.00' }), zone);
  assert.equal(activity.success, true);
  assert.deepEqual(activity.data, { type: 'walking', occurredAt: instant, durationSeconds: 120, distanceMeters: '12' });
  const weight = parseTrackingForm('weight', form({ kg: '72.50' }), zone);
  assert.deepEqual(weight.data, { measuredAt: instant, weightKg: '72.5', note: null });
  const measurement = parseTrackingForm('measurements', form({ type: 'waist', cm: '80' }), zone);
  assert.deepEqual(measurement.data, { measuredAt: instant, measurementType: 'waist', valueCm: '80' });
  assert.equal(parseTrackingForm('activity', form({ type: 'walking', seconds: '-5' }), zone).success, false);
  assert.equal(parseTrackingForm('weight', form({ kg: '0' }), zone).success, false);
  const id = '6f9572e9-053d-4dab-9592-ef4252599a6d';
  const linked = parseTrackingForm('activity', form({ type: 'running', workout: id, seconds: '120' }), zone, instant);
  assert.deepEqual(linked.data, { type: 'running', occurredAt: instant, durationSeconds: null, distanceMeters: null, linkedWorkoutId: id });
});

test('tracking renders manual controls, private dated observations, actual gaps and linked exclusion', () => {
  const client = new QueryClient();
  let owner = 'owner';
  const session = { getSnapshot: () => ({ status: 'authenticated', user: { id: owner, role: 'trainee' } }), subscribe: () => () => {} };
  const scope = ['private', owner, 'activity-progress'];
  const range = { from: '2026-11-18', to: sampleDate, timeZone: zone };
  client.setQueryData([...scope, 'preferences'], { data: { timeZone: zone } });
  client.setQueryData([...scope, 'workouts'], { data: [] });
  client.setQueryData([...scope, 'weight'], { data: { ...range, entries: [{ localDate: range.from, weightKg: '72' }, { localDate: range.to, weightKg: '73' }] } });
  client.setQueryData([...scope, 'measurements'], { data: { ...range, entries: [{ localDate: range.to, measurementType: 'Waist', valueCm: '81' }] } });
  client.setQueryData([...scope, 'activity'], { data: { ...range, totals: { manualCount: 0, linkedCount: 1, durationSeconds: null, distanceMeters: null },
    entries: [{ id: 'fictional', occurredAt: instant, localDate: sampleDate, timeZone: zone, type: 'running', durationSeconds: 120, distanceMeters: null, source: 'workout', linkedWorkoutId: 'related' }],
  } });
  const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ActivityProgressPage, { session })));
  try {
    const html = render();
    assert.match(html, /Manual entry works without device permissions/);
    assert.match(html, /Duration \(seconds\)/);
    assert.match(html, /Weight \(kg\)/);
    assert.match(html, /Value \(cm\)/);
    assert.match(html, /2026-11-19<\/dt><dd>Not recorded/);
    assert.match(html, /2026-11-20 08:15 \(Asia\/Manila\)/);
    assert.match(html, /Linked workout; excluded from standalone totals/);
    assert.doesNotMatch(html, /<line /);
    owner = 'peer';
    assert.doesNotMatch(render(), /Waist \(cm\)|Linked workout; excluded from standalone totals/);
  } finally {
    client.clear();
  }
});
