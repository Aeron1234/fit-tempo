import { createHash, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  availabilityWriteSchema, revisionSchema, scheduleAcceptSchema, schedulePatchSchema,
  scheduleProposalSchema, scheduleProposalWriteSchema, scheduleStartSchema, uuidSchema,
  type ScheduleOccurrence, type ScheduleProposal,
} from '@fit-tempo/contracts';

class ScheduleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly currentRevision?: number) {
    super(message);
  }
}
const missing = () => new ScheduleError(404, 'NOT_FOUND', 'Schedule item unavailable.');
const invalid = (message: string) => new ScheduleError(400, 'VALIDATION_ERROR', message);
const conflict = (revision: number, message = 'Schedule changed. Review the current week.') =>
  new ScheduleError(409, 'SCHEDULE_CONFLICT', message, revision);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid('Review the schedule fields.');
  return result.data;
}
const route = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try { await handler(req, res, next); }
  catch (error) {
    if (!(error instanceof ScheduleError)) return next(error);
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
  } finally { client.release(); }
}
export async function lockSchedule(client: PoolClient, owner: string): Promise<number> {
  await client.query('INSERT INTO schedule_revisions(user_id) VALUES($1) ON CONFLICT DO NOTHING', [owner]);
  const { rows: [row] } = await client.query('SELECT revision FROM schedule_revisions WHERE user_id=$1 FOR UPDATE', [owner]);
  return Number(row.revision);
}
function requireRevision(current: number, expected: number) {
  if (current !== expected || !revisionSchema.safeParse(current + 1).success) throw conflict(current);
}
async function advance(client: PoolClient, owner: string, revision: number) {
  await client.query('UPDATE schedule_revisions SET revision=$2,updated_at=now() WHERE user_id=$1', [owner, revision + 1]);
}
async function context(client: PoolClient, owner: string) {
  const { rows: [row] } = await client.query(`
    SELECT COALESCE(p.time_zone,'Asia/Manila') AS "timeZone", COALESCE(s.revision,0)::float8 AS revision,
      COALESCE(g.rest_days,'{}') AS "restDays"
    FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id
    LEFT JOIN schedule_revisions s ON s.user_id=u.id LEFT JOIN schedule_settings g ON g.user_id=u.id
    WHERE u.id=$1
  `, [owner]);
  return row as { timeZone: string; revision: number; restDays: number[] };
}
async function availability(client: PoolClient, owner: string) {
  const settings = await context(client, owner);
  const { rows: slots } = await client.query(`
    SELECT weekday,to_char(local_start,'HH24:MI') AS start,to_char(local_end,'HH24:MI') AS end,equipment
    FROM availability_slots WHERE user_id=$1 ORDER BY weekday,local_start,local_end,id
  `, [owner]);
  return { ...settings, slots };
}

