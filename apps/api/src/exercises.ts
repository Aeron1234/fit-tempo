import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  exerciseWriteSchema, exerciseEditSchema, routineWriteSchema, routineEditSchema,
  routineArchiveSchema, routineTargetSchema, revisionSchema, uuidSchema,
} from '@fit-tempo/contracts';

class CatalogError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly currentRevision?: number) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CatalogError(400, 'VALIDATION_ERROR', 'Review the exercise or routine fields.');
  return result.data;
}

const hidden = () => new CatalogError(404, 'NOT_FOUND', 'This exercise or routine is unavailable.');
const route = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    if (!(error instanceof CatalogError)) return next(error);
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

function advance(current: number, expected: number) {
  if (current !== expected || !revisionSchema.safeParse(current + 1).success) {
    throw new CatalogError(409, 'REVISION_CONFLICT', 'This record changed. Reload before editing.', current);
  }
  return current + 1;
}

function validateTarget(type: string, target: z.infer<typeof routineTargetSchema>) {
  const { targetReps: reps, targetLoadKg: load, targetSeconds: seconds, targetMeters: meters } = target;
  const valid = type === 'externalLoad' ? reps !== null && load !== null && seconds === null && meters === null
    : type === 'bodyweight' ? reps !== null && load === null && seconds === null && meters === null
    : type === 'timed' ? seconds !== null && reps === null && load === null && meters === null
    : type === 'distance' && meters !== null && reps === null && load === null;
  if (!valid) throw new CatalogError(400, 'VALIDATION_ERROR', 'Targets must match the exercise measurement type.');
}

const orderedTargets = `SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'exerciseId', e.id, 'exerciseName', e.name, 'equipment', e.equipment, 'measurementType', e.measurement_type,
  'targetSets', t.target_sets, 'targetReps', t.target_reps, 'targetLoadKg', trim_scale(t.target_load_kg)::text,
  'targetSeconds', trim_scale(t.target_seconds)::text, 'targetMeters', trim_scale(t.target_meters)::text,
  'restSeconds', t.rest_seconds
  ) ORDER BY t.exercise_order), '[]'::jsonb)
  FROM routine_exercises t JOIN exercises e ON e.id=t.exercise_id
  WHERE ((e.owner_id=$1 AND e.visibility='private') OR (e.owner_id IS NULL AND e.visibility='approved'))`;

// Hide the whole routine if a linked exercise is unavailable, rather than
// silently presenting a partial sequence as an approved or editable routine.
const allTargetsVisible = (alias: 'r' | 'v') => `NOT EXISTS (
  SELECT 1 FROM routine_exercises t JOIN exercises e ON e.id=t.exercise_id
  WHERE t.routine_id=${alias}.id
    AND NOT COALESCE((e.owner_id=$1 AND e.visibility='private') OR
      (e.owner_id IS NULL AND e.visibility='approved'), false)
)`;

