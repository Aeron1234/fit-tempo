import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { exerciseWriteSchema, manualFoodSchema, revisionSchema, uuidSchema } from '@fit-tempo/contracts';
import { lockSchedule } from './schedule.js';

const visibility = z.enum(['draft', 'approved', 'retired']);
const sharedFields = { categoryId: uuidSchema.nullable(), visibility };
const food = manualFoodSchema.extend(sharedFields);
const exercise = exerciseWriteSchema.extend(sharedFields);
const category = z.strictObject({ kind: z.enum(['food', 'exercise']), name: z.string().trim().min(1).max(120) });
const account = z.strictObject({ active: z.boolean() });
const page = z.strictObject({
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  offset: z.string().regex(/^\d{1,5}$/).transform(Number).optional(),
});
const categoryQuery = z.strictObject({ kind: category.shape.kind });
const userColumns = 'id,email,active,role_code AS role';
const foodColumns = `f.id,f.name,f.category_id AS "categoryId",f.visibility,f.revision::float8,
  CASE WHEN f.preparation='unspecified' THEN 'unknown' ELSE f.preparation END AS preparation,
  jsonb_build_object('kind',CASE WHEN f.basis='per100g' THEN 'per_100g' ELSE 'per_serving' END,
    'grams',trim_scale(f.basis_grams)::text) AS basis,
  jsonb_build_object('energyKcal',NULL,'proteinG',NULL,'carbsG',NULL,'fatG',NULL,'fiberG',NULL,'sodiumMg',NULL)
  || COALESCE((SELECT jsonb_object_agg(n.nutrient_code,trim_scale(n.amount)::text)
    FROM food_nutrients n WHERE n.food_id=f.id),'{}'::jsonb) AS nutrients`;
const exerciseColumns = 'id,name,visibility,revision::float8,category_id AS "categoryId",measurement_type AS "measurementType",equipment,instructions';
const foodScope = "f.owner_id IS NULL AND f.source_kind='curated'";
const categoryTables = { food: 'food_categories', exercise: 'exercise_categories' } as const;
type CategoryKind = keyof typeof categoryTables;

class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly revision?: number) {
    super(message);
  }
}

const unavailable = () => new AdminError(404, 'NOT_FOUND', 'Administrative record unavailable.');
const conflict = (revision?: number) => new AdminError(409, 'CONFLICT', 'The record changed or is in use.', revision);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AdminError(400, 'VALIDATION_ERROR', 'Review the administrative fields.');
  return result.data;
}

function route(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try { await handler(req, res, next); }
    catch (cause) {
      const pgCode = (cause as { code?: string } | null)?.code;
      const error = cause instanceof AdminError ? cause
        : pgCode === '23503' || pgCode === '23505' ? conflict() : undefined;
      if (!error) return next(cause);
      res.status(error.status).json({ error: {
        code: error.code, message: error.message, requestId: res.locals.requestId,
        ...(error.revision === undefined ? {} : { currentRevision: error.revision }),
      } });
    }
  };
}

async function transaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const data = await work(client);
    await client.query('COMMIT');
    return data;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function recordAudit(client: PoolClient, actor: string, action: string, type: string, target: string) {
  await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id)
    VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), actor, action, type, target]);
}

function checkRevision(row: { revision: number } | undefined, requested: number) {
  if (!row) throw unavailable();
  if (row.revision !== requested || !revisionSchema.safeParse(requested + 1).success) throw conflict(row.revision);
}

async function verifyCategory(client: PoolClient, kind: CategoryKind, id: string | null) {
  if (id === null) return;
  const result = await client.query(`SELECT id FROM ${categoryTables[kind]} WHERE id=$1 FOR KEY SHARE`, [id]);
  if (!result.rowCount) throw new AdminError(400, 'VALIDATION_ERROR', 'Choose a category of the correct kind.');
}

