import { createHash, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { lockSchedule, syncScheduleReminder } from './schedule.js';
import type { z } from 'zod';
import {
  revisionSchema, uuidSchema, workoutCompleteSchema, workoutPatchSchema,
  workoutSnapshotSchema, workoutStartSchema, type WorkoutPatch, type WorkoutSession, type WorkoutSnapshot,
} from '@fit-tempo/contracts';

type Measurement = WorkoutSnapshot['exercises'][number]['targets'][number]['measurement'];
type SessionRow = {
  id: string; status: 'active' | 'paused' | 'completed' | 'cancelled'; revision: string;
  started_at: Date; ended_at: Date | null; actual_duration_seconds: number | null;
  elapsed_milliseconds: string; active_since: Date | null; rest_ends_at: Date | null;
  rest_remaining_milliseconds: string; routine_snapshot: unknown;
};
type SetRow = {
  exercise_index: number | null; set_order: number; measurement_type: string; actual_reps: number;
  actual_load_kg: string; actual_seconds: string | null; actual_meters: string;
};

class WorkoutError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly currentRevision?: number) {
    super(message);
  }
}

const missing = () => new WorkoutError(404, 'NOT_FOUND', 'Workout or routine is unavailable.');
const invalid = (message: string) => new WorkoutError(400, 'VALIDATION_ERROR', message);
const conflict = (message: string, revision?: number) => new WorkoutError(409, 'REVISION_CONFLICT', message, revision);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid('Review the workout fields and units.');
  return result.data;
}

const route = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try { await handler(req, res, next); }
  catch (error) {
    if (!(error instanceof WorkoutError)) return next(error);
    res.status(error.status).json({ error: {
      code: error.code, message: error.message, requestId: res.locals.requestId,
      ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
    } });
  }
};

async function transaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

const dbType = (kind: Measurement['type']) => kind === 'external_load' ? 'externalLoad' : kind;
function measurement(kind: string, reps: number | null, load: string | null, seconds: string | null, meters: string | null): Measurement {
  switch (kind) {
    case 'externalLoad': return { type: 'external_load', reps: reps!, loadKg: load! };
    case 'bodyweight': return { type: 'bodyweight', reps: reps! };
    case 'timed': return { type: 'timed', durationSeconds: seconds! };
    case 'distance': return { type: 'distance', distanceMeters: meters!, durationSeconds: seconds };
    default: throw invalid('Unknown exercise measurement type.');
  }
}