const occurrenceSelect = `
  SELECT w.id,w.routine_id AS "routineId",w.variant_id AS "variantId",COALESCE(v.name,r.name) AS name,
    w.starts_at AS "startsAt",w.ends_at AS "endsAt",w.recorded_time_zone AS "timeZone",
    w.recorded_local_date::text AS "localDate",
    CASE WHEN w.status='planned' AND w.ends_at <= now() THEN 'missed' ELSE w.status END AS status
  FROM scheduled_workouts w JOIN workout_routines r ON r.id=w.routine_id
  LEFT JOIN workout_routines v ON v.id=w.variant_id WHERE w.user_id=$1
`;
type OccurrenceRow = Omit<ScheduleOccurrence, 'startsAt' | 'endsAt'> & { startsAt: Date; endsAt: Date };
function occurrence(row: OccurrenceRow): ScheduleOccurrence {
  return { ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() };
}
async function findWorkout(client: PoolClient, owner: string, id: string) {
  const { rows: [row] } = await client.query<OccurrenceRow>(occurrenceSelect + ' AND w.id=$2', [owner, id]);
  if (!row) throw missing();
  return occurrence(row);
}
async function workouts(client: PoolClient, owner: string) {
  const { revision, timeZone } = await context(client, owner);
  const { rows } = await client.query<OccurrenceRow>(
    occurrenceSelect + ' ORDER BY w.starts_at DESC,w.id LIMIT 100', [owner],
  );
  return { revision, timeZone, workouts: rows.map(occurrence) };
}
type Routine = { id: string; name: string; minutes: number; equipment: string[]; exercises: string[]; revision: number };
async function routines(client: PoolClient, owner: string, id: string): Promise<Routine[]> {
  const { rows } = await client.query<{
    id: string; name: string; minutes: number; revision: number;
  }>(`
    SELECT r.id,r.name,r.duration_minutes AS minutes,r.revision::float8 AS revision
    FROM workout_routines r WHERE r.archived_at IS NULL AND r.duration_minutes IS NOT NULL
      AND ((r.id=$2 AND ((r.user_id=$1 AND r.visibility='private') OR (r.user_id IS NULL AND r.visibility='approved')))
      OR (r.user_id IS NULL AND r.visibility='approved' AND EXISTS (
        SELECT 1 FROM reviewed_routine_variants l JOIN workout_routines b ON b.id=l.routine_id
        WHERE b.id=$2 AND b.user_id IS NULL AND b.visibility='approved' AND b.archived_at IS NULL
          AND l.variant_id=r.id AND l.routine_revision=b.revision AND l.variant_revision=r.revision
          AND r.duration_minutes < b.duration_minutes
      ))) ORDER BY (r.id=$2) DESC,r.duration_minutes DESC,r.id FOR SHARE OF r
  `, [owner, id]);
  const eligible: Routine[] = [];
  for (const row of rows) {
    const { rows: targets } = await client.query<{
      name: string; detail: string; equipment: string | null; visible: boolean;
    }>(`
      SELECT e.name,e.equipment,
        COALESCE((e.owner_id=$1 AND e.visibility='private') OR (e.owner_id IS NULL AND e.visibility='approved'),false) AS visible,
        concat_ws(' ', e.name, CASE WHEN t.target_sets IS NOT NULL THEN t.target_sets || ' sets' END,
          CASE WHEN t.target_reps IS NOT NULL THEN t.target_reps || ' reps' END,
          CASE WHEN t.target_load_kg IS NOT NULL THEN trim_scale(t.target_load_kg) || ' kg' END,
          CASE WHEN t.target_seconds IS NOT NULL THEN trim_scale(t.target_seconds) || ' s' END,
          CASE WHEN t.target_meters IS NOT NULL THEN trim_scale(t.target_meters) || ' m' END) AS detail
      FROM routine_exercises t JOIN exercises e ON e.id=t.exercise_id
      WHERE t.routine_id=$2 ORDER BY t.exercise_order FOR SHARE OF e
    `, [owner, row.id]);
    if (targets.length && targets.every(target => target.visible)) eligible.push({
      ...row, equipment: targets.flatMap(target => target.equipment ? [target.equipment] : []),
      exercises: targets.map(target => target.detail),
    });
  }
  if (eligible[0]?.id !== id.toLowerCase()) throw missing();
  return eligible;
}

export async function syncScheduleReminder(client: PoolClient, owner: string, workoutId: string, now: Date) {
  await client.query(`
    UPDATE notification_jobs SET status='cancelled',retry_at=NULL,lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,updated_at=$3
    WHERE user_id=$1 AND scheduled_workout_id=$2 AND type='workout_reminder'
      AND status IN ('pending','leased','failed')
  `, [owner, workoutId, now]);
  await client.query(`
    INSERT INTO notification_jobs(id,user_id,type,occurrence_identity,scheduled_at,expires_at,
      schedule_revision,preference_revision,scheduled_workout_id)
    SELECT $4,w.user_id,'workout_reminder',w.id || ':' || w.revision, reminder.due,w.starts_at,
      w.revision,p.revision,w.id
    FROM scheduled_workouts w
    JOIN notification_preferences p ON p.user_id=w.user_id AND p.type='workout_reminder' AND p.enabled
    LEFT JOIN user_preferences pref ON pref.user_id=w.user_id
    CROSS JOIN LATERAL (SELECT GREATEST($3::timestamptz,
      w.starts_at - make_interval(mins=>COALESCE(p.interval_minutes,30))) AS due) reminder
    CROSS JOIN LATERAL (SELECT (reminder.due AT TIME ZONE
      COALESCE(p.fixed_time_zone,pref.time_zone,w.recorded_time_zone))::time AS clock) local
    WHERE w.user_id=$1 AND w.id=$2 AND w.status='planned' AND w.starts_at>$3
      AND EXISTS (SELECT 1 FROM users u WHERE u.id=w.user_id AND u.active AND u.verified_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id=w.user_id AND s.global_opt_out)
      AND (p.quiet_start IS NULL OR p.quiet_start=p.quiet_end OR NOT CASE
        WHEN p.quiet_start<p.quiet_end THEN local.clock>=p.quiet_start AND local.clock<p.quiet_end
        ELSE local.clock>=p.quiet_start OR local.clock<p.quiet_end END)
    ON CONFLICT DO NOTHING
  `, [owner, workoutId, now, randomUUID()]);
}

