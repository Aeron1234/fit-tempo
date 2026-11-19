import { createHash, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import {
  dayStatusRequestSchema, localDateAt, localDateSchema, mealDayQuerySchema, mealDeleteSchema,
  mealEditSchema, mealItemEditSchema, mealWriteSchema, revisionSchema, uuidSchema,
  type MealEdit, type MealItemWrite, type MealType, type MealWrite, type TrackingDay,
} from '@fit-tempo/contracts';
import { invalid, MealError, mealTotals, missing, snapshotItem, type MealItem } from './meals/snapshots.js';

type MealRow = {
  id: string;
  revision: string;
  meal_type: MealType;
  occurred_at: Date;
  recorded_time_zone: string;
  local_date: string;
  image_id: string | null;
  cursor_time?: string;
  deleted_at: Date | null;
  items: MealItem[];
};

const mealColumns = `
  m.id, m.revision, m.meal_type, m.occurred_at, m.recorded_time_zone,
  to_char(m.recorded_local_date, 'YYYY-MM-DD') AS local_date, m.image_id, m.deleted_at,
  to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', i.id, 'snapshot', i.nutrition_snapshot)
      || CASE WHEN i.recipe_snapshot IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('recipeSnapshot', i.recipe_snapshot) END
      ORDER BY i.position, i.id) FROM meal_items i WHERE i.meal_id = m.id
  ), '[]'::jsonb) AS items
`;
const pageSize = 20;
type Operation = 'log_meal' | 'edit_meal' | 'delete_meal' | 'edit_meal_item';
type DayState = 'unrecorded' | 'partial' | 'complete';
type Database = Pick<Pool | PoolClient, 'query'>;

function expose(row: MealRow) {
  return {
    id: row.id, revision: Number(row.revision), mealType: row.meal_type,
    occurredAt: row.occurred_at.toISOString(), timeZone: row.recorded_time_zone,
    localDate: row.local_date, imageId: row.image_id, items: row.items, ...mealTotals(row.items),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${fields.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const route = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    if (!(error instanceof MealError)) return next(error);
    res.status(error.status).json({ error: {
      code: error.code, message: error.message, requestId: res.locals.requestId,
      ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
    } });
  }
};

async function transaction<T>(db: Pool, userId: string, run: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // All meal and nutrition-day writers share this lock, including rows that do not exist yet.
    await client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function saveOnce<T extends object>(db: PoolClient, userId: string, operation: Operation,
  payload: { clientOperationId: string }, identity: object, write: () => Promise<T>) {
  const digest = createHash('sha256').update(canonical({ operation, identity, payload }), 'utf8').digest('hex');
  const { rows: [receipt] } = await db.query<{ payload_digest: string; commit_summary: T }>(`
    SELECT o.payload_digest, r.commit_summary
    FROM operation_receipts o JOIN mutation_results r
      ON (r.user_id, r.operation_type, r.id) = (o.user_id, o.operation_type, o.result_reference)
    WHERE o.user_id = $1 AND o.operation_type = $2 AND o.client_operation_id = $3
  `, [userId, operation, payload.clientOperationId]);
  if (receipt) {
    if (receipt.payload_digest !== digest)
      throw new MealError(409, 'IDEMPOTENCY_CONFLICT', 'This operation ID was already used with different details.');
    return receipt.commit_summary;
  }

  const result = await write();
  const reference = randomUUID();
  await db.query(`
    INSERT INTO mutation_results (id, user_id, operation_type, commit_summary)
    VALUES ($1, $2, $3, $4)
  `, [reference, userId, operation, JSON.stringify(result)]);
  await db.query(`
    INSERT INTO operation_receipts (id, user_id, operation_type, client_operation_id, payload_digest, result_reference)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [randomUUID(), userId, operation, payload.clientOperationId, digest, reference]);
  return result;
}

async function preferredZone(db: Database, userId: string) {
  const { rows } = await db.query<{ time_zone: string }>('SELECT time_zone FROM user_preferences WHERE user_id = $1', [userId]);
  return rows[0]?.time_zone ?? 'Asia/Manila';
}

async function ownedMeal(db: PoolClient, userId: string, id: string) {
  const { rows } = await db.query<MealRow>(`
    SELECT ${mealColumns} FROM meals m WHERE m.user_id = $1 AND m.id = $2
    FOR NO KEY UPDATE OF m
  `, [userId, id]);
  if (!rows[0]) throw missing('Meal');
  return rows[0];
}

function nextRevision(row: MealRow, expectedRevision: number) {
  if (row.deleted_at !== null) throw missing('Meal');
  const revision = Number(row.revision);
  if (revision !== expectedRevision || !revisionSchema.safeParse(revision + 1).success)
    throw new MealError(409, 'REVISION_CONFLICT', 'The meal changed. Reload it before saving.', revision);
  return revision + 1;
}

async function checkPhoto(db: PoolClient, userId: string, imageId: string | null) {
  if (imageId === null) return;
  const result = await db.query(`
    SELECT id FROM files WHERE user_id = $1 AND id = $2 AND kind = 'food_photo' AND state = 'ready'
    FOR SHARE
  `, [userId, imageId]);
  if (!result.rowCount) throw missing('Food photo');
}

async function recordDay(db: PoolClient, userId: string, date: string, zone: string, complete = false) {
  const { rows } = await db.query<Omit<TrackingDay, 'confirmedAt' | 'revision'> & { confirmedAt: Date | null; revision: string }>(`
    WITH stats AS (
      SELECT count(*)::integer AS amount
      FROM meals WHERE user_id = $1 AND recorded_local_date = $2 AND deleted_at IS NULL
    ), first_meal AS (
      SELECT recorded_time_zone FROM meals WHERE user_id = $1 AND recorded_local_date = $2 AND deleted_at IS NULL
      ORDER BY occurred_at, id LIMIT 1
    )
    INSERT INTO daily_tracking_status (id, user_id, category, recorded_local_date, recorded_time_zone,
      state, entry_count, confirmed_at)
    SELECT $3, $1, 'nutrition', $2, COALESCE(first_meal.recorded_time_zone, $4),
      CASE WHEN $5 THEN 'complete' WHEN stats.amount > 0 THEN 'partial' ELSE 'unrecorded' END,
      stats.amount, CASE WHEN $5 THEN now() END FROM stats LEFT JOIN first_meal ON true
    ON CONFLICT (user_id, category, recorded_local_date) DO UPDATE SET
      recorded_time_zone = CASE WHEN EXCLUDED.entry_count = 0 THEN daily_tracking_status.recorded_time_zone
        ELSE EXCLUDED.recorded_time_zone END,
      state = EXCLUDED.state,
      entry_count = EXCLUDED.entry_count,
      confirmed_at = EXCLUDED.confirmed_at,
      revision = daily_tracking_status.revision + 1,
      updated_at = now()
    RETURNING to_char(recorded_local_date, 'YYYY-MM-DD') AS "localDate", recorded_time_zone AS "timeZone",
      category, state, entry_count AS "entryCount", confirmed_at AS "confirmedAt", revision
  `, [userId, date, randomUUID(), zone, complete]);
  const row = rows[0];
  return { ...row, confirmedAt: row.confirmedAt?.toISOString() ?? null, revision: Number(row.revision) };
}

async function archive(db: PoolClient, userId: string, meal: MealRow) {
  await db.query(`
    INSERT INTO meal_history (user_id, meal_id, revision, record) VALUES ($1, $2, $3, $4)
  `, [userId, meal.id, meal.revision, JSON.stringify(expose(meal))]);
}

async function insertItem(db: PoolClient, mealId: string, position: number, item: MealItem, manual: boolean) {
  const snapshot = item.snapshot;
  await db.query(`
    INSERT INTO meal_items (id, meal_id, food_id, quantity, unit, grams, nutrition_snapshot, position, recipe_id, recipe_snapshot_version, recipe_snapshot)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [item.id, mealId, manual || item.recipeSnapshot ? null : snapshot.foodId, snapshot.quantity.value, snapshot.quantity.unit,
    snapshot.grams, JSON.stringify(snapshot), position, item.recipeSnapshot?.recipeId ?? null,
    item.recipeSnapshot?.snapshotVersion ?? null, item.recipeSnapshot ? JSON.stringify(item.recipeSnapshot) : null]);
}

async function replaceItems(db: PoolClient, userId: string, mealId: string, inputs: MealEdit['items'], current: MealItem[]) {
  const retained = new Set(inputs.flatMap(input => 'itemId' in input ? [input.itemId] : []));
  await db.query('DELETE FROM meal_items WHERE meal_id = $1 AND NOT (id = ANY($2::uuid[]))', [mealId, [...retained]]);
  const result: MealItem[] = [];
  for (const [position, input] of inputs.entries()) {
    if ('itemId' in input) {
      const saved = current.find(item => item.id === input.itemId);
      if (!saved || result.includes(saved)) throw invalid('Choose distinct existing items from this meal.');
      await db.query('UPDATE meal_items SET position = $1 WHERE meal_id = $2 AND id = $3', [position, mealId, saved.id]);
      result.push(saved);
      continue;
    }
    const item = await snapshotItem(db, userId, input);
    await insertItem(db, mealId, position, item, 'manual' in input);
    result.push(item);
  }
  return result;
}

function parseCursor(value?: string) {
  if (!value) return [null, null];
  const decoded = Buffer.from(value, 'base64url');
  const [time, id, extra] = decoded.toString('utf8').split('|');
  if (decoded.toString('base64url') !== value || extra !== undefined || !uuidSchema.safeParse(id).success ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(time) ||
      !localDateSchema.safeParse(time.slice(0, 10)).success || !Number.isFinite(Date.parse(time))) {
    throw invalid('The meal page cursor is invalid.');
  }
  return [time, id];
}

async function loadMeals(db: Pool, userId: string, date: string, fallbackZone: string, cursor?: string) {
  const [time, id] = parseCursor(cursor);
  const { rows } = await db.query<{ meals: MealRow[]; zone: string; state: DayState }>(`
    WITH page AS (
      SELECT ${mealColumns} FROM meals m
      WHERE m.user_id = $1 AND m.recorded_local_date = $2 AND m.deleted_at IS NULL
        AND ($3::timestamptz IS NULL OR (m.occurred_at, m.id) < ($3::timestamptz, $4::uuid))
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT $6
    ), first_meal AS (
      SELECT recorded_time_zone FROM meals WHERE user_id = $1 AND recorded_local_date = $2 AND deleted_at IS NULL
      ORDER BY occurred_at, id LIMIT 1
    )
    SELECT COALESCE(status.recorded_time_zone, first_meal.recorded_time_zone, $5) AS zone,
      CASE WHEN status.state = 'complete' THEN 'complete' WHEN first_meal.recorded_time_zone IS NOT NULL
        THEN 'partial' ELSE 'unrecorded' END AS state,
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY occurred_at DESC, id DESC) FROM page), '[]'::jsonb) AS meals
    FROM (SELECT 1) scope
    LEFT JOIN first_meal ON true
    LEFT JOIN daily_tracking_status status ON status.user_id = $1 AND status.category = 'nutrition'
      AND status.recorded_local_date = $2
  `, [userId, date, time, id, fallbackZone, pageSize + 1]);
  const { meals, zone, state } = rows[0];
  const last = meals[pageSize - 1];
  return {
    date, timeZone: zone, preferredTimeZone: fallbackZone, status: state,
    meals: meals.slice(0, pageSize).map(row => expose({ ...row, occurred_at: new Date(row.occurred_at) })),
    nextCursor: meals.length > pageSize ? Buffer.from(`${last.cursor_time}|${last.id}`).toString('base64url') : null,
  };
}

async function mealTime(db: PoolClient, userId: string, input: Pick<MealWrite, 'occurredAt' | 'timeZone'>, previous?: MealRow) {
  const zone = input.timeZone ?? previous?.recorded_time_zone ?? await preferredZone(db, userId);
  const date = localDateAt(input.occurredAt, zone);
  if (!localDateSchema.safeParse(date).success) throw invalid('The meal date is outside the supported range.');
  return { zone, date };
}

async function addMeal(db: PoolClient, userId: string, input: MealWrite) {
  const id = randomUUID();
  const { date, zone } = await mealTime(db, userId, input);
  const imageId = input.imageId ?? null;
  await checkPhoto(db, userId, imageId);
  await db.query(`
    INSERT INTO meals (id, user_id, meal_type, occurred_at, recorded_time_zone, recorded_local_date, image_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, userId, input.mealType, input.occurredAt, zone, date, imageId]);
  const items = await replaceItems(db, userId, id, input.items, []);
  await recordDay(db, userId, date, zone);
  return { id, revision: 0, ...mealTotals(items) };
}

async function editMeal(db: PoolClient, userId: string, meal: MealRow, input: MealEdit) {
  const revision = nextRevision(meal, input.expectedRevision);
  const { date, zone } = await mealTime(db, userId, input, meal);
  const now = [meal.id, userId, input.mealType, input.occurredAt, zone, date, revision];
  await archive(db, userId, meal);
  if (input.imageId === undefined) {
    await db.query(`
      UPDATE meals SET meal_type = $3, occurred_at = $4, recorded_time_zone = $5, recorded_local_date = $6,
        revision = $7, updated_at = now() WHERE id = $1 AND user_id = $2
    `, now);
  } else {
    await checkPhoto(db, userId, input.imageId);
    await db.query(`
      UPDATE meals SET meal_type = $3, occurred_at = $4, recorded_time_zone = $5, recorded_local_date = $6,
        revision = $7, updated_at = now(), image_id = $8 WHERE id = $1 AND user_id = $2
    `, [...now, input.imageId]);
  }
  const items = await replaceItems(db, userId, meal.id, input.items, meal.items);
  if (meal.local_date !== date) await recordDay(db, userId, meal.local_date, meal.recorded_time_zone);
  await recordDay(db, userId, date, zone);
  return { id: meal.id, revision, ...mealTotals(items) };
}

async function editItem(db: PoolClient, userId: string, meal: MealRow, itemId: string,
  input: MealItemWrite, expectedRevision: number) {
  const revision = nextRevision(meal, expectedRevision);
  const index = meal.items.findIndex(item => item.id === itemId);
  if (index === -1) throw missing('Meal item');
  const replacement = { ...await snapshotItem(db, userId, input), id: itemId };
  await archive(db, userId, meal);
  const { rows: [previous] } = await db.query<{ position: number }>(`
    DELETE FROM meal_items WHERE meal_id = $1 AND id = $2 RETURNING position
  `, [meal.id, itemId]);
  await insertItem(db, meal.id, previous.position, replacement, 'manual' in input);
  const items = meal.items.with(index, replacement);
  await db.query('UPDATE meals SET revision = $1, updated_at = now() WHERE id = $2 AND user_id = $3', [revision, meal.id, userId]);
  await recordDay(db, userId, meal.local_date, meal.recorded_time_zone);
  return { id: meal.id, revision, ...mealTotals(items) };
}

export function createMealsRouter(db: Pool) {
  const router = Router();
  router.get('/meals', route(async (req, res) => {
    const query = mealDayQuerySchema.safeParse(req.query);
    if (!query.success) throw invalid('Choose a valid meal date and page.');
    const userId: string = res.locals.userId;
    const timeZone = await preferredZone(db, userId);
    const date = query.data.date ?? localDateAt(new Date().toISOString(), timeZone);
    res.json({ data: await loadMeals(db, userId, date, timeZone, query.data.cursor) });
  }));

  router.post('/meals', route(async (req, res) => {
    const input = mealWriteSchema.safeParse(req.body);
    if (!input.success) throw invalid('Provide valid meal details, portions and nutrients.');
    const userId: string = res.locals.userId;
    const data = await transaction(db, userId, client =>
      saveOnce(client, userId, 'log_meal', input.data, {}, () => addMeal(client, userId, input.data)));
    res.status(201).json({ data });
  }));

  router.patch('/meals/:id', route(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const input = mealEditSchema.safeParse(req.body);
    if (!id.success || !input.success) throw invalid('Provide a meal ID, revision and valid meal details.');
    const userId: string = res.locals.userId;
    const data = await transaction(db, userId, async client => {
      const meal = await ownedMeal(client, userId, id.data);
      return saveOnce(client, userId, 'edit_meal', input.data, { id: id.data }, () =>
        editMeal(client, userId, meal, input.data));
    });
    res.json({ data });
  }));

  router.put('/meals/:id/items/:itemId', route(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const itemId = uuidSchema.safeParse(req.params.itemId);
    const input = mealItemEditSchema.safeParse(req.body);
    if (!id.success || !itemId.success || !input.success) throw invalid('Provide a meal ID, item ID, revision and valid portion.');
    const userId: string = res.locals.userId;
    const data = await transaction(db, userId, async client => {
      const meal = await ownedMeal(client, userId, id.data);
      return saveOnce(client, userId, 'edit_meal_item', input.data, { id: id.data, itemId: itemId.data }, () =>
        editItem(client, userId, meal, itemId.data, input.data.item, input.data.expectedRevision));
    });
    res.json({ data });
  }));

  router.delete('/meals/:id', route(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const input = mealDeleteSchema.safeParse(req.body);
    if (!id.success || !input.success) throw invalid('Provide a meal ID and revision.');
    const userId: string = res.locals.userId;
    const data = await transaction(db, userId, async client => {
      const meal = await ownedMeal(client, userId, id.data);
      return saveOnce(client, userId, 'delete_meal', input.data, { id: id.data }, async () => {
        const revision = nextRevision(meal, input.data.expectedRevision);
        await archive(client, userId, meal);
        await client.query(`
          UPDATE meals SET deleted_at = now(), updated_at = now(), revision = $3
          WHERE id = $1 AND user_id = $2
        `, [meal.id, userId, revision]);
        await recordDay(client, userId, meal.local_date, meal.recorded_time_zone);
        return { id: meal.id, revision, deleted: true };
      });
    });
    res.json({ data });
  }));

  router.put('/tracking-days/:date/nutrition', route(async (req, res) => {
    const date = localDateSchema.safeParse(req.params.date);
    const input = dayStatusRequestSchema.safeParse(req.body);
    if (!date.success || !input.success) throw invalid('Choose a valid date and tracking state.');
    const userId: string = res.locals.userId;
    const data = await transaction(db, userId, async client =>
      recordDay(client, userId, date.data, await preferredZone(client, userId), input.data.state === 'complete'));
    res.json({ data });
  }));

  return router;
}