async function writeNutrients(client: PoolClient, id: string, nutrients: z.infer<typeof food>['nutrients']) {
  await client.query(`
    INSERT INTO food_nutrients(food_id,nutrient_code,amount,unit)
    SELECT $1,n.key,n.value::numeric,CASE n.key WHEN 'energyKcal' THEN 'kcal' WHEN 'sodiumMg' THEN 'mg' ELSE 'g' END
    FROM jsonb_each_text($2::jsonb) n
    ON CONFLICT (food_id,nutrient_code) DO UPDATE SET amount=EXCLUDED.amount
  `, [id, JSON.stringify(nutrients)]);
}

export function createAdminRouter(db: Pool) {
  const router = Router();

  const lists = {
    users: `SELECT ${userColumns} FROM users ORDER BY email,id`,
    foods: `SELECT ${foodColumns} FROM foods f WHERE ${foodScope} ORDER BY name,id`,
    exercises: `SELECT ${exerciseColumns} FROM exercises WHERE owner_id IS NULL ORDER BY name,id`,
    categories: `SELECT id,name,kind FROM (
      SELECT id,name,'food' AS kind FROM food_categories
      UNION ALL SELECT id,name,'exercise' AS kind FROM exercise_categories
    ) c ORDER BY kind,name,id`,
    audit: `SELECT id,action,target_type AS "targetType",target_id AS "targetId",occurred_at AS "occurredAt"
      FROM audit_logs ORDER BY occurred_at DESC,id DESC`,
  };
  for (const [path, sql] of Object.entries(lists)) {
    router.get('/' + path, route(async (req, res) => {
      const { limit = 100, offset = 0 } = parse(page, req.query);
      const { rows } = await db.query(sql + ' LIMIT $1 OFFSET $2', [limit, offset]);
      res.json({ data: rows });
    }));
  }
  router.get('/statistics', route(async (_req, res) => {
    const { rows: [data] } = await db.query(`SELECT count(*)::int AS users,
      count(*) FILTER (WHERE active)::int AS "activeUsers",
      (SELECT count(*)::int FROM foods WHERE owner_id IS NULL) AS foods,
      (SELECT count(*)::int FROM exercises WHERE owner_id IS NULL) AS exercises FROM users`);
    res.json({ data });
  }));

  router.patch('/users/:id', route(async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    const { active } = parse(account, req.body);
    const { userId: actor } = res.locals;
    const data = await transaction(db, async client => {
      const eligible = await client.query("SELECT id FROM users WHERE id=$1 AND role_code='trainee'", [id]);
      if (!eligible.rowCount) throw unavailable();
      await lockSchedule(client, id);
      const { rows: [current] } = await client.query(`SELECT ${userColumns} FROM users
        WHERE id=$1 AND role_code='trainee' FOR UPDATE`, [id]);
      if (!current) throw unavailable();
      if (current.active === active) return current;
      const { rows: [updated] } = await client.query(`UPDATE users SET active=$2,updated_at=now()
        WHERE id=$1 RETURNING ${userColumns}`, [id, active]);
      if (!active) {
        await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
        await client.query(`UPDATE notification_jobs SET status='cancelled',updated_at=now(),retry_at=NULL,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
          WHERE user_id=$1 AND status IN ('pending','leased','failed')`, [id]);
      }
      await recordAudit(client, actor, active ? 'account.reactivate' : 'account.suspend', 'user', id);
      return updated;
    });
    res.json({ data });
  }));

  function writeFood(edit: boolean): RequestHandler {
    return route(async (req, res) => {
      const id = edit ? parse(uuidSchema, req.params.id) : randomUUID();
      const input = parse(edit ? food.extend({ revision: revisionSchema }) : food, req.body);
      const fields = [id, input.name, input.categoryId, input.visibility,
        input.preparation === 'unknown' ? 'unspecified' : input.preparation,
        input.basis.kind === 'per_100g' ? 'per100g' : 'perServing', input.basis.grams];
      const data = await transaction(db, async client => {
        await verifyCategory(client, 'food', input.categoryId);
        if ('revision' in input) {
          const { rows: [current] } = await client.query(`SELECT f.revision::float8 FROM foods f
            WHERE f.id=$1 AND ${foodScope} FOR UPDATE`, [id]);
          checkRevision(current, input.revision as number);
          await client.query(`UPDATE foods SET name=$2,category_id=$3,visibility=$4,preparation=$5,basis=$6,
            basis_grams=$7,revision=revision+1,source_revision=source_revision+1,updated_at=now() WHERE id=$1`, fields);
        } else {
          await client.query(`INSERT INTO foods(id,name,category_id,visibility,preparation,basis,basis_grams,source_kind,source_record_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'curated',$1::uuid::text)`, fields);
        }
        await writeNutrients(client, id, input.nutrients);
        await recordAudit(client, res.locals.userId, edit ? 'food.update' : 'food.create', 'food', id);
        const { rows: [row] } = await client.query(`SELECT ${foodColumns} FROM foods f WHERE f.id=$1`, [id]);
        return row;
      });
      res.status(edit ? 200 : 201).json({ data });
    });
  }
  router.post('/foods', writeFood(false));
  router.patch('/foods/:id', writeFood(true));

  function writeExercise(edit: boolean): RequestHandler {
    return route(async (req, res) => {
      const id = edit ? parse(uuidSchema, req.params.id) : randomUUID();
      const input = parse(edit ? exercise.extend({ revision: revisionSchema }) : exercise, req.body);
      const fields = [id, input.name, input.categoryId, input.visibility, input.measurementType, input.equipment, input.instructions];
      const data = await transaction(db, async client => {
        await verifyCategory(client, 'exercise', input.categoryId);
        if ('revision' in input) {
          const { rows: [current] } = await client.query(`
            SELECT revision::float8,measurement_type FROM exercises WHERE id=$1 AND owner_id IS NULL FOR UPDATE`, [id]);
          checkRevision(current, input.revision as number);
          if (input.measurementType !== current.measurement_type) {
            const used = await client.query('SELECT 1 FROM routine_exercises WHERE exercise_id=$1 LIMIT 1', [id]);
            if (used.rowCount) throw conflict(current.revision);
          }
          await client.query(`UPDATE exercises SET name=$2,category_id=$3,visibility=$4,measurement_type=$5,
            equipment=$6,instructions=$7,revision=revision+1,updated_at=now() WHERE id=$1`, fields);
        } else {
          await client.query(`INSERT INTO exercises(id,name,category_id,visibility,measurement_type,equipment,instructions)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, fields);
        }
        await recordAudit(client, res.locals.userId, edit ? 'exercise.update' : 'exercise.create', 'exercise', id);
        const { rows: [row] } = await client.query(`SELECT ${exerciseColumns} FROM exercises WHERE id=$1`, [id]);
        return row;
      });
      res.status(edit ? 200 : 201).json({ data });
    });
  }
  router.post('/exercises', writeExercise(false));
  router.patch('/exercises/:id', writeExercise(true));

  function writeCategory(edit: boolean): RequestHandler {
    return route(async (req, res) => {
      const id = edit ? parse(uuidSchema, req.params.id) : randomUUID();
      const { kind, name } = parse(category, req.body);
      const table = categoryTables[kind];
      const data = await transaction(db, async client => {
        const { rows: [row] } = await client.query(edit
          ? `UPDATE ${table} SET name=$2,updated_at=now() WHERE id=$1 RETURNING id,name`
          : `INSERT INTO ${table}(id,name) VALUES ($1,$2) RETURNING id,name`, [id, name]);
        if (!row) throw unavailable();
        await recordAudit(client, res.locals.userId, edit ? 'category.update' : 'category.create', kind + '_category', id);
        return { ...row, kind };
      });
      res.status(edit ? 200 : 201).json({ data });
    });
  }
  router.post('/categories', writeCategory(false));
  router.patch('/categories/:id', writeCategory(true));
  router.delete('/categories/:id', route(async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    const { kind } = parse(categoryQuery, req.query);
    await transaction(db, async client => {
      const result = await client.query(`DELETE FROM ${categoryTables[kind]} WHERE id=$1`, [id]);
      if (!result.rowCount) throw unavailable();
      await recordAudit(client, res.locals.userId, 'category.delete', kind + '_category', id);
    });
    res.sendStatus(204);
  }));
  return router;
}
