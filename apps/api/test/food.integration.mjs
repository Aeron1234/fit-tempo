import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createFoodRouter } from '../dist/food/index.js';

test('catalog keeps source basis and handles barcode misses and provider outages', async t => {
  const realFetch = globalThis.fetch;
  const provider = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (url.hostname === 'api.nal.usda.gov') {
      const { query, dataType } = JSON.parse(options.body);
      assert.deepEqual(dataType, ['Foundation', 'SR Legacy']);
      if (query === 'oat') return new Response(null, { status: 503 });
      return Response.json({ foods: [{
        fdcId: 42, description: 'Carrots, raw', dataType: 'Foundation',
        foodNutrients: [
          { nutrientId: 1008, unitName: 'KCAL', value: 41 },
          { nutrientId: 1003, unitName: 'MG', value: 200 },
          { nutrientId: 1004, unitName: 'G', value: 0 },
        ],
      }] });
    }
    assert.equal(url.hostname, 'world.openfoodfacts.org');
    assert.equal(options.headers['user-agent'], 'FitTempo/0.0 (fixture)');
    const barcode = url.pathname.split('/').at(-1);
    if (barcode === '12345678') return new Response(null, { status: 404 });
    if (barcode === '12345679') return new Response(null, { status: 429 });
    const basis = barcode === '12345680' ? '100ml' : barcode === '12345682' ? '100g' : 'serving';
    return Response.json({ status: 'success', product: {
      code: barcode, product_name: 'Snack fixture',
      nutrition: { input_sets: [
        { preparation: 'as_sold', per: basis, source: 'packaging',
          nutrients: {
            'energy-kcal': { value: 130, unit: 'kcal' }, sodium: { value: 0.042, unit: 'g' },
            proteins: { value: 1, unit: 'g', modifier: '<' },
          } },
      ] },
    } });
  });
  const app = express();
  let budgetDenied = false;
  app.use(createFoodRouter({
    usdaApiKey: 'fixture', openFoodFacts: true, openFoodFactsUserAgent: 'FitTempo/0.0 (fixture)',
    takeProviderBudget: async () => !budgetDenied,
  }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path) {
      const response = await realFetch(base + path, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return response.json();
    }
    const search = await request('/search?q=carrots');
    const [usda] = search.data;
    assert.deepEqual(usda.basis, { kind: 'per_100g', grams: '100' });
    assert.equal(usda.preparation, 'raw');
    assert.equal(usda.nutrients.proteinG, null);
    assert.equal(usda.nutrients.fatG, '0');
    assert.equal(usda.attribution.license, 'CC0 1.0');

    const unavailable = await request('/search?q=oat');
    assert.equal(unavailable.meta.status, 'unavailable');
    assert.equal(unavailable.meta.manualEntryAvailable, true);
    assert.equal(unavailable.data[0].source.source, 'curated');
    assert.deepEqual((await request('/' + unavailable.data[0].id)).data, unavailable.data);

    const [serving] = (await request('/barcode/12345681')).data;
    assert.deepEqual(serving.basis, { kind: 'per_serving', grams: null });
    assert.equal(serving.nutrients.energyKcal, '130');
    assert.equal(serving.nutrients.sodiumMg, '42');
    assert.equal(serving.nutrients.proteinG, null);
    assert.equal(serving.attribution.license, 'ODbL 1.0');
    assert.equal((await request('/barcode/12345678')).meta.status, 'not_found');
    assert.equal((await request('/barcode/12345679')).meta.status, 'unavailable');
    assert.equal((await request('/barcode/12345680')).meta.status, 'unavailable');
    assert.equal((await request('/barcode/2000000000008')).data[0].source.source, 'curated');
    const [byMass] = (await request('/barcode/12345682')).data;
    assert.deepEqual(byMass.basis, { kind: 'per_100g', grams: '100' });
    budgetDenied = true;
    assert.equal((await request('/barcode/12345681')).meta.status, 'unavailable');
    assert.equal((await request('/search?q=oat')).data[0].source.source, 'curated');
    assert.equal(provider.mock.callCount(), 7);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
