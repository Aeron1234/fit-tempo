import { createHash, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { decimalSchema, revisionSchema, plannerSuggestSchema, planConfirmSchema, planDeductSchema, uuidSchema, type PlannerInput, type PlannerEstimate, type PlannerItem } from '@fit-tempo/contracts';
const S = 1000000n;
const n = (v: string) => { const [a, b = ''] = v.split('.'); return BigInt(a!) * S + BigInt(b.padEnd(6, '0')); };
function w(v: bigint) {
    const f = (v % S).toString().padStart(6, '0').replace(/0+$/, '');
    const result = `${v / S}${f ? `.${f}` : ''}`;
    if (!decimalSchema.safeParse(result).success)
        throw new PlannerError(400, 'VALIDATION_ERROR', 'Planner quantity is outside the supported range.');
    return result;
}
const div = (a: bigint, b: bigint) => (a + b / 2n) / b;
class PlannerError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly currentRevision?: number) { super(message); }
}
const invalid = () => new PlannerError(400, 'VALIDATION_ERROR', 'Provide valid planner selections, amounts and revisions.');
const route = (fn: RequestHandler): RequestHandler => async (req, res, next) => { try {
    await fn(req, res, next);
}
catch (e) {
    if (!(e instanceof PlannerError))
        return next(e);
    res.status(e.status).json({ error: { code: e.code, message: e.message, requestId: res.locals.requestId, ...(e.currentRevision === undefined ? {} : { currentRevision: e.currentRevision }) } });
} };
function parse<T>(schema: z.ZodType<T>, v: unknown): T { const result = schema.safeParse(v); if (!result.success)
    throw invalid(); return result.data; }
async function tx<T>(db: Pool, fn: (c: PoolClient) => Promise<T>) { const c = await db.connect(); try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
}
catch (e) {
    await c.query('ROLLBACK');
    throw e;
}
finally {
    c.release();
} }
type Recipe = {
    id: string;
    name: string;
    revision: number;
    servings: string;
    prep_minutes: number | null;
};
type Ingredient = {
    food_id: string;
    name: string;
    quantity: string;
    unit: string;
    grams_per_unit: string | null;
};
type Lot = {
    id: string;
    food_id: string;
    quantity: string;
    unit: string;
    expires_on: string | null;
    food_name: string;
};
type Price = {
    food_id: string;
    amount: string | null;
    unit_quantity: string;
    unit: string;
    price_basis: string;
};
function canonical(v: unknown): string { if (v instanceof Date) return JSON.stringify(v.toISOString()); return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v); }
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function factor(unit: string, grams: string | null): bigint | null { return unit === 'g' ? S : unit === 'kg' ? 1000n * S : unit === 'mg' ? 1000n : unit === 'serving' && grams ? n(grams) : null; }
function convert(value: bigint, from: string, to: string, grams: string | null) { if (from === to)
    return value; const a = factor(from, grams), b = factor(to, grams); if (a && b)
    return value * a % b === 0n ? value * a / b : null; if ((from === 'l' && to === 'ml'))
    return value * 1000n; if (from === 'ml' && to === 'l')
    return value % 1000n === 0n ? value / 1000n : null; return null; }
