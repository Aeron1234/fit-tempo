import { createHash, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  ingredientPriceWriteSchema, pantryDeleteSchema, pantryWriteSchema, recipeDeleteSchema,
  recipeEditSchema, recipeWriteSchema, revisionSchema, uuidSchema,
} from '@fit-tempo/contracts';

type RecipeWrite = z.infer<typeof recipeWriteSchema>;
type PantryWrite = z.infer<typeof pantryWriteSchema>;
type PantryPreconditions = z.infer<typeof pantryDeleteSchema>;
type PantryOperation = 'create_pantry_lot' | 'edit_pantry_lot' | 'delete_pantry_lot';
type WriteResult = { id: string; revision: number };
type FailureCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'PANTRY_CONFLICT' | 'IDEMPOTENCY_CONFLICT';

class IngredientError extends Error {
  constructor(readonly status: number, readonly code: FailureCode, message: string, readonly currentRevision?: number) {
    super(message);
  }
}

function missing(resource: string) {
  return new IngredientError(404, 'NOT_FOUND', `${resource} is unavailable.`);
}

function checked<T>(schema: z.ZodType<T>, value: unknown, message: string) {
  const input = schema.safeParse(value);
  if (!input.success) throw new IngredientError(400, 'VALIDATION_ERROR', message);
  return input.data;
}

const route = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    if (!(error instanceof IngredientError)) return next(error);
    res.status(error.status).json({ error: {
      code: error.code, message: error.message, requestId: res.locals.requestId,
      ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
    } });
  }
};

async function transaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type FoodRef = { id: string; revision: string; basis: string; basis_grams: string | null };
async function visibleFoods(db: PoolClient, userId: string, ids: string[]) {
  const keys = [...new Set(ids.map(id => id.toLowerCase()))];
  const { rows } = await db.query<FoodRef>(`
    SELECT id, revision, basis, trim_scale(basis_grams)::text AS basis_grams FROM foods
    WHERE id = ANY($2::uuid[]) AND ((owner_id = $1 AND visibility = 'private')
      OR (owner_id IS NULL AND visibility = 'approved'))
    ORDER BY id FOR SHARE
  `, [userId, keys]);
  if (rows.length !== keys.length) throw missing('Food');
  return new Map(rows.map(food => [food.id, food]));
}