function availableEquipment(required: string[], available: string[]) {
  const normalized = new Set(available.map(item => item.trim().toLowerCase()));
  return required.every(item => normalized.has(item.trim().toLowerCase()));
}

async function eligibleStarts(client: PoolClient, owner: string, routine: Routine, zone: string,
  now: Date, exclude: string | null, fixedStart: string | null, ignoreSourceDay: string | null) {
  // Resolve wall-clock minutes chronologically. Skip spring gaps and use the
  // earlier instant when a fall transition repeats the same wall-clock minute.
  const { rows } = await client.query<{ start: Date; end: Date; day: string; equipment: string[] }>(`
    WITH days AS (
      SELECT (($3::timestamptz AT TIME ZONE $2)::date + i) AS day
      FROM generate_series(0,6) i WHERE $6::timestamptz IS NULL
      UNION ALL SELECT ($6::timestamptz AT TIME ZONE $2)::date WHERE $6 IS NOT NULL
    ), windows AS (
      SELECT d.day,s.equipment,d.day+s.local_start AS first,d.day+s.local_end AS last
      FROM days d JOIN availability_slots s ON s.user_id=$1 AND s.weekday=extract(dow FROM d.day)
      LEFT JOIN schedule_settings cfg ON cfg.user_id=$1
      WHERE NOT extract(dow FROM d.day)::smallint=ANY(COALESCE(cfg.rest_days,'{}'))
        AND d.day::text IS DISTINCT FROM $7::text
    ), candidates AS (
      SELECT w.*, candidate.wall, COALESCE($6::timestamptz,resolved.first_instant) AS start
      FROM windows w CROSS JOIN LATERAL (
        SELECT wall FROM generate_series(w.first,w.last,interval '1 minute') wall WHERE $6::timestamptz IS NULL
        UNION ALL SELECT $6::timestamptz AT TIME ZONE $2 WHERE $6 IS NOT NULL
      ) candidate
      LEFT JOIN LATERAL (
        SELECT min(candidate_instant.instant) AS first_instant
        FROM generate_series(-1,1) day_offset
        CROSS JOIN LATERAL (SELECT (candidate.wall AT TIME ZONE $2)+make_interval(days=>day_offset) AS probe) p
        CROSS JOIN LATERAL (SELECT (candidate.wall-((p.probe AT TIME ZONE $2)-
          (p.probe AT TIME ZONE 'UTC'))) AT TIME ZONE 'UTC' AS instant) candidate_instant
        WHERE (candidate_instant.instant AT TIME ZONE $2)=candidate.wall
      ) resolved ON $6 IS NULL
      WHERE candidate.wall >= w.first AND candidate.wall < w.last
    )
    SELECT c.start,c.start+make_interval(mins=>$4) AS end,c.day::text AS day,c.equipment
    FROM candidates c
    WHERE c.start>$3 AND (c.start AT TIME ZONE $2)=c.wall
      AND ((c.start+make_interval(mins=>$4)) AT TIME ZONE $2)<=c.last
      AND ((c.start+make_interval(mins=>$4)) AT TIME ZONE $2)>c.wall
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_workouts x WHERE x.user_id=$1 AND x.status IN ('planned','completed','missed')
          AND x.id IS DISTINCT FROM $5::uuid
          AND ((x.starts_at AT TIME ZONE $2)::date=c.day
            OR (x.starts_at<c.start+make_interval(mins=>$4) AND x.ends_at>c.start))
      )
    ORDER BY c.start
  `, [owner, zone, now, routine.minutes, exclude, fixedStart, ignoreSourceDay]);
  return rows.filter(row => availableEquipment(routine.equipment, row.equipment));
}

