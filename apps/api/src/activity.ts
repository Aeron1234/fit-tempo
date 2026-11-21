import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  activityWriteSchema, localDateAt, measurementWriteSchema,
  trackingRangeSchema, uuidSchema, weightWriteSchema,
} from '@fit-tempo/contracts';

const pageSize = 500;
const dayMillis = 86_400_000;
type Client = Pool | PoolClient;
type ActivityInput = z.infer<typeof activityWriteSchema>;

class TrackingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const invalid = (message: string) => new TrackingError(400, 'VALIDATION_ERROR', message);
const missing = () => new TrackingError(404, 'NOT_FOUND', 'This record or completed workout is unavailable.');

function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success) throw invalid('Check the activity, measurement, units, and date fields.');
  return result.data;
}

const route = (handle: RequestHandler): RequestHandler => async (req, res, next) => {
  try {
    await handle(req, res, next);
  } catch (error) {
    let failure = error;
    if (typeof error === 'object' && error !== null &&
      'constraint' in error && error.constraint === 'activity_logs_workout_once_idx') {
      failure = new TrackingError(409, 'REVISION_CONFLICT', 'This workout is already linked to an activity.');
    }
    if (!(failure instanceof TrackingError)) return next(error);
    res.status(failure.status).json({
      error: { code: failure.code, message: failure.message, requestId: res.locals.requestId },
    });
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

async function ownerTimeZone(db: Client, owner: string) {
  const { rows } = await db.query<{ time_zone: string }>('SELECT time_zone FROM user_preferences WHERE user_id=$1', [owner]);
  return rows[0]?.time_zone ?? 'Asia/Manila';
}

const utcDay = (date: string) => Date.parse(date + 'T00:00:00Z');
function rangeDate(date: string, offset: number) {
  // Stay in the four-digit Gregorian year range used by the tracking contract.
  const ms = Math.min(utcDay('9999-12-31'), Math.max(utcDay('0001-01-01'), utcDay(date) + offset * dayMillis));
  return new Date(ms).toISOString().slice(0, 10);
}

async function listingRange(db: Client, owner: string, args: unknown) {
  const query = parse(trackingRangeSchema, args);
  const timeZone = await ownerTimeZone(db, owner);
  const today = localDateAt(new Date().toISOString(), timeZone);
  const to = query.to ?? (query.from && query.from > today ? rangeDate(query.from, 29) : today);
  const from = query.from ?? rangeDate(to, -29);
  if (from > to || utcDay(to) - utcDay(from) > 92 * dayMillis) {
    throw invalid('Choose a date range of 93 days or fewer.');
  }
  return { from, to, timeZone };
}

const activityFields = `id,type,occurred_at AS "occurredAt",
  recorded_time_zone AS "timeZone", recorded_local_date::text AS "localDate",
  CASE WHEN linked_workout_id IS NULL THEN duration_seconds ELSE (
    SELECT actual_duration_seconds FROM workout_sessions
    WHERE user_id=activity_logs.user_id AND id=activity_logs.linked_workout_id
  ) END AS "durationSeconds", trim_scale(distance_meters)::text AS "distanceMeters",
  linked_workout_id AS "linkedWorkoutId",source`;
const bodyDateFields = `id,measured_at AS "measuredAt",recorded_time_zone AS "timeZone",
  recorded_local_date::text AS "localDate"`;
const weightFields = `${bodyDateFields},trim_scale(weight_kg)::text AS "weightKg",note`;
const measurementFields = `${bodyDateFields},measurement_type AS "measurementType",trim_scale(value_cm)::text AS "valueCm"`;

async function readActivity(db: Pool, owner: string, args: unknown) {
  return transaction(db, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const range = await listingRange(client, owner, args);
    const values = [owner, range.from, range.to];
    const entries = await client.query(`
      SELECT ${activityFields} FROM activity_logs
      WHERE user_id=$1 AND recorded_local_date BETWEEN $2 AND $3
      ORDER BY recorded_local_date DESC,occurred_at DESC,id LIMIT ${pageSize + 1}
    `, values);
    const { rows: [totals] } = await client.query(`
      SELECT (sum(duration_seconds) FILTER (WHERE linked_workout_id IS NULL))::float8 AS "durationSeconds",
        trim_scale(sum(distance_meters) FILTER (WHERE linked_workout_id IS NULL))::text AS "distanceMeters",
        (count(*) FILTER (WHERE linked_workout_id IS NULL))::float8 AS "manualCount",
        (count(*) FILTER (WHERE linked_workout_id IS NOT NULL))::float8 AS "linkedCount"
      FROM activity_logs WHERE user_id=$1 AND recorded_local_date BETWEEN $2 AND $3
    `, values);
    return { ...range, entries: entries.rows.slice(0, pageSize), truncated: entries.rows.length > pageSize, totals };
  });
}

async function writeActivity(db: Pool, owner: string, input: ActivityInput, editing?: string) {
  return transaction(db, async client => {
    let existingZone: string | undefined;
    if (editing) {
      const existing = await client.query<{ recorded_time_zone: string }>(
        'SELECT recorded_time_zone FROM activity_logs WHERE user_id=$1 AND id=$2 FOR UPDATE', [owner, editing],
      );
      existingZone = existing.rows[0]?.recorded_time_zone;
      if (!existingZone) throw missing();
    }
    const id = editing ?? randomUUID();
    const linkedWorkoutId = input.linkedWorkoutId ?? null;
    let { occurredAt, durationSeconds, distanceMeters } = input;
    let timeZone: string;
    let recordedDate: string;
    if (linkedWorkoutId) {
      const { rows: [workout] } = await client.query<{
        started_at: Date; recorded_time_zone: string; recorded_local_date: string; actual_duration_seconds: number | null;
      }>(`
        SELECT started_at,recorded_time_zone,recorded_local_date::text,actual_duration_seconds
        FROM workout_sessions WHERE user_id=$1 AND id=$2 AND status='completed' FOR SHARE
      `, [owner, linkedWorkoutId]);
      if (!workout) throw missing();
      occurredAt = workout.started_at.toISOString();
      timeZone = workout.recorded_time_zone;
      recordedDate = workout.recorded_local_date;
      durationSeconds = workout.actual_duration_seconds;
      distanceMeters = null;
    } else {
      timeZone = existingZone ?? await ownerTimeZone(client, owner);
      recordedDate = localDateAt(occurredAt, timeZone);
    }
    const values = [id, owner, input.type, occurredAt, timeZone, recordedDate, durationSeconds === 0 ? null : durationSeconds,
      distanceMeters, linkedWorkoutId ? 'workout' : 'manual', linkedWorkoutId];
    const { rows: [entry] } = await client.query(editing ? `
      UPDATE activity_logs SET type=$3,occurred_at=$4,recorded_time_zone=$5,recorded_local_date=$6,
        duration_seconds=$7,distance_meters=$8,source=$9,linked_workout_id=$10
      WHERE id=$1 AND user_id=$2 RETURNING ${activityFields}
    ` : `
      INSERT INTO activity_logs(id,user_id,type,occurred_at,recorded_time_zone,recorded_local_date,
        duration_seconds,distance_meters,source,linked_workout_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${activityFields}
    `, values);
    return entry;
  });
}

async function readBody(db: Pool, owner: string, args: unknown, type: 'weight' | 'measurement') {
  const range = await listingRange(db, owner, args);
  const fields = type === 'weight' ? weightFields : measurementFields;
  const table = type === 'weight' ? 'weight_logs' : 'measurement_logs';
  const result = await db.query(`SELECT ${fields} FROM ${table}
    WHERE user_id=$1 AND recorded_local_date BETWEEN $2 AND $3
    ORDER BY recorded_local_date DESC,measured_at DESC,id LIMIT ${pageSize + 1}`,
  [owner, range.from, range.to]);
  return { ...range, entries: result.rows.slice(0, pageSize), truncated: result.rows.length > pageSize };
}

export function createActivityRouter(db: Pool) {
  const router = Router();
  router.get('/activity', route(async (req, res) => {
    res.json({ data: await readActivity(db, res.locals.userId, req.query) });
  }));
  router.post('/activity', route(async (req, res) => {
    const input = parse(activityWriteSchema, req.body);
    res.status(201).json({ data: await writeActivity(db, res.locals.userId, input) });
  }));
  router.patch('/activity/:id', route(async (req, res) => {
    const input = parse(activityWriteSchema, req.body);
    const id = parse(uuidSchema, req.params.id);
    res.json({ data: await writeActivity(db, res.locals.userId, input, id) });
  }));
  router.delete('/activity/:id', route(async (req, res) => {
    const id = parse(uuidSchema, req.params.id);
    const result = await db.query('DELETE FROM activity_logs WHERE user_id=$1 AND id=$2', [res.locals.userId, id]);
    if (!result.rowCount) throw missing();
    res.sendStatus(204);
  }));
  router.get('/weight', route(async (req, res) => {
    res.json({ data: await readBody(db, res.locals.userId, req.query, 'weight') });
  }));
  router.post('/weight', route(async (req, res) => {
    const input = parse(weightWriteSchema, req.body);
    const owner = res.locals.userId;
    const zone = await ownerTimeZone(db, owner);
    const { rows: [entry] } = await db.query(`
      INSERT INTO weight_logs(id,user_id,weight_kg,measured_at,recorded_time_zone,recorded_local_date,note)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${weightFields}
    `, [randomUUID(), owner, input.weightKg, input.measuredAt, zone, localDateAt(input.measuredAt, zone), input.note ?? null]);
    res.status(201).json({ data: entry });
  }));
  router.get('/measurements', route(async (req, res) => {
    res.json({ data: await readBody(db, res.locals.userId, req.query, 'measurement') });
  }));
  router.post('/measurements', route(async (req, res) => {
    const input = parse(measurementWriteSchema, req.body);
    const owner = res.locals.userId;
    const zone = await ownerTimeZone(db, owner);
    const { rows: [entry] } = await db.query(`
      INSERT INTO measurement_logs(id,user_id,measurement_type,value_cm,measured_at,recorded_time_zone,recorded_local_date)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${measurementFields}
    `, [randomUUID(), owner, input.measurementType, input.valueCm, input.measuredAt, zone, localDateAt(input.measuredAt, zone)]);
    res.status(201).json({ data: entry });
  }));
  return router;
}
