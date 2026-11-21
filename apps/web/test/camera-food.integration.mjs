import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraAvailable, cameraError, stopCamera } from '../src/lib/camera.ts';
import { createRetailScan, retailBarcode } from '../src/lib/retail-barcode.ts';
import { analyzeProductPhoto, sampleProduct } from '../src/pages/product-photo.ts';
import { reviewedMealDraft } from '../src/pages/food-recognition-form.ts';

test('scans retail codes, retains leading zeros and expands UPC-E for lookup', () => {
  assert.equal(retailBarcode('ean_13', '2000000000008'), '2000000000008');
  assert.equal(retailBarcode('ean_8', '96385074'), '96385074');
  assert.equal(retailBarcode('upc_a', '036000291452'), '036000291452');
  assert.equal(retailBarcode('upc_e', '04252614'), '042100005264');
  assert.equal(retailBarcode('upc_e', '04252615'), null);
  assert.equal(retailBarcode('qr_code', '036000291452'), null);
  assert.equal(retailBarcode('ean_13', '200000000000'), null);
});

test('a scan session starts one lookup even if the decoder repeats valid callbacks', () => {
  const paths = [];
  const decode = createRetailScan();
  const codes = [
    { format: 'qr_code', rawValue: '036000291452' },
    { format: 'ean_13', rawValue: '2000000000008' },
    { format: 'upc_a', rawValue: '036000291452' },
  ];
  for (let scan = 0; scan < 2; scan++) {
    const code = decode(codes);
    if (code) paths.push('/foods/barcode/' + code);
  }
  assert.deepEqual(paths, ['/foods/barcode/2000000000008']);
});

test('reports denied or unsupported cameras and stops every track', () => {
  assert.equal(cameraAvailable(), false);
  assert.match(cameraError(new globalThis.DOMException('Denied', 'NotAllowedError')), /permission was denied/);
  assert.match(cameraError({ kind: 'no-camera' }), /No camera/);
  const stopped = [];
  stopCamera({ getTracks: () => [1, 2].map(id => ({ stop: () => stopped.push(id) })) });
  assert.deepEqual(stopped, [1, 2]);
});

test('photo analysis receives only the approved mock ID and a fresh preview can follow a failure', () => {
  const calls = [];
  const mock = id => { calls.push(id); return globalThis.structuredClone(sampleProduct); };
  assert.throws(() => analyzeProductPhoto({ kind: 'camera', preview: 'data:image/jpeg;base64,private' }, mock), /unavailable/);
  assert.deepEqual(calls, []);
  assert.throws(() => analyzeProductPhoto({ kind: 'sample' }, () => { throw new Error('fixture failed'); }), /fixture failed/);
  const draft = analyzeProductPhoto({ kind: 'sample' }, mock);
  assert.deepEqual(calls, ['sample-oat-crisps']);
  draft.label.nutrients.energyKcal = '155';
  assert.equal(analyzeProductPhoto({ kind: 'sample' }, mock).label.nutrients.energyKcal, '160');
});

test('a label draft requires consumed weight and preserves edited values, unknowns and zeroes', () => {
  const label = analyzeProductPhoto({ kind: 'sample' });
  const fields = new globalThis.FormData();
  fields.set('time', '2026-11-20T11:30');
  fields.set('mealType', 'lunch');
  const draft = { ...label, name: 'Edited crisps', grams: '', estimate: null };
  const id = 'c1cc241c-afd4-4eba-aab6-9e9429d73e31';
  assert.equal(reviewedMealDraft([draft], fields, 'Asia/Manila', id).success, false);
  draft.grams = '80';
  draft.label.nutrients.energyKcal = '155';
  const reviewed = reviewedMealDraft([draft], fields, 'Asia/Manila', id);
  assert.equal(reviewed.success, true);
  const item = reviewed.data.items[0];
  assert.equal(item.quantity, '80');
  assert.equal(item.unit, 'g');
  assert.equal(item.manual.name, 'Edited crisps');
  assert.deepEqual(item.manual.basis, { kind: 'per_serving', grams: '40' });
  assert.equal(item.manual.nutrients.energyKcal, '155');
  assert.equal(item.manual.nutrients.fiberG, null);
  assert.equal(item.manual.nutrients.sodiumMg, '0');
});