function loadMicros(load: string) {
  const [whole, fraction = ''] = load.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
function formatMicros(value: bigint) {
  const fraction = String(value % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return String(value / 1_000_000n) + (fraction ? '.' + fraction : '');
}
function volume(snapshot: WorkoutSnapshot) {
  const totals = new Map<string, { exerciseId: string; name: string; micros: bigint }>();
  for (const exercise of snapshot.exercises) {
    for (const { measurement: actual } of exercise.actualSets) {
      if (actual.type !== 'external_load') continue;
      const prior = totals.get(exercise.exerciseId);
      const micros = (prior?.micros ?? 0n) + BigInt(actual.reps) * loadMicros(actual.loadKg);
      totals.set(exercise.exerciseId, { exerciseId: exercise.exerciseId, name: exercise.name, micros });
    }
  }
  return [...totals.values()].map(({ micros, ...item }) => ({ ...item, kgReps: formatMicros(micros) }));
}

async function readRow(client: PoolClient, owner: string, id: string, lock = false) {
  const { rows: [row] } = await client.query<SessionRow>(
    'SELECT * FROM workout_sessions WHERE user_id=$1 AND id=$2' + (lock ? ' FOR UPDATE' : ''), [owner, id],
  );
  if (!row) throw missing();
  return row;
}

async function view(client: PoolClient, row: SessionRow): Promise<WorkoutSession> {
  let snapshot = workoutSnapshotSchema.parse(row.routine_snapshot);
  if (row.status !== 'completed' && row.status !== 'cancelled') {
    const { rows } = await client.query<SetRow>(`
      SELECT exercise_index,set_order,measurement_type,actual_reps, trim_scale(actual_load_kg)::text AS actual_load_kg,
        trim_scale(actual_seconds)::text AS actual_seconds, trim_scale(actual_meters)::text AS actual_meters
      FROM workout_sets WHERE session_id=$1 AND exercise_index IS NOT NULL ORDER BY exercise_index,set_order
    `, [row.id]);
    snapshot = workoutSnapshotSchema.parse({
      ...snapshot, exercises: snapshot.exercises.map((exercise, i) => ({
        ...exercise, actualSets: rows.filter(set => set.exercise_index === i).map(set => ({
          setOrder: set.set_order,
          measurement: measurement(set.measurement_type, set.actual_reps, set.actual_load_kg, set.actual_seconds, set.actual_meters),
        })),
      })),
    });
  }
  return {
    id: row.id, revision: Number(row.revision),
    status: row.status === 'active' ? 'inProgress' : row.status === 'cancelled' ? 'abandoned' : row.status,
    startedAt: row.started_at.toISOString(), endedAt: row.ended_at?.toISOString() ?? null,
    elapsedSeconds: row.actual_duration_seconds ?? Math.floor(Number(row.elapsed_milliseconds) / 1000),
    activeSince: row.status === 'active' ? (row.active_since ?? row.started_at).toISOString() : null,
    restRemainingSeconds: Math.ceil(Number(row.rest_remaining_milliseconds) / 1000),
    restEndsAt: row.rest_ends_at?.toISOString() ?? null,
    snapshot, volume: volume(snapshot),
  };
}

function nextRevision(row: SessionRow, expected: number) {
  const revision = Number(row.revision);
  if (expected !== revision || !revisionSchema.safeParse(revision + 1).success) {
    throw conflict('Workout changed. Reload before trying again.', revision);
  }
  if (row.status !== 'active' && row.status !== 'paused') throw conflict('Workout is already closed.', revision);
  return revision + 1;
}

async function start(client: PoolClient, owner: string, input: z.infer<typeof workoutStartSchema>) {
  const routineId = input.routineId.toLowerCase();
  const variantId = input.variantId?.toLowerCase();
  const scheduledId = input.scheduledWorkoutId?.toLowerCase();
  if (scheduledId) {
    await lockSchedule(client, owner);
    const { rows: [occurrence] } = await client.query<{ routine_id: string; variant_id: string | null }>(`
      SELECT routine_id,variant_id FROM scheduled_workouts
      WHERE user_id=$1 AND id=$2 AND status='planned' AND ends_at>now()
    `, [owner, scheduledId]);
    if (!occurrence || occurrence.routine_id !== routineId || occurrence.variant_id !== (variantId ?? null)) throw missing();
    const existing = await client.query('SELECT 1 FROM workout_sessions WHERE user_id=$1 AND scheduled_workout_id=$2 AND status IN (\'active\',\'paused\',\'completed\')', [owner, scheduledId]);
    if (existing.rowCount) throw conflict('This scheduled workout already has a session.');
  }
  const { rows: routines } = await client.query<{
    id: string; revision: string; duration_minutes: number | null; name: string; user_id: string | null;
  }>(`
    SELECT id,revision,duration_minutes,name,user_id FROM workout_routines
    WHERE id=ANY($2::uuid[]) AND archived_at IS NULL AND ((user_id=$1 AND visibility='private')
      OR (user_id IS NULL AND visibility='approved')) ORDER BY id FOR SHARE
  `, [owner, variantId ? [routineId, variantId] : [routineId]]);
  const routine = routines.find(item => item.id === routineId);
  if (!routine) throw missing();
  const revision = Number(routine.revision);
  if (revision !== input.expectedRoutineRevision) throw conflict('Routine changed. Reload before starting.', revision);
  const chosen = variantId ? routines.find(item => item.id === variantId) : routine;
  if (!chosen) throw missing();
  if (variantId) {
    const review = await client.query(`
      SELECT 1 FROM reviewed_routine_variants WHERE routine_id=$1 AND variant_id=$2
        AND routine_revision=$3 AND variant_revision=$4 FOR SHARE
    `, [routineId, variantId, revision, chosen.revision]);
    if (!review.rowCount || routine.user_id || chosen.user_id || !chosen.duration_minutes
      || !routine.duration_minutes || chosen.duration_minutes >= routine.duration_minutes) throw missing();
  }
  const { rows } = await client.query<{
    exercise_id: string; owner_id: string | null; visibility: string; revision: string;
    name: string; measurement_type: string; target_sets: number | null; target_reps: number | null;
    target_load_kg: string | null; target_seconds: string | null; target_meters: string | null;
    rest_seconds: number | null;
  }>(`
    SELECT t.*, e.owner_id,e.visibility,e.name,e.revision,e.measurement_type,
      trim_scale(t.target_load_kg)::text AS target_load_kg,trim_scale(t.target_seconds)::text AS target_seconds,
      trim_scale(t.target_meters)::text AS target_meters
    FROM routine_exercises t JOIN exercises e ON e.id=t.exercise_id
    WHERE t.routine_id=$1 ORDER BY t.exercise_order FOR SHARE OF e
  `, [chosen.id]);
  if (!rows.length || rows.some(row => !((row.owner_id === owner && row.visibility === 'private') ||
    (!row.owner_id && row.visibility === 'approved')))) throw missing();
  const now = new Date();
  const snapshot = parse(workoutSnapshotSchema, {
    snapshotVersion: 1, routineId, routineRevision: revision, variantId: variantId ?? null,
    name: chosen.name, capturedAt: now.toISOString(),
    exercises: rows.map(row => ({
      exerciseId: row.exercise_id, exerciseRevision: Number(row.revision), name: row.name,
      restSeconds: String(row.rest_seconds ?? 0), actualSets: [],
      targets: Array.from({ length: row.target_sets ?? 0 }, (_, i) => ({
        setOrder: i + 1,
        measurement: measurement(row.measurement_type, row.target_reps, row.target_load_kg, row.target_seconds, row.target_meters),
      })),
    })),
  });
  await checkSize(client, snapshot);
  const id = randomUUID();
  const { rows: [created] } = await client.query<SessionRow>(`
    WITH preference AS (
      SELECT COALESCE((SELECT time_zone FROM user_preferences WHERE user_id=$2),'Asia/Manila') AS zone
    )
    INSERT INTO workout_sessions (id,user_id,routine_snapshot,started_at,active_since,scheduled_workout_id,
      recorded_time_zone,recorded_local_date,status)
    SELECT $1,$2,$3,$4,$4,$5,zone,($4::timestamptz AT TIME ZONE zone)::date,'active'
    FROM preference RETURNING *
  `, [id, owner, JSON.stringify(snapshot), now, scheduledId ?? null]);
  return view(client, created!);
}

async function checkSize(client: PoolClient, snapshot: WorkoutSnapshot) {
  const { rows: [result] } = await client.query<{ valid: boolean }>(
    'SELECT octet_length(($1::jsonb)::text) <= 131072 AS valid', [JSON.stringify(snapshot)],
  );
  if (!result?.valid) throw invalid('Workout is too large. Reduce the number of sets.');
}

function elapsed(row: SessionRow, now: Date) {
  const active = row.status === 'active' ? Math.max(0, now.getTime() - (row.active_since ?? row.started_at).getTime()) : 0;
  return Math.min(2_147_483_647_000, Number(row.elapsed_milliseconds) + active);
}
function remaining(row: SessionRow, now: Date) {
  return row.rest_ends_at ? Math.max(0, row.rest_ends_at.getTime() - now.getTime()) : Number(row.rest_remaining_milliseconds);
}

async function updateSet(client: PoolClient, row: SessionRow, change: Extract<WorkoutPatch, { action: 'saveSet' | 'removeSet' }>) {
  const snapshot = workoutSnapshotSchema.parse(row.routine_snapshot);
  const exercise = snapshot.exercises[change.exerciseIndex];
  if (!exercise) throw invalid('Select an exercise from this workout.');
  if (change.action === 'removeSet') {
    await client.query('DELETE FROM workout_sets WHERE session_id=$1 AND exercise_index=$2 AND set_order=$3',
      [row.id, change.exerciseIndex, change.setOrder]);
    return;
  }
  const actual = change.set.measurement;
  if (actual.type !== exercise.targets[0]?.measurement.type) throw invalid('The set must use the exercise measurement type.');
  await client.query(`
    INSERT INTO workout_sets (id,session_id,exercise_id,exercise_index,set_order,measurement_type,
      actual_reps,actual_load_kg,actual_seconds,actual_meters)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (session_id,exercise_index,set_order) DO UPDATE SET
      actual_reps=EXCLUDED.actual_reps,actual_load_kg=EXCLUDED.actual_load_kg,
      actual_seconds=EXCLUDED.actual_seconds,actual_meters=EXCLUDED.actual_meters
  `, [
    randomUUID(), row.id, exercise.exerciseId, change.exerciseIndex, change.set.setOrder, dbType(actual.type),
    'reps' in actual ? actual.reps : null, 'loadKg' in actual ? actual.loadKg : null,
    'durationSeconds' in actual ? actual.durationSeconds : null, 'distanceMeters' in actual ? actual.distanceMeters : null,
  ]);
  await checkSize(client, (await view(client, row)).snapshot);
}

async function patch(client: PoolClient, owner: string, id: string, change: WorkoutPatch) {
  const row = await readRow(client, owner, id, true);
  const revision = nextRevision(row, change.expectedRevision);
  const now = new Date();
  let status = row.status;
  let accumulated = Number(row.elapsed_milliseconds);
  let activeSince = row.active_since;
  let restRemaining = Number(row.rest_remaining_milliseconds);
  let restEnds = row.rest_ends_at;
  switch (change.action) {
    case 'pause':
      if (status !== 'active') throw conflict('Workout is already paused.', Number(row.revision));
      status = 'paused';
      accumulated = elapsed(row, now);
      activeSince = null;
      restRemaining = remaining(row, now);
      restEnds = null;
      break;
    case 'resume':
      if (status !== 'paused') throw conflict('Workout is already running.', Number(row.revision));
      status = 'active';
      activeSince = now;
      restEnds = restRemaining ? new Date(now.getTime() + restRemaining) : null;
      restRemaining = 0;
      break;
    case 'startRest':
      if (status === 'paused') {
        restRemaining = change.seconds * 1000;
        restEnds = null;
      } else {
        restEnds = new Date(now.getTime() + change.seconds * 1000);
        restRemaining = 0;
      }
      break;
    case 'clearRest':
      restRemaining = 0;
      restEnds = null;
      break;
    case 'saveSet':
    case 'removeSet':
      await updateSet(client, row, change);
      break;
  }
  const { rows: [updated] } = await client.query<SessionRow>(`
    UPDATE workout_sessions SET status=$2,revision=$3,elapsed_milliseconds=$4,active_since=$5,
      rest_remaining_milliseconds=$6,rest_ends_at=$7,updated_at=$8 WHERE id=$1 RETURNING *
  `, [id, status, revision, accumulated, activeSince, restRemaining, restEnds, now]);
  return view(client, updated!);
}

async function complete(client: PoolClient, owner: string, id: string, input: z.infer<typeof workoutCompleteSchema>) {
  const { rows: [link] } = await client.query<{ scheduled_workout_id: string | null }>(
    'SELECT scheduled_workout_id FROM workout_sessions WHERE user_id=$1 AND id=$2', [owner, id],
  );
  if (!link) throw missing();
  const scheduleRevision = link.scheduled_workout_id ? await lockSchedule(client, owner) : null;
  // Serialize receipt keys across all sessions for this account, then lock the addressed session.
  await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [owner]);
  const row = await readRow(client, owner, id, true);
  const digest = createHash('sha256').update(JSON.stringify({ id, expectedRevision: input.expectedRevision })).digest('hex');
  const { rows: [receipt] } = await client.query<{ payload_digest: string; commit_summary: { id: string } }>(`
    SELECT o.payload_digest,r.commit_summary FROM operation_receipts o JOIN mutation_results r
      ON (r.user_id,r.operation_type,r.id)=(o.user_id,o.operation_type,o.result_reference)
    WHERE o.user_id=$1 AND o.operation_type='complete_workout' AND o.client_operation_id=$2
  `, [owner, input.clientOperationId]);
  if (receipt) {
    if (receipt.payload_digest !== digest || receipt.commit_summary.id !== id) {
      throw new WorkoutError(409, 'IDEMPOTENCY_CONFLICT', 'Operation ID was used with different workout details.');
    }
    return view(client, row);
  }

  const revision = nextRevision(row, input.expectedRevision);
  const snapshot = (await view(client, row)).snapshot;
  if (!snapshot.exercises.some(exercise => exercise.actualSets.length)) throw invalid('Save at least one actual set before completing.');
  await checkSize(client, snapshot);
  const now = new Date(Math.max(Date.now(), row.started_at.getTime()));
  const duration = elapsed(row, now);
  if (link.scheduled_workout_id && scheduleRevision !== null) {
    if (!revisionSchema.safeParse(scheduleRevision + 1).success) throw conflict('Schedule revision limit reached.');
    const occurrence = await client.query(`UPDATE scheduled_workouts SET status='completed', revision=revision+1, updated_at=$3
      WHERE user_id=$1 AND id=$2 AND status IN ('planned','missed')`, [owner, link.scheduled_workout_id, now]);
    if (!occurrence.rowCount) throw conflict('The scheduled workout is already closed.');
    await client.query('UPDATE schedule_revisions SET revision=revision+1,updated_at=$2 WHERE user_id=$1', [owner, now]);
    await syncScheduleReminder(client, owner, link.scheduled_workout_id, now);
  }
  const { rows: [completed] } = await client.query<SessionRow>(`
    UPDATE workout_sessions SET status='completed',revision=$2,routine_snapshot=$3,ended_at=$4,
      actual_duration_seconds=$5,elapsed_milliseconds=$6,active_since=NULL,rest_remaining_milliseconds=0,
      rest_ends_at=NULL,updated_at=$4 WHERE id=$1 RETURNING *
  `, [id, revision, JSON.stringify(snapshot), now, Math.floor(duration / 1000), duration]);
  const resultId = randomUUID();
  await client.query(`
    INSERT INTO mutation_results (id,user_id,operation_type,commit_summary)
      VALUES ($1,$2,'complete_workout',$3)
  `, [resultId, owner, JSON.stringify({ id, revision })]);
  await client.query(`
    INSERT INTO operation_receipts (id,user_id,operation_type,client_operation_id,payload_digest,result_reference)
      VALUES ($1,$2,'complete_workout',$3,$4,$5)
  `, [randomUUID(), owner, input.clientOperationId, digest, resultId]);
  return view(client, completed!);
}

export function createWorkoutsRouter(db: Pool) {
  const router = Router();
  router.get('/workout-sessions', route(async (_req, res) => {
    const data = await transaction(db, async client => {
      const { rows } = await client.query<SessionRow>(`
        SELECT * FROM workout_sessions WHERE user_id=$1
        ORDER BY (status IN ('active','paused')) DESC,started_at DESC,id LIMIT 50 FOR SHARE
      `, [res.locals.userId]);
      return Promise.all(rows.map(row => view(client, row)));
    });
    res.json({ data });
  }));
  router.get('/workout-sessions/:id', route(async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    const data = await transaction(db, async client => {
      const { rows: [row] } = await client.query<SessionRow>(
        'SELECT * FROM workout_sessions WHERE user_id=$1 AND id=$2 FOR SHARE', [res.locals.userId, id],
      );
      if (!row) throw missing();
      return view(client, row);
    });
    res.json({ data });
  }));
  router.post('/workout-sessions', route(async (req, res) => {
    const input = parse(workoutStartSchema, req.body);
    res.status(201).json({ data: await transaction(db, client => start(client, res.locals.userId, input)) });
  }));
  router.patch('/workout-sessions/:id', route(async (req, res) => {
    const id = parse(uuidSchema, req.params.id).toLowerCase();
    const change = parse(workoutPatchSchema, req.body);
    res.json({ data: await transaction(db, client => patch(client, res.locals.userId, id, change)) });
  }));
  router.post('/workout-sessions/:id/complete', route(async (req, res) => {
    const id = parse(uuidSchema, req.params.id).toLowerCase();
    const input = parse(workoutCompleteSchema, req.body);
    res.json({ data: await transaction(db, client => complete(client, res.locals.userId, id, input)) });
  }));
  return router;
}