async function recipeChildren(db: PoolClient, userId: string, id: string, input: RecipeWrite) {
  const foods = await visibleFoods(db, userId, input.items.map(item => item.foodId));
  for (const [position, item] of input.items.entries()) {
    const food = foods.get(item.foodId.toLowerCase())!;
    const revision = Number(food.revision);
    if (revision !== item.nutrientRevision)
      throw new IngredientError(409, 'REVISION_CONFLICT', 'The food changed. Reload its current details.', revision);
    const gramsPerUnit = item.unit === 'serving' && food.basis === 'perServing' ? food.basis_grams : null;
    await db.query(`
      INSERT INTO recipe_items (id, recipe_id, food_id, quantity, unit, grams_per_unit, conversion_food_revision, position)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [randomUUID(), id, item.foodId, item.quantity, item.unit, gramsPerUnit, gramsPerUnit === null ? null : revision, position]);
  }
  for (const [position, instruction] of input.steps.entries()) {
    await db.query('INSERT INTO recipe_steps (id, recipe_id, step_order, instruction) VALUES ($1, $2, $3, $4)',
      [randomUUID(), id, position + 1, instruction]);
  }
}

function nextRevision(current: number, expected: number, pantry = false) {
  if (current !== expected || !revisionSchema.safeParse(current + 1).success) {
    throw new IngredientError(409, pantry ? 'PANTRY_CONFLICT' : 'REVISION_CONFLICT',
      pantry ? 'The pantry changed. Reload it before trying again.' : 'The recipe changed. Reload it before trying again.', current);
  }
  return current + 1;
}

async function ownedRecipeRevision(db: PoolClient, userId: string, id: string, expected: number) {
  const { rows: [row] } = await db.query<{ revision: string }>(`
    SELECT revision FROM recipes WHERE owner_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE
  `, [userId, id]);
  if (!row) throw missing('Recipe');
  return nextRevision(Number(row.revision), expected);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function writePantry(db: PoolClient, userId: string, operation: PantryOperation, id: string | null,
  input: PantryPreconditions, change: (revision: number) => Promise<string>) {
  await db.query('INSERT INTO pantry_revisions (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  const { rows: [state] } = await db.query<{ revision: string }>(
    'SELECT revision FROM pantry_revisions WHERE user_id = $1 FOR UPDATE', [userId]);
  const digest = createHash('sha256').update(canonical({ operation, identity: { id }, payload: input }), 'utf8').digest('hex');
  const { rows: [receipt] } = await db.query<{ payload_digest: string; commit_summary: WriteResult }>(`
    SELECT o.payload_digest, r.commit_summary FROM operation_receipts o
    JOIN mutation_results r ON (r.user_id, r.operation_type, r.id) = (o.user_id, o.operation_type, o.result_reference)
    WHERE o.user_id = $1 AND o.operation_type = $2 AND o.client_operation_id = $3
  `, [userId, operation, input.clientOperationId]);
  if (receipt) {
    if (receipt.payload_digest !== digest)
      throw new IngredientError(409, 'IDEMPOTENCY_CONFLICT', 'This operation ID was already used with different details.');
    return receipt.commit_summary;
  }

  if (id) {
    const lot = await db.query('SELECT 1 FROM pantry_items WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, id]);
    if (!lot.rowCount) throw missing('Pantry lot');
  }
  const revision = nextRevision(Number(state.revision), input.expectedPantryRevision, true);
  const lotId = await change(revision);
  const data = { id: lotId, revision };
  const resultId = randomUUID();
  await db.query('UPDATE pantry_revisions SET revision = $2, updated_at = now() WHERE user_id = $1', [userId, revision]);
  await db.query('INSERT INTO mutation_results (id, user_id, operation_type, commit_summary) VALUES ($1, $2, $3, $4)',
    [resultId, userId, operation, JSON.stringify(data)]);
  await db.query(`
    INSERT INTO operation_receipts (id, user_id, operation_type, client_operation_id, payload_digest, result_reference)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [randomUUID(), userId, operation, input.clientOperationId, digest, resultId]);
  return data;
}

function storeLot(db: Pool, userId: string, input: PantryWrite, id: string | null) {
  const operation = id ? 'edit_pantry_lot' : 'create_pantry_lot';
  return transaction(db, client => writePantry(client, userId, operation, id, input, async revision => {
    await visibleFoods(client, userId, [input.foodId]);
    const lotId = id ?? randomUUID();
    const values = [lotId, userId, input.foodId, input.quantity, input.unit, input.expiresOn, revision];
    if (id) {
      await client.query(`
        UPDATE pantry_items SET food_id = $3, quantity = $4, unit = $5, expires_on = $6,
          revision = $7, updated_at = now() WHERE id = $1 AND user_id = $2
      `, values);
    } else {
      await client.query(`
        INSERT INTO pantry_items (id, user_id, food_id, quantity, unit, expires_on, revision)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, values);
    }
    return lotId;
  }));
}

async function readPantry(db: Pool, userId: string) {
  const { rows: [pantry] } = await db.query<{ revision: number; items: unknown[] }>(`
    SELECT COALESCE((SELECT revision FROM pantry_revisions WHERE user_id = $1), 0)::double precision AS revision,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'foodId', p.food_id, 'foodName', f.name, 'quantity', trim_scale(p.quantity)::text,
        'unit', p.unit, 'expiresOn', to_char(p.expires_on, 'YYYY-MM-DD')
      ) ORDER BY p.expires_on NULLS LAST, p.id)
      FROM pantry_items p JOIN foods f ON f.id = p.food_id WHERE p.user_id = $1), '[]'::jsonb) AS items
  `, [userId]);
  return pantry;
}

async function readRecipes(db: Pool, userId: string) {
  const { rows } = await db.query(`
    SELECT r.id, r.name, r.revision::double precision AS revision, COALESCE(r.owner_id = $1, false) AS editable,
      trim_scale(r.servings)::text AS servings, trim_scale(r.cooked_yield_grams)::text AS "cookedYieldGrams",
      r.prep_minutes AS "prepMinutes",
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'foodId', i.food_id, 'foodName', f.name, 'nutrientRevision', f.revision, 'quantity', trim_scale(i.quantity)::text,
        'unit', i.unit,
        'gramsPerUnit', CASE WHEN i.conversion_food_revision = f.revision THEN trim_scale(i.grams_per_unit)::text END,
        'conversionFoodRevision', CASE WHEN i.conversion_food_revision = f.revision THEN i.conversion_food_revision END
      ) ORDER BY i.position, i.id) FROM recipe_items i JOIN foods f ON f.id = i.food_id WHERE i.recipe_id = r.id), '[]'::jsonb) AS items,
      COALESCE((SELECT jsonb_agg(s.instruction ORDER BY s.step_order)
        FROM recipe_steps s WHERE s.recipe_id = r.id), '[]'::jsonb) AS steps
    FROM recipes r
    WHERE r.archived_at IS NULL AND ((r.owner_id = $1 AND r.visibility = 'private')
      OR (r.owner_id IS NULL AND r.visibility = 'approved'))
    ORDER BY r.name, r.id
  `, [userId]);
  return rows;
}

export function createIngredientsRouter(db: Pool) {
  const router = Router();
  router.get('/recipes', route(async (_req, res) => {
    res.json({ data: await readRecipes(db, res.locals.userId) });
  }));
  router.post('/recipes', route(async (req, res) => {
    const input = checked(recipeWriteSchema, req.body, 'Provide valid servings, yield, ingredients and recipe steps.');
    const id = randomUUID();
    const userId: string = res.locals.userId;
    await transaction(db, async client => {
      await client.query(`
        INSERT INTO recipes (id, owner_id, visibility, name, servings, cooked_yield_grams, prep_minutes)
        VALUES ($1, $2, 'private', $3, $4, $5, $6)
      `, [id, userId, input.name, input.servings, input.cookedYieldGrams, input.prepMinutes]);
      await recipeChildren(client, userId, id, input);
    });
    res.status(201).json({ data: { id, revision: 0 } });
  }));
  router.patch('/recipes/:id', route(async (req, res) => {
    const id = checked(uuidSchema, req.params.id, 'Provide a valid recipe ID.');
    const input = checked(recipeEditSchema, req.body, 'Provide a valid revision and recipe details.');
    const userId: string = res.locals.userId;
    const revision = await transaction(db, async client => {
      const next = await ownedRecipeRevision(client, userId, id, input.expectedRevision);
      await client.query(`
        UPDATE recipes SET name = $3, servings = $4, cooked_yield_grams = $5, prep_minutes = $6,
          revision = $7, updated_at = now() WHERE owner_id = $1 AND id = $2
      `, [userId, id, input.name, input.servings, input.cookedYieldGrams, input.prepMinutes, next]);
      await client.query('DELETE FROM recipe_items WHERE recipe_id = $1', [id]);
      await client.query('DELETE FROM recipe_steps WHERE recipe_id = $1', [id]);
      await recipeChildren(client, userId, id, input);
      return next;
    });
    res.json({ data: { id, revision } });
  }));
  router.delete('/recipes/:id', route(async (req, res) => {
    const id = checked(uuidSchema, req.params.id, 'Provide a valid recipe ID.');
    const input = checked(recipeDeleteSchema, req.body, 'Provide a valid recipe revision.');
    const userId: string = res.locals.userId;
    const revision = await transaction(db, async client => {
      const next = await ownedRecipeRevision(client, userId, id, input.expectedRevision);
      await client.query('UPDATE recipes SET archived_at = now(), updated_at = now(), revision = $3 WHERE owner_id = $1 AND id = $2',
        [userId, id, next]);
      return next;
    });
    res.json({ data: { id, revision } });
  }));
  router.get('/pantry', route(async (_req, res) => {
    res.json({ data: await readPantry(db, res.locals.userId) });
  }));
  router.post('/pantry', route(async (req, res) => {
    const input = checked(pantryWriteSchema, req.body, 'Provide a valid food, pantry amount, expiry date and revision.');
    res.status(201).json({ data: await storeLot(db, res.locals.userId, input, null) });
  }));
  router.patch('/pantry/:id', route(async (req, res) => {
    const id = checked(uuidSchema, req.params.id, 'Provide a valid pantry lot ID.');
    const input = checked(pantryWriteSchema, req.body, 'Provide a valid food, pantry amount, expiry date and revision.');
    res.json({ data: await storeLot(db, res.locals.userId, input, id) });
  }));
  router.delete('/pantry/:id', route(async (req, res) => {
    const id = checked(uuidSchema, req.params.id, 'Provide a valid pantry lot ID.');
    const input = checked(pantryDeleteSchema, req.body, 'Provide a valid pantry revision and operation ID.');
    const userId: string = res.locals.userId;
    const data = await transaction(db, client => writePantry(client, userId, 'delete_pantry_lot', id, input, async () => {
      await client.query('DELETE FROM pantry_items WHERE user_id = $1 AND id = $2', [userId, id]);
      return id;
    }));
    res.json({ data });
  }));
  router.get('/ingredient-prices', route(async (_req, res) => {
    const { rows } = await db.query(`
      SELECT p.id, p.food_id AS "foodId", f.name AS "foodName", trim_scale(p.amount)::text AS amount, p.currency::text,
        trim_scale(p.unit_quantity)::text AS "unitQuantity", p.unit, p.price_basis AS "priceBasis",
        p.store_name AS "storeName", p.recorded_at AS "recordedAt"
      FROM ingredient_prices p JOIN foods f ON f.id = p.food_id WHERE p.user_id = $1
      ORDER BY p.recorded_at DESC, p.id
    `, [res.locals.userId]);
    res.json({ data: rows });
  }));
  router.post('/ingredient-prices', route(async (req, res) => {
    const input = checked(ingredientPriceWriteSchema, req.body, 'Provide a valid price or unknown amount, currency and package basis.');
    const id = randomUUID();
    const userId: string = res.locals.userId;
    await transaction(db, async client => {
      await visibleFoods(client, userId, [input.foodId]);
      await client.query(`
        INSERT INTO ingredient_prices (id, user_id, food_id, amount, currency, unit_quantity, unit, price_basis, store_name, recorded_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [id, userId, input.foodId, input.amount, input.currency, input.unitQuantity, input.unit,
        input.priceBasis, input.storeName, input.recordedAt]);
    });
    res.status(201).json({ data: { id } });
  }));
  return router;
}