async function plan(client: PoolClient, owner: string, before: ScheduleOccurrence, revision: number,
  now: Date, fixedStart: string | null = null, variantId: string | null | undefined = undefined) {
  const { timeZone } = await context(client, owner);
  if (before.status !== 'missed') throw conflict(revision, 'Only missed workouts can be rescheduled.');
  if ((await client.query(`SELECT 1 FROM workout_sessions WHERE user_id=$1 AND scheduled_workout_id=$2
    AND status IN ('active','paused','completed')`, [owner,before.id])).rowCount) {
    throw conflict(revision,'This workout already has a session.');
  }
  const options = await routines(client, owner, before.routineId);
  const source = options.find(item => item.id === (before.variantId ?? before.routineId));
  if (!source) throw conflict(revision, 'The original routine or reviewed variant changed.');
  const candidates = [];
  for (const option of options) {
    const variant = option.id === before.routineId ? null : option.id;
    if (variantId !== undefined && variant !== variantId) continue;
    const [slot] = await eligibleStarts(client, owner, option, timeZone, now, before.id, fixedStart, before.localDate);
    if (slot) candidates.push({ slot, option, variant });
  }
  candidates.sort((a,b) => a.slot.start.getTime() - b.slot.start.getTime() || b.option.minutes - a.option.minutes);
  const best = candidates[0];
  if (!best) return null;
  return {
    before, beforeExercises: source.exercises, afterExercises: best.option.exercises,
    after: { ...before, startsAt: best.slot.start.toISOString(), endsAt: best.slot.end.toISOString(),
      timeZone, localDate: best.slot.day, name: best.option.name, variantId: best.variant, status: 'planned' as const },
  };
}

async function changeStatus(client: PoolClient, owner: string, id: string, revision: number,
  status: 'cancelled' | 'skipped', now: Date) {
  const before = await findWorkout(client, owner, id);
  if (before.status !== 'planned' && before.status !== 'missed') throw conflict(revision, 'This workout is closed.');
  if ((await client.query(`SELECT 1 FROM workout_sessions WHERE user_id=$1 AND scheduled_workout_id=$2
    AND status IN ('active','paused','completed')`, [owner,id])).rowCount) {
    throw conflict(revision, 'This workout already has a session.');
  }
  await client.query('UPDATE scheduled_workouts SET status=$3,revision=revision+1,updated_at=$4 WHERE user_id=$1 AND id=$2',
    [owner,id,status,now]);
  await syncScheduleReminder(client, owner, id, now);
  await advance(client, owner, revision);
}