async function lock(c: PoolClient, user: string) { await c.query('INSERT INTO pantry_revisions(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user]); return Number((await c.query('SELECT revision FROM pantry_revisions WHERE user_id=$1 FOR UPDATE', [user])).rows[0].revision); }
async function recipes(c: PoolClient, user: string) { return (await c.query<Recipe>(`SELECT id,name,revision::integer,servings::text,prep_minutes FROM recipes WHERE archived_at IS NULL AND ((owner_id=$1 AND visibility='private') OR(owner_id IS NULL AND visibility='approved')) ORDER BY name,id LIMIT 100 FOR SHARE`, [user])).rows; }
async function estimate(c: PoolClient, user: string, input: PlannerInput, chosen: Recipe[], revision: number): Promise<PlannerEstimate> {
    if (revision !== input.pantryRevision)
        throw new PlannerError(409, 'PANTRY_CONFLICT', 'The pantry changed. Refresh the suggestion.', revision);
    const lots = (await c.query<Lot>(`SELECT p.id,p.food_id,p.quantity::text,p.unit,to_char(p.expires_on,'YYYY-MM-DD') AS expires_on,f.name AS food_name FROM pantry_items p JOIN foods f ON f.id=p.food_id WHERE p.user_id=$1 AND (p.expires_on IS NULL OR p.expires_on >= (now() AT TIME ZONE COALESCE((SELECT time_zone FROM user_preferences WHERE user_id=$1),'Asia/Manila'))::date) ORDER BY p.expires_on NULLS LAST,p.id FOR UPDATE OF p`, [user])).rows;
    const remaining = new Map(lots.map(l => [l.id, n(l.quantity)]));
    const prices = (await c.query<Price>('SELECT DISTINCT ON(food_id) food_id,amount::text,unit_quantity::text,unit,price_basis,recorded_at,store_name FROM ingredient_prices WHERE user_id=$1 AND currency=$2 ORDER BY food_id,recorded_at DESC,id DESC', [user, input.budget.currency])).rows;
    const needs = new Map<string, Ingredient>();
    const recipeDetails: unknown[] = [];
    for (const recipe of chosen) {
        recipeDetails.push((await c.query(`SELECT to_jsonb(r) || jsonb_build_object('ingredients',(SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('food',to_jsonb(f),'nutrients',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.nutrient_code) FROM food_nutrients n WHERE n.food_id=f.id)) ORDER BY i.position,i.id) FROM recipe_items i JOIN foods f ON f.id=i.food_id WHERE i.recipe_id=r.id),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.step_order) FROM recipe_steps s WHERE s.recipe_id=r.id)) AS snapshot FROM recipes r WHERE r.id=$1`, [recipe.id])).rows[0].snapshot);
        if (recipe.prep_minutes === null || recipe.prep_minutes > input.maxPrepMinutes)
            throw new PlannerError(409, 'REVISION_CONFLICT', 'Preparation time is unknown or exceeds the selected limit.');
        const ingredients = (await c.query<Ingredient>(`SELECT i.food_id,f.name,i.quantity::text,i.unit,CASE WHEN i.conversion_food_revision=f.revision THEN i.grams_per_unit::text END AS grams_per_unit FROM recipe_items i JOIN foods f ON f.id=i.food_id WHERE i.recipe_id=$2 AND ((f.owner_id=$1 AND f.visibility='private')OR(f.owner_id IS NULL AND f.visibility='approved')) ORDER BY i.position,i.id FOR SHARE OF i,f`, [user, recipe.id])).rows;
        const count = Number((await c.query('SELECT count(*) FROM recipe_items WHERE recipe_id=$1', [recipe.id])).rows[0].count);
        if (count !== ingredients.length)
            throw new PlannerError(404, 'NOT_FOUND', 'A recipe ingredient is unavailable.');
        for (const item of ingredients) {
            if (input.excludedIngredientIds.includes(item.food_id))
                throw new PlannerError(409, 'REVISION_CONFLICT', 'Recipe contains an excluded ingredient.');
            const scaledQuantity = div(n(item.quantity) * n(input.servings), n(recipe.servings));
            if (scaledQuantity === 0n) throw new PlannerError(400, 'VALIDATION_ERROR', 'Selected servings produce quantities below supported precision.');
            // Combine compatible requirements before rounding package purchases.
            // Unsupported conversions retain their original unit and coverage.
            const preferredUnit = factor(item.unit, item.grams_per_unit) !== null ? 'g'
                : ['ml', 'l'].includes(item.unit) ? 'ml' : item.unit;
            const converted = convert(scaledQuantity, item.unit, preferredUnit, item.grams_per_unit);
            const unit = converted === null ? item.unit : preferredUnit;
            const quantity = converted ?? scaledQuantity;
            const key = `${item.food_id}:${unit}`;
            const previous = needs.get(key);
            needs.set(key, { ...item, unit, quantity: w(quantity + (previous ? n(previous.quantity) : 0n)) });
        }
    }
    const allocations = new Map<string, bigint>();
    const items: PlannerItem[] = [];
    let consumed = 0n, additional = 0n, checkout = 0n;
    for (const item of needs.values()) {
        const quantity = n(item.quantity);
        let shortage = quantity, available = 0n, unknown = false;
        for (const lot of lots.filter(l => l.food_id === item.food_id)) {
            const stock = remaining.get(lot.id)!;
            const compatible = convert(stock, lot.unit, item.unit, item.grams_per_unit);
            if (compatible === null) {
                if (stock > 0n)
                    unknown = true;
                continue;
            }
            available += compatible;
            const take = shortage < compatible ? shortage : compatible;
            if (take <= 0n)
                continue;
            const deduction = convert(take, item.unit, lot.unit, item.grams_per_unit);
            if (deduction === null || deduction === 0n || deduction > stock) {
                unknown = true;
                continue;
            }
            remaining.set(lot.id, stock - deduction);
            allocations.set(lot.id, (allocations.get(lot.id) ?? 0n) + deduction);
            shortage -= take;
        }
        const price = prices.find(p => p.food_id === item.food_id);
        const priceSize = price ? convert(n(price.unit_quantity), price.unit, item.unit, item.grams_per_unit) : null;
        const priced = price?.amount !== null && price?.amount !== undefined && priceSize !== null && priceSize > 0n;
        const used = priced ? div(quantity * n(price!.amount!), priceSize!) : null;
        const extra = shortage === 0n ? 0n : priced && !unknown ? div(shortage * n(price!.amount!), priceSize!) : null;
        const packages = shortage === 0n ? 0n : priced && !unknown && price!.price_basis === 'package' ? (shortage + priceSize! - 1n) / priceSize! : null;
        const cost = packages === null ? null : packages * (price ? n(price.amount ?? '0') : 0n);
        consumed += used ?? 0n;
        additional += extra ?? 0n;
        checkout += cost ?? 0n;
        items.push({ foodId: item.food_id, foodName: item.name, quantity: item.quantity, unit: item.unit, availableQuantity: w(available), shortageQuantity: unknown && shortage > 0n ? null : w(shortage), quantityUnknown: unknown && shortage > 0n,
            consumedCost: used === null ? null : w(used), additionalCost: extra === null ? null : w(extra), checkoutCost: cost === null ? null : w(cost), packageQuantity: packages === null || !priceSize ? null : w(packages * priceSize), leftovers: packages === null || !priceSize ? null : w(packages * priceSize - shortage) });
    }
    const missingPrices = items.filter(i => i.additionalCost === null).map(i => i.foodName), missingQuantities = items.filter(i => i.quantityUnknown).map(i => i.foodName), missingPackagePrices = items.filter(i => i.checkoutCost === null).map(i => i.foodName);
    const result = { recipeDetails, priceSnapshots: prices.filter(p => [...needs.values()].some(i => i.food_id === p.food_id)), budgetAmount: input.budget.amount, missingConsumedPrices: items.filter(i => i.consumedCost === null).map(i => i.foodName), recipes: chosen.map(r => ({ recipeId: r.id, recipeRevision: r.revision, name: r.name, servings: input.servings })), pantryRevision: revision, items, currency: input.budget.currency, knownConsumedCost: w(consumed), knownAdditionalCost: w(additional), knownCheckoutCost: w(checkout), missingPrices, missingQuantities, missingPackagePrices, withinBudget: items.some(i => i.consumedCost === null) || missingPrices.length || missingQuantities.length || missingPackagePrices.length ? null : checkout <= n(input.budget.amount), budgetBasis: 'package_checkout' as const, allocations: [...allocations].map(([lotId, quantity]) => ({ lotId, quantity: w(quantity), unit: lots.find(l => l.id === lotId)!.unit, foodName: lots.find(l => l.id === lotId)!.food_name, expiresOn: lots.find(l => l.id === lotId)!.expires_on })), assumptions: ['Pantry amounts are user-recorded; check expiry and storage before use.', 'No allergen safety guarantee; review structured ingredients and labels.', 'No inferred density, cup or count conversion.', 'Expiry cutoff uses your current preferred timezone; expired dated lots are excluded.', 'Known preparation time required.'] };
    return { ...result, estimateDigest: digest(result) };
}
async function receipt(c: PoolClient, user: string, operation: string, key: string, payload: unknown, change: () => Promise<unknown>) { const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v); const digest = createHash('sha256').update(canonical({ operation, payload })).digest('hex'); const row = (await c.query('SELECT o.payload_digest,r.commit_summary FROM operation_receipts o JOIN mutation_results r ON(r.user_id,r.operation_type,r.id)=(o.user_id,o.operation_type,o.result_reference) WHERE o.user_id=$1 AND o.operation_type=$2 AND o.client_operation_id=$3', [user, operation, key])).rows[0]; if (row) {
    if (row.payload_digest !== digest)
        throw new PlannerError(409, 'IDEMPOTENCY_CONFLICT', 'Operation ID was used with different details.');
    return row.commit_summary;
} const result = await change(); const id = randomUUID(); await c.query('INSERT INTO mutation_results(id,user_id,operation_type,commit_summary) VALUES($1,$2,$3,$4)', [id, user, operation, JSON.stringify(result)]); await c.query('INSERT INTO operation_receipts(id,user_id,operation_type,client_operation_id,payload_digest,result_reference) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), user, operation, key, digest, id]); return result; }
export function createPlannerRouter(db: Pool) {
    const router = Router();
    router.post('/meal-plans/suggest', route(async (req, res) => { const input = parse(plannerSuggestSchema, req.body); const data = await tx(db, async (c) => { const revision = Number((await c.query('SELECT revision FROM pantry_revisions WHERE user_id=$1 FOR SHARE', [res.locals.userId])).rows[0]?.revision ?? 0); if (revision !== input.pantryRevision)
        throw new PlannerError(409, 'PANTRY_CONFLICT', 'The pantry changed. Refresh the suggestion.', revision); const result: PlannerEstimate[] = []; const all = await recipes(c, res.locals.userId); if (input.recipes) {
        const selected = input.recipes.map(r => { const match = all.find(a => a.id === r.recipeId && a.revision === r.recipeRevision); if (!match)
            throw new PlannerError(409, 'REVISION_CONFLICT', 'Recipe changed or unavailable.'); return match; });
        return [await estimate(c, res.locals.userId, input, selected, revision)];
    } for (const recipe of all) {
        try {
            result.push(await estimate(c, res.locals.userId, input, [recipe], revision));
        }
        catch (e) {
            if (e instanceof PlannerError && e.code === 'REVISION_CONFLICT')
                continue;
            throw e;
        }
    } return result.sort((a, b) => a.items.filter(i => i.shortageQuantity !== '0').length - b.items.filter(i => i.shortageQuantity !== '0').length || a.missingQuantities.length - b.missingQuantities.length || a.missingPackagePrices.length - b.missingPackagePrices.length || (n(a.knownCheckoutCost) < n(b.knownCheckoutCost) ? -1 : n(a.knownCheckoutCost) > n(b.knownCheckoutCost) ? 1 : 0) || a.recipes[0]!.recipeId.localeCompare(b.recipes[0]!.recipeId)); }); res.json({ data }); }));
    router.post('/meal-plans/confirm', route(async (req, res) => { const input = parse(planConfirmSchema, req.body); const user = res.locals.userId; res.status(201).json({ data: await tx(db, async (c) => { const revision = await lock(c, user); return receipt(c, user, 'confirm_meal_plan', input.clientOperationId, input, async () => { const all = await recipes(c, user); const selected = input.recipes.map(selection => { const recipe = all.find(r => r.id === selection.recipeId); if (!recipe)
            throw new PlannerError(404, 'NOT_FOUND', 'Recipe unavailable.'); if (recipe.revision !== selection.recipeRevision)
            throw new PlannerError(409, 'REVISION_CONFLICT', 'Recipe changed. Refresh the suggestion.'); return recipe; }); const result = await estimate(c, user, input, selected, revision); if (result.estimateDigest !== input.expectedEstimateDigest)
            throw new PlannerError(409, 'REVISION_CONFLICT', 'The estimate changed. Review a fresh suggestion before saving.'); if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 55000)
            throw new PlannerError(400, 'VALIDATION_ERROR', 'This plan snapshot is too large. Select fewer recipes.'); const id = randomUUID(); await c.query(`INSERT INTO meal_plans(id,user_id,recipe_snapshot,servings,planned_at,budget,currency,state) VALUES($1,$2,$3,$4,now(),$5,$6,'confirmed')`, [id, user, JSON.stringify(result), input.servings, input.budget.amount, input.budget.currency]); for (const item of result.items)
            if (item.shortageQuantity !== '0')
                await c.query('INSERT INTO shopping_items(id,meal_plan_id,food_id,food_name,shortage_quantity,unit,package_quantity,price_snapshot,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), id, item.foodId, item.foodName, item.shortageQuantity, item.unit, item.packageQuantity === '0' ? null : item.packageQuantity, item.checkoutCost, item.checkoutCost === null ? null : result.currency]); return { id, estimate: result }; }); }) }); }));
    router.get('/meal-plans', route(async (_req, res) => res.json({ data: (await db.query('SELECT id,recipe_snapshot AS estimate,deducted_at IS NOT NULL AS deducted,created_at AS "createdAt" FROM meal_plans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [res.locals.userId])).rows })));
    router.post('/meal-plans/:id/deduct', route(async (req, res) => { const id = parse(uuidSchema, req.params.id), input = parse(planDeductSchema, req.body), user = res.locals.userId; res.json({ data: await tx(db, async (c) => { const revision = await lock(c, user); if (!(await c.query('SELECT 1 FROM meal_plans WHERE user_id=$1 AND id=$2', [user, id])).rowCount)
            throw new PlannerError(404, 'NOT_FOUND', 'Plan unavailable.'); return receipt(c, user, 'deduct_pantry', input.clientOperationId, { id, ...input }, async () => { const plan = (await c.query('SELECT recipe_snapshot,deducted_at FROM meal_plans WHERE user_id=$1 AND id=$2 FOR UPDATE', [user, id])).rows[0]; if (!plan)
            throw new PlannerError(404, 'NOT_FOUND', 'Plan unavailable.'); if (plan.deducted_at)
            throw new PlannerError(409, 'PANTRY_CONFLICT', 'This plan was already deducted.', revision); const snapshot = plan.recipe_snapshot as PlannerEstimate; if (revision !== input.expectedPantryRevision || revision !== snapshot.pantryRevision)
            throw new PlannerError(409, 'PANTRY_CONFLICT', 'The pantry changed. Save a refreshed preview before deduction.', revision); if (snapshot.missingQuantities.length)
            throw new PlannerError(409, 'INSUFFICIENT_PANTRY', 'Resolve unknown quantities before deduction.'); if (!revisionSchema.safeParse(revision + 1).success)
            throw new PlannerError(409, 'PANTRY_CONFLICT', 'Pantry revision limit reached.', revision); const today = (await c.query("SELECT to_char((now() AT TIME ZONE COALESCE((SELECT time_zone FROM user_preferences WHERE user_id=$1),'Asia/Manila'))::date,'YYYY-MM-DD') AS date", [user])).rows[0].date; for (const allocation of snapshot.allocations) {
            if (allocation.expiresOn !== null && allocation.expiresOn < today)
                throw new PlannerError(409, 'PANTRY_CONFLICT', 'A pantry lot expired. Save a refreshed preview.', revision);
            const result = await c.query('UPDATE pantry_items SET quantity=quantity-$3,revision=$4,updated_at=now() WHERE user_id=$1 AND id=$2 AND quantity >= $3', [user, allocation.lotId, allocation.quantity, revision + 1]);
            if (!result.rowCount)
                throw new PlannerError(409, 'INSUFFICIENT_PANTRY', 'Pantry quantities changed.');
        } await c.query('UPDATE pantry_revisions SET revision=$2,updated_at=now() WHERE user_id=$1', [user, revision + 1]); await c.query('UPDATE meal_plans SET deducted_at=now(),updated_at=now() WHERE user_id=$1 AND id=$2', [user, id]); return { id, revision: revision + 1 }; }); }) }); }));
    router.get('/shopping-list', route(async (_req, res) => res.json({ data: (await db.query('SELECT s.id,s.meal_plan_id AS "mealPlanId",s.food_name AS "foodName",s.shortage_quantity::text AS "shortageQuantity",s.unit,s.purchased FROM shopping_items s JOIN meal_plans p ON p.id=s.meal_plan_id WHERE p.user_id=$1 ORDER BY p.created_at DESC,s.id LIMIT 100', [res.locals.userId])).rows })));
    router.patch('/shopping-list/:id', route(async (req, res) => { const id = parse(uuidSchema, req.params.id), input = parse(z.strictObject({ purchased: z.boolean() }), req.body); const result = await db.query('UPDATE shopping_items s SET purchased=$3 FROM meal_plans p WHERE s.meal_plan_id=p.id AND p.user_id=$1 AND s.id=$2 RETURNING s.id,s.purchased', [res.locals.userId, id, input.purchased]); if (!result.rowCount)
        throw new PlannerError(404, 'NOT_FOUND', 'Shopping item unavailable.'); res.json({ data: result.rows[0] }); }));
    return router;
}