async function saveRoutine(db: Pool, user: string, routineId: string | null,
  input: z.infer<typeof routineWriteSchema>, expectedRevision?: number) {
  return transaction(db, async client => {
    let revision = 0;
    const id = routineId ?? randomUUID();
    if (routineId) {
      const { rows: [routine] } = await client.query(
        'SELECT revision FROM workout_routines WHERE id=$1 AND user_id=$2 AND archived_at IS NULL FOR UPDATE',
        [id, user],
      );
      if (!routine) throw hidden();
      revision = advance(Number(routine.revision), expectedRevision!);
    }
    const { rows: exercises } = await client.query<{ id: string; measurement_type: string }>(`
      SELECT id, measurement_type FROM exercises
      WHERE id=ANY($2::uuid[]) AND ((owner_id=$1 AND visibility='private') OR (owner_id IS NULL AND visibility='approved'))
      ORDER BY id FOR SHARE
    `, [user, input.exercises.map(target => target.exerciseId)]);
    const types = new Map(exercises.map(row => [row.id, row.measurement_type]));
    for (const target of input.exercises) {
      const type = types.get(target.exerciseId.toLowerCase());
      if (!type) throw hidden();
      validateTarget(type, target);
    }
    if (routineId) {
      await client.query(`
        UPDATE workout_routines SET name=$3, duration_minutes=$4, level=$5, revision=$6, updated_at=now()
        WHERE id=$1 AND user_id=$2
      `, [id, user, input.name, input.durationMinutes, input.level, revision]);
      await client.query('DELETE FROM routine_exercises WHERE routine_id=$1', [id]);
    } else {
      await client.query(`
        INSERT INTO workout_routines(id,user_id,visibility,name,duration_minutes,level) VALUES($1,$2,'private',$3,$4,$5)
      `, [id, user, input.name, input.durationMinutes, input.level]);
    }
    for (const [index, target] of input.exercises.entries()) {
      await client.query(`INSERT INTO routine_exercises
        (id,routine_id,exercise_id,exercise_order,target_sets,target_reps,target_load_kg,target_seconds,target_meters,rest_seconds)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [randomUUID(), id, target.exerciseId, index + 1, target.targetSets, target.targetReps,
        target.targetLoadKg, target.targetSeconds, target.targetMeters, target.restSeconds]);
    }
    return { id, revision };
  });
}

export function createExercisesRouter(db: Pool) {
  const router = Router();
  router.get('/exercises', route(async (_req, res) => {
    const { rows } = await db.query(`
      SELECT id,name,equipment,instructions,measurement_type AS "measurementType",revision::float8,
             COALESCE(owner_id=$1,false) AS editable
      FROM exercises WHERE (owner_id=$1 AND visibility='private') OR (owner_id IS NULL AND visibility='approved')
      ORDER BY name,id LIMIT 100
    `, [res.locals.userId]);
    res.json({ data: rows });
  }));
  router.post('/exercises', route(async (req, res) => {
    const input = parse(exerciseWriteSchema, req.body);
    const id = randomUUID();
    await db.query(`
      INSERT INTO exercises(id,owner_id,visibility,name,equipment,instructions,measurement_type)
      VALUES($1,$2,'private',$3,$4,$5,$6)
    `, [id, res.locals.userId, input.name, input.equipment, input.instructions, input.measurementType]);
    res.status(201).json({ data: { id, revision: 0 } });
  }));
  router.patch('/exercises/:id', route(async (req, res) => {
    const id = parse(uuidSchema, req.params.id), input = parse(exerciseEditSchema, req.body);
    const owner = res.locals.userId;
    const data = await transaction(db, async client => {
      const { rows: [current] } = await client.query(
        'SELECT revision,measurement_type FROM exercises WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner],
      );
      if (!current) throw hidden();
      const revision = advance(Number(current.revision), input.expectedRevision);
      if (current.measurement_type !== input.measurementType) {
        const references = await client.query('SELECT 1 FROM routine_exercises WHERE exercise_id=$1 LIMIT 1', [id]);
        if (references.rowCount) throw new CatalogError(409, 'REVISION_CONFLICT', 'Exercises with routine targets must retain their measurement type.', Number(current.revision));
      }
      await client.query(`
        UPDATE exercises SET name=$3,equipment=$4,instructions=$5,measurement_type=$6,revision=$7,updated_at=now()
        WHERE id=$1 AND owner_id=$2
      `, [id, owner, input.name, input.equipment, input.instructions, input.measurementType, revision]);
      return { id, revision };
    });
    res.json({ data });
  }));
  router.get('/routines', route(async (_req, res) => {
    const { rows } = await db.query(`
      SELECT r.id,r.name,r.duration_minutes AS "durationMinutes",r.level,r.revision::float8,
        COALESCE(r.user_id=$1,false) AS editable,
        (${orderedTargets} AND t.routine_id=r.id) AS exercises,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id',v.id,'revision',v.revision,'name',v.name,'durationMinutes',v.duration_minutes,
          'exercises',(${orderedTargets} AND t.routine_id=v.id)
        ) ORDER BY v.duration_minutes,v.id)
        FROM reviewed_routine_variants link JOIN workout_routines v ON v.id=link.variant_id
        WHERE link.routine_id=r.id AND r.user_id IS NULL AND r.visibility='approved'
          AND v.user_id IS NULL AND v.visibility='approved' AND v.archived_at IS NULL
          AND v.duration_minutes<r.duration_minutes AND link.routine_revision=r.revision AND link.variant_revision=v.revision
          AND ${allTargetsVisible('v')}
        ), '[]'::jsonb) AS "shorterVariants"
      FROM workout_routines r
      WHERE r.archived_at IS NULL AND r.duration_minutes IS NOT NULL AND ${allTargetsVisible('r')}
        AND ((r.user_id=$1 AND r.visibility='private') OR (r.user_id IS NULL AND r.visibility='approved'))
      ORDER BY r.name,r.id LIMIT 100
    `, [res.locals.userId]);
    res.json({ data: rows });
  }));
  router.post('/routines', route(async (req, res) => {
    const input = parse(routineWriteSchema, req.body);
    res.status(201).json({ data: await saveRoutine(db, res.locals.userId, null, input) });
  }));
  router.patch('/routines/:id', route(async (req, res) => {
    const input = parse(routineEditSchema, req.body);
    const id = parse(uuidSchema, req.params.id);
    res.json({ data: await saveRoutine(db, res.locals.userId, id, input, input.expectedRevision) });
  }));
  router.delete('/routines/:id', route(async (req, res) => {
    const { expectedRevision } = parse(routineArchiveSchema, req.body);
    const id = parse(uuidSchema, req.params.id), user = res.locals.userId;
    const data = await transaction(db, async client => {
      const { rows: [routine] } = await client.query(
        'SELECT revision FROM workout_routines WHERE id=$1 AND user_id=$2 AND archived_at IS NULL FOR UPDATE', [id, user],
      );
      if (!routine) throw hidden();
      const revision = advance(Number(routine.revision), expectedRevision);
      await client.query('UPDATE workout_routines SET archived_at=now(), updated_at=now(), revision=$3 WHERE id=$1 AND user_id=$2',
        [id, user, revision]);
      return { id, revision };
    });
    res.json({ data });
  }));
  return router;
}