export function createScheduleRouter(db: Pool) {
  const router = Router();
  router.get('/availability', route(async (_req,res) => {
    res.json({ data: await transaction(db, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return availability(client,res.locals.userId);
    }) });
  }));
  router.put('/availability', route(async (req,res) => {
    const input = parse(availabilityWriteSchema,req.body);
    const owner = res.locals.userId;
    res.json({ data: await transaction(db,async client => {
      const revision = await lockSchedule(client,owner);
      requireRevision(revision,input.expectedRevision);
      const { timeZone } = await context(client,owner);
      await client.query('DELETE FROM availability_slots WHERE user_id=$1',[owner]);
      for (const slot of input.slots) {
        await client.query(`INSERT INTO availability_slots(id,user_id,weekday,local_start,local_end,time_zone,equipment)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(),owner,slot.weekday,slot.start,slot.end,timeZone,JSON.stringify(slot.equipment)]);
      }
      await client.query(`INSERT INTO schedule_settings(user_id,rest_days) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET rest_days=EXCLUDED.rest_days`, [owner,[...new Set(input.restDays)].sort()]);
      await advance(client,owner,revision);
      return availability(client,owner);
    }) });
  }));
  router.get('/scheduled-workouts',route(async (_req,res) => {
    res.json({ data: await transaction(db,async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return workouts(client,res.locals.userId);
    }) });
  }));
  router.post('/scheduled-workouts',route(async (req,res) => {
    const input = parse(scheduleStartSchema,req.body);
    const owner = res.locals.userId;
    res.status(201).json({ data: await transaction(db,async client => {
      const revision = await lockSchedule(client,owner);
      requireRevision(revision,input.expectedRevision);
      const { timeZone } = await context(client,owner);
      const [routine] = await routines(client,owner,input.routineId);
      const now = new Date();
      const [slot] = await eligibleStarts(client,owner,routine!,timeZone,now,null,input.startsAt,null);
      if (!slot) throw conflict(revision,'This workout does not fit your availability, equipment or rest days.');
      const id = randomUUID();
      await client.query(`INSERT INTO scheduled_workouts(id,user_id,routine_id,starts_at,ends_at,
        recorded_time_zone,recorded_local_date,status) VALUES($1,$2,$3,$4,$5,$6,$7,'planned')`,
      [id,owner,routine!.id,slot.start,slot.end,timeZone,slot.day]);
      await syncScheduleReminder(client,owner,id,now);
      await advance(client,owner,revision);
      return workouts(client,owner);
    }) });
  }));
  router.patch('/scheduled-workouts/:id',route(async (req,res) => {
    const input = parse(schedulePatchSchema,req.body);
    const id = parse(uuidSchema,req.params.id), owner = res.locals.userId;
    res.json({ data: await transaction(db,async client => {
      const revision = await lockSchedule(client,owner);
      requireRevision(revision,input.expectedRevision);
      await changeStatus(client,owner,id,revision,input.status,new Date());
      return workouts(client,owner);
    }) });
  }));
  router.post('/schedule-proposals',route(async (req,res) => {
    const input = parse(scheduleProposalWriteSchema,req.body), owner = res.locals.userId;
    res.json({ data: await transaction(db,async client => {
      const revision = await lockSchedule(client,owner);
      requireRevision(revision,input.expectedRevision);
      const before = await findWorkout(client,owner,input.workoutId);
      const now = new Date();
      const result = await plan(client,owner,before,revision,now);
      if (!result) return { proposal: null,reason: 'No compatible opening was found in the next seven days.' };
      const id = randomUUID(), expiresAt = new Date(now.getTime()+15*60_000).toISOString();
      const proposal = { ...result,id,revision,expiresAt };
      await client.query(`INSERT INTO schedule_proposals(id,user_id,base_revision,proposed_changes,expires_at)
        VALUES($1,$2,$3,$4,$5)`, [id,owner,revision,JSON.stringify(proposal),expiresAt]);
      return { proposal,reason: null };
    }) });
  }));
  router.post('/schedule-proposals/:id/accept',route(async (req,res) => {
    const input = parse(scheduleAcceptSchema,req.body);
    const id = parse(uuidSchema,req.params.id).toLowerCase(), owner = res.locals.userId;
    res.json({ data: await transaction(db,async client => {
      const revision = await lockSchedule(client,owner);
      const { rows: [row] } = await client.query(`SELECT * FROM schedule_proposals WHERE id=$1 AND user_id=$2 FOR UPDATE`,[id,owner]);
      if (!row) throw missing();
      const digest = createHash('sha256').update(JSON.stringify({ operation:'accept_schedule',id,
        expectedRevision:input.expectedRevision })).digest('hex');
      const { rows: [receipt] } = await client.query(`
        SELECT o.payload_digest,r.commit_summary FROM operation_receipts o JOIN mutation_results r
          ON (r.user_id,r.operation_type,r.id)=(o.user_id,o.operation_type,o.result_reference)
        WHERE o.user_id=$1 AND o.operation_type='accept_schedule' AND o.client_operation_id=$2
      `,[owner,input.clientOperationId]);
      if (receipt) {
        if (receipt.payload_digest !== digest) throw new ScheduleError(409,'IDEMPOTENCY_CONFLICT','Operation ID already used.');
        return receipt.commit_summary;
      }
      requireRevision(revision,input.expectedRevision);
      if (Number(row.base_revision)!==revision || row.applied_at) throw conflict(revision);
      const now = new Date();
      if (row.expires_at<=now) throw new ScheduleError(409,'PROPOSAL_EXPIRED','Review a fresh proposal.');
      const proposal: ScheduleProposal = parse(scheduleProposalSchema,row.proposed_changes);
      const before = await findWorkout(client,owner,proposal.before.id);
      const reviewed = await plan(client,owner,before,revision,now,proposal.after.startsAt,proposal.after.variantId);
      if (!reviewed || JSON.stringify(reviewed)!==JSON.stringify({
        before:proposal.before,beforeExercises:proposal.beforeExercises,afterExercises:proposal.afterExercises,after:proposal.after,
      })) throw conflict(revision,'Preview changed. Review a new proposal.');
      const after = proposal.after;
      await client.query(`UPDATE scheduled_workouts SET starts_at=$3,ends_at=$4,recorded_time_zone=$5,
        recorded_local_date=$6,variant_id=$7,status='planned',revision=revision+1,updated_at=$8
        WHERE user_id=$1 AND id=$2`, [owner,before.id,after.startsAt,after.endsAt,after.timeZone,after.localDate,after.variantId,now]);
      await syncScheduleReminder(client,owner,before.id,now);
      await advance(client,owner,revision);
      await client.query('UPDATE schedule_proposals SET applied_at=$2 WHERE id=$1',[id,now]);
      const result = { id,revision:revision+1,workoutId:before.id };
      const resultId = randomUUID();
      await client.query(`INSERT INTO mutation_results(id,user_id,operation_type,commit_summary)
        VALUES($1,$2,'accept_schedule',$3)`, [resultId,owner,JSON.stringify(result)]);
      await client.query(`INSERT INTO operation_receipts(id,user_id,operation_type,client_operation_id,payload_digest,result_reference)
        VALUES($1,$2,'accept_schedule',$3,$4,$5)`, [randomUUID(),owner,input.clientOperationId,digest,resultId]);
      return result;
    }) });
  }));
  return router;
}
