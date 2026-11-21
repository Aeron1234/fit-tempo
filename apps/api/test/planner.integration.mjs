import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test'))
    throw Error('Disposable local TEST_DATABASE_URL ending in _test required.');
test('deterministic planner arithmetic, account isolation, concurrent deductions and durable replay', async () => {
    const db = new Pool({ connectionString: databaseUrl });
    const owner = randomUUID(), peer = randomUUID();
    const password = 'SyntheticPhase13Password!', origin = 'http://localhost:5173';
    Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin, JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url') });
    delete process.env.REDIS_URL;
    const { app } = await import('../dist/app.js');
    const server = app.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const email = id => `phase13-${id}@example.invalid`;
        const hash = await argon2.hash(password);
        await db.query('INSERT INTO users(id,email,password_hash,verified_at) VALUES($1,$2,$3,now()),($4,$5,$3,now())', [owner, email(owner), hash, peer, email(peer)]);
        function client() { const cookies = new Map(); let csrf; return { async request(path, method = 'GET', body, useCsrf = true) { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, { method, headers: { origin, cookie: [...cookies.values()].join('; '), ...(csrf && useCsrf ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); for (const v of response.headers.getSetCookie()) {
                const p = v.split(';')[0];
                cookies.set(p.split('=')[0], p);
            } const result = { status: response.status, ...await response.json() }; if (path === '/auth/csrf')
                csrf = result.data.csrfToken; return result; }, async login(id) { await this.request('/auth/csrf'); assert.equal((await this.request('/auth/login', 'POST', { email: email(id), password })).status, 200); await this.request('/auth/csrf'); } }; }
        const a = client(), b = client();
        assert.equal((await a.request('/me/meal-plans')).status, 401);
        await a.login(owner);
        await b.login(peer);
        const food = (await a.request('/me/foods', 'POST', { name: 'Synthetic rice', preparation: 'raw', basis: { kind: 'per_100g', grams: '100' }, nutrients: { energyKcal: '100', proteinG: null, carbsG: null, fatG: null, fiberG: null, sodiumMg: null } })).data.id;
        const recipe = { name: 'Rice bowl', servings: '1', cookedYieldGrams: null, prepMinutes: 10, items: [{ foodId: food, nutrientRevision: 0, quantity: '150', unit: 'g' }], steps: ['Cook'] };
        const recipeId = (await a.request('/me/recipes', 'POST', recipe)).data.id;
        const lot = (quantity, expiresOn, revision) => ({ foodId: food, quantity, unit: 'g', expiresOn, expectedPantryRevision: revision, clientOperationId: randomUUID() });
        const first = (await a.request('/me/pantry', 'POST', lot('40', '2026-12-01', 0))).data.id;
        const second = (await a.request('/me/pantry', 'POST', lot('60', null, 1))).data.id;
        const price = { foodId: food, amount: '20', currency: 'PHP', unitQuantity: '100', unit: 'g', priceBasis: 'package', storeName: null, recordedAt: '2026-11-20T00:00:00.000Z' };
        assert.equal((await a.request('/me/ingredient-prices', 'POST', price)).status, 201);
        const input = { budget: { amount: '25', currency: 'PHP' }, servings: '1', maxPrepMinutes: 20, pantryRevision: 2, excludedIngredientIds: [] };
        assert.equal((await a.request('/me/meal-plans/suggest', 'POST', input, false)).status, 403);
        const suggestion = (await a.request('/me/meal-plans/suggest', 'POST', input)).data[0];
        assert.equal(suggestion.items[0].shortageQuantity, '50');
        assert.equal(suggestion.knownConsumedCost, '30');
        assert.equal(suggestion.knownAdditionalCost, '10');
        assert.equal(suggestion.knownCheckoutCost, '20');
        assert.equal(suggestion.items[0].leftovers, '50');
        assert.equal(suggestion.withinBudget, true);
        assert.deepEqual(suggestion.allocations.map(({ lotId, quantity }) => ({ lotId, quantity })), [{ lotId: first, quantity: '40' }, { lotId: second, quantity: '60' }]);
        assert.equal((await a.request('/me/pantry')).data.revision, 2);
        assert.equal((await a.request('/me/meals')).data.meals.length, 0);
        assert.deepEqual((await b.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 0 })).data, []);
        const confirm = { ...input, expectedEstimateDigest: suggestion.estimateDigest, recipes: [{ recipeId, recipeRevision: 0 }], clientOperationId: randomUUID() };
        const saved = await a.request('/me/meal-plans/confirm', 'POST', confirm);
        assert.equal(saved.status, 201, JSON.stringify(saved));
        assert.deepEqual((await a.request('/me/meal-plans/confirm', 'POST', confirm)).data, saved.data);
        assert.deepEqual((await b.request('/me/meal-plans')).data, []);
        assert.equal((await a.request('/me/pantry')).data.revision, 2);
        const mealDate = '2026-11-20';
        const meal = await a.request('/me/meals', 'POST', {
            clientOperationId: randomUUID(), mealType: 'lunch', occurredAt: `${mealDate}T04:00:00.000Z`,
            items: [{ recipeId, recipeRevision: 0, quantity: '1', unit: 'serving' }],
        });
        assert.equal(meal.status, 201);
        const historicalMeal = (await a.request(`/me/meals?date=${mealDate}`)).data.meals[0];
        const multiSelection = [{ recipeId, recipeRevision: 0 }, { recipeId, recipeRevision: 0 }];
        const multiEstimate = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, recipes: multiSelection })).data[0];
        const multiPreview = (await a.request('/me/meal-plans/confirm', 'POST', { ...confirm, expectedEstimateDigest: multiEstimate.estimateDigest, recipes: multiSelection, clientOperationId: randomUUID() })).data;
        assert.equal(multiPreview.estimate.items[0].shortageQuantity, '200');
        assert.equal(multiPreview.estimate.allocations.reduce((total, a) => total + Number(a.quantity), 0), 100);
        const alternate = await a.request('/me/recipes', 'POST', {
            ...recipe, name: 'Alternate measured mass', items: [{ ...recipe.items[0], quantity: '0.1', unit: 'kg' }],
        });
        assert.equal(alternate.status, 201);
        const mixedUnits = (await a.request('/me/meal-plans/suggest', 'POST', {
            ...input, recipes: [{ recipeId, recipeRevision: 0 }, { recipeId: alternate.data.id, recipeRevision: 0 }],
        })).data[0];
        assert.equal(mixedUnits.items.length, 1);
        assert.equal(mixedUnits.items[0].quantity, '250');
        assert.equal(mixedUnits.items[0].shortageQuantity, '150');
        assert.equal(mixedUnits.knownCheckoutCost, '40');
        assert.equal((await a.request(`/me/recipes/${alternate.data.id}`, 'DELETE', { expectedRevision: 0 })).status, 200);
        const plan2 = (await a.request('/me/meal-plans/confirm', 'POST', { ...confirm, clientOperationId: randomUUID() })).data;
        const deduct = { expectedPantryRevision: 2, clientOperationId: randomUUID() }, other = { ...deduct, clientOperationId: randomUUID() };
        assert.equal((await b.request(`/me/meal-plans/${saved.data.id}/deduct`, 'POST', deduct)).status, 404);
        const race = await Promise.all([
            a.request(`/me/meal-plans/${saved.data.id}/deduct`, 'POST', deduct),
            a.request(`/me/meal-plans/${plan2.id}/deduct`, 'POST', other),
            ...Array.from({ length: 4 }, () => a.request(`/me/meal-plans/${saved.data.id}/deduct`, 'POST', deduct)),
        ]);
        assert.deepEqual(race.slice(0, 2).map(r => r.status).sort(), [200, 409]);
        for (const duplicate of race.slice(2)) {
            assert.equal(duplicate.status, race[0].status);
            if (duplicate.status === 200) assert.deepEqual(duplicate.data, race[0].data);
        }
        const winner = race[0].status === 200 ? { id: saved.data.id, body: deduct, result: race[0] } : { id: plan2.id, body: other, result: race[1] };
        assert.deepEqual((await a.request(`/me/meal-plans/${winner.id}/deduct`, 'POST', winner.body)).data, winner.result.data);
        assert.equal((await a.request(`/me/meal-plans/${winner.id}/deduct`, 'POST', { ...winner.body, expectedPantryRevision: 3 })).status, 409);
        const pantry = (await a.request('/me/pantry')).data;
        assert.equal(pantry.revision, 3);
        assert.ok(pantry.items.every(i => i.quantity === '0'));
        assert.equal((await a.request('/me/meal-plans/suggest', 'POST', input)).status, 409);
        const combinedEstimate = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 3, recipes: multiSelection })).data[0];
        const combined = (await a.request('/me/meal-plans/confirm', 'POST', { ...confirm, pantryRevision: 3, expectedEstimateDigest: combinedEstimate.estimateDigest, recipes: multiSelection, clientOperationId: randomUUID() })).data;
        assert.equal(combined.estimate.items[0].quantity, '300');
        assert.equal(combined.estimate.knownCheckoutCost, '60');
        await a.request('/me/ingredient-prices', 'POST', { ...price, amount: null, recordedAt: '2026-11-21T00:00:00.000Z' });
        assert.equal((await a.request('/me/meal-plans/confirm', 'POST', { ...confirm, pantryRevision: 3, expectedEstimateDigest: combinedEstimate.estimateDigest, recipes: multiSelection, clientOperationId: randomUUID() })).status, 409);
        const missing = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 3 })).data[0];
        assert.equal(missing.withinBudget, null);
        assert.deepEqual(missing.missingPrices, ['Synthetic rice']);
        const differentCurrency = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 3, budget: { amount: '100', currency: 'USD' } })).data[0];
        assert.equal(differentCurrency.withinBudget, null);
        const cupLot = { ...lot('1', null, 3), unit: 'cup' };
        assert.equal((await a.request('/me/pantry', 'POST', cupLot)).status, 201);
        const unsupported = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 4 })).data[0];
        assert.equal(unsupported.items[0].shortageQuantity, null);
        assert.equal(unsupported.withinBudget, null);
        assert.equal((await a.request('/me/pantry', 'POST', lot('150', null, 4))).status, 201);
        const covered = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 5 })).data[0];
        assert.equal(covered.items[0].shortageQuantity, '0');
        assert.equal(covered.knownCheckoutCost, '0');
        assert.equal(covered.withinBudget, null);
        assert.deepEqual(covered.missingConsumedPrices, ['Synthetic rice']);
        await a.request('/me/ingredient-prices', 'POST', { ...price, amount: '0', recordedAt: '2026-11-22T00:00:00.000Z' });
        const zero = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 5 })).data[0];
        assert.equal(zero.withinBudget, true);
        assert.equal(zero.knownConsumedCost, '0');
        await a.request(`/me/recipes/${recipeId}`, 'PATCH', { ...recipe, expectedRevision: 0, items: [{ ...recipe.items[0], unit: 'cup' }] });
        const unknown = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 5 })).data[0];
        assert.equal(unknown.items[0].consumedCost, null);
        const original = (await a.request('/me/meal-plans')).data.find(p => p.id === saved.data.id);
        assert.equal(original.estimate.items[0].quantity, '150');
        assert.equal(original.estimate.knownCheckoutCost, '20');
        assert.deepEqual((await a.request(`/me/meals?date=${mealDate}`)).data.meals[0], historicalMeal);
        const expired = await a.request('/me/pantry', 'POST', { ...lot('1000', '2000-01-01', 5), unit: 'cup' });
        assert.equal(expired.status, 201);
        const expiryPreview = (await a.request('/me/meal-plans/suggest', 'POST', { ...input, pantryRevision: 6 })).data[0];
        assert.ok(expiryPreview.allocations.every(allocation => allocation.lotId !== expired.data.id));
        assert.equal(expiryPreview.items[0].availableQuantity, '1');
        const shopping = (await a.request('/me/shopping-list')).data;
        assert.ok(shopping.length);
        assert.equal((await b.request(`/me/shopping-list/${shopping[0].id}`, 'PATCH', { purchased: true })).status, 404);
        assert.equal((await a.request(`/me/shopping-list/${shopping[0].id}`, 'PATCH', { purchased: true })).status, 200);
    }
    finally {
        await new Promise(resolve => server.close(resolve));
        try {
            for (const sql of ['DELETE FROM meal_plans WHERE user_id=ANY($1)', 'DELETE FROM meals WHERE user_id=ANY($1)', 'DELETE FROM recipes WHERE owner_id=ANY($1)', 'DELETE FROM pantry_items WHERE user_id=ANY($1)', 'DELETE FROM ingredient_prices WHERE user_id=ANY($1)', 'DELETE FROM users WHERE id=ANY($1)'])
                await db.query(sql, [[owner, peer]]);
        }
        finally {
            await db.end();
        }
    }
});
