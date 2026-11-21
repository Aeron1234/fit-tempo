import { createHash, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import {
  hydrationGoalCreateSchema, hydrationGoalPatchSchema, localDateAt, uuidSchema,
  waterCreateSchema, waterQuerySchema, waterWriteSchema,
} from '@fit-tempo/contracts';

class HydrationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const missing = () => new HydrationError(404, 'NOT_FOUND', 'This hydration entry or goal is unavailable.');
const conflict = (message: string) => new HydrationError(409, 'REVISION_CONFLICT', message);

function checked<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HydrationError(400, 'VALIDATION_ERROR', 'Check the amount, date, and request fields.');
  return parsed.data;
}

function routed(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (!(error instanceof HydrationError)) return next(error);
      res.status(error.status).json({ error: { code: error.code, message: error.message, requestId: res.locals.requestId } });
    }
  };
}

async function transact<T>(db: Pool, owner: string, work: (client: PoolClient) => Promise<T>, write = true) {
  const client = await db.connect();
  try {
    await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (write) await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [owner]);
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

async function ownerZone(client: PoolClient, owner: string) {
  const { rows: [row] } = await client.query<{ time_zone: string }>('SELECT time_zone FROM user_preferences WHERE user_id=$1', [owner]);
  return row?.time_zone ?? 'Asia/Manila';
}

const entryProjection = [
  'id', 'trim_scale(amount_ml)::text AS "amountMl"', 'occurred_at AS "occurredAt"',
  'recorded_time_zone AS "timeZone"', 'recorded_local_date::text AS "localDate"',
].join(', ');
const goalProjection = [
  'id', 'trim_scale(target_value)::text AS "targetMl"', 'effective_from::text AS "effectiveFrom"',
  'effective_until::text AS "effectiveUntil"', 'status',
].join(', ');

type WaterEntry = { id: string; amountMl: string; occurredAt: Date; timeZone: string; localDate: string };
type Day = { date: string; timeZone: string };

async function total(client: PoolClient, owner: string, date: string) {
  const { rows: [row] } = await client.query<{ amount: string | null }>(`
    SELECT trim_scale(sum(amount_ml))::text AS amount FROM water_logs WHERE user_id=$1 AND recorded_local_date=$2
  `, [owner, date]);
  return row.amount;
}

function ensureNotFuture(occurredAt: string) {
  if (Date.parse(occurredAt) > Date.now()) {
    throw new HydrationError(400, 'VALIDATION_ERROR', 'Record water at the time you drank it.');
  }
}

async function refreshDay(client: PoolClient, owner: string, day: Day, before: string | null) {
  await client.query(`
    INSERT INTO daily_tracking_status(id,user_id,category,recorded_local_date,recorded_time_zone,state,entry_count)
    SELECT $3,$1,'hydration',$2,$4,CASE WHEN count(*)=0 THEN 'unrecorded' ELSE 'partial' END,count(*)::integer
    FROM water_logs WHERE user_id=$1 AND recorded_local_date=$2
    ON CONFLICT(user_id,category,recorded_local_date) DO UPDATE
    SET state=EXCLUDED.state,entry_count=EXCLUDED.entry_count,confirmed_at=NULL,
        updated_at=now(),revision=daily_tracking_status.revision+1
  `, [owner, day.date, randomUUID(), day.timeZone]);

  // Creating a goal and changing its status do not themselves count as a crossing.
  const after = await total(client, owner, day.date);
  await client.query(`
    INSERT INTO milestone_events(id,user_id,goal_id,milestone_key,milestone_version,occurred_at)
    SELECT $1,g.user_id,g.id,'hydration-target:' || g.id,1,now()
    FROM fitness_goals g
    WHERE g.user_id=$2 AND g.type='hydration' AND g.target_unit='ml' AND g.status='active'
      AND g.effective_from<=$3 AND (g.effective_until IS NULL OR g.effective_until>=$3)
      AND coalesce($4::numeric,0)<g.target_value AND $5::numeric>=g.target_value
    ON CONFLICT(user_id,milestone_key,milestone_version) DO NOTHING
  `, [randomUUID(), owner, day.date, before, after]);
}

async function streak(client: PoolClient, owner: string) {
  // Walk backward through actual scheduled opportunities. Gaps and cancelled
  // opportunities are neutral. An overdue planned opportunity still underway is neutral.
  const { rows: [row] } = await client.query<{ streak: number }>(`
    WITH opportunities AS (
      SELECT s.id,s.starts_at,EXISTS(
        SELECT 1 FROM workout_sessions w
        WHERE w.user_id=s.user_id AND w.scheduled_workout_id=s.id AND w.status='completed'
      ) AS completed
      FROM scheduled_workouts s
      WHERE s.user_id=$1 AND s.status<>'cancelled'
        AND (s.status='completed' OR (s.ends_at<=now() AND NOT EXISTS(
          SELECT 1 FROM workout_sessions w
          WHERE w.user_id=s.user_id AND w.scheduled_workout_id=s.id AND w.status IN ('active','paused')
        )))
    ), last_gap AS (
      SELECT starts_at,id FROM opportunities WHERE NOT completed ORDER BY starts_at DESC,id DESC LIMIT 1
    )
    SELECT count(*)::integer AS streak FROM opportunities o
    WHERE o.completed AND NOT EXISTS(
      SELECT 1 FROM last_gap g WHERE (o.starts_at,o.id)<=(g.starts_at,g.id)
    )
  `, [owner]);
  return row.streak;
}

export function createHydrationRouter(db: Pool) {
  const router = Router();

  router.get('/water', routed(async (req, res) => {
    const query = checked(waterQuerySchema, req.query);
    const owner: string = res.locals.userId;
    const data = await transact(db, owner, async client => {
      const timeZone = await ownerZone(client, owner);
      const date = query.date ?? localDateAt(new Date().toISOString(), timeZone);
      const { rows: entries } = await client.query<WaterEntry>(`
        SELECT ${entryProjection} FROM water_logs WHERE user_id=$1 AND recorded_local_date=$2
        ORDER BY occurred_at DESC,id
      `, [owner, date]);
      const dayTotal = await total(client, owner, date);
      const { rows: [tracking] } = await client.query<{ state: string }>(`
        SELECT state FROM daily_tracking_status WHERE user_id=$1 AND category='hydration' AND recorded_local_date=$2
      `, [owner, date]);
      return { date, timeZone, entries, totalMl: dayTotal ?? (tracking?.state === 'complete' ? '0' : null) };
    }, false);
    res.json({ data });
  }));

  router.post('/water', routed(async (req, res) => {
    const { amountMl, occurredAt, clientOperationId } = checked(waterCreateSchema, req.body);
    const owner: string = res.locals.userId;
    const digest = createHash('sha256').update(JSON.stringify({ amountMl, occurredAt })).digest('hex');
    const data = await transact(db, owner, async client => {
      const { rows: [receipt] } = await client.query<{ payload_digest: string; commit_summary: WaterEntry }>(`
        SELECT o.payload_digest,r.commit_summary FROM operation_receipts o JOIN mutation_results r
        ON (r.user_id,r.operation_type,r.id)=(o.user_id,o.operation_type,o.result_reference)
        WHERE o.user_id=$1 AND o.client_operation_id=$2 AND o.operation_type='log_water'
      `, [owner, clientOperationId]);
      if (receipt) {
        if (receipt.payload_digest !== digest) throw new HydrationError(409, 'IDEMPOTENCY_CONFLICT', 'Operation ID already used.');
        return receipt.commit_summary;
      }
      ensureNotFuture(occurredAt);
      const timeZone = await ownerZone(client, owner);
      const date = localDateAt(occurredAt, timeZone);
      const before = await total(client, owner, date);
      const { rows: [entry] } = await client.query<WaterEntry>(`
        INSERT INTO water_logs(id,user_id,amount_ml,occurred_at,recorded_time_zone,recorded_local_date,client_operation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${entryProjection}
      `, [randomUUID(), owner, amountMl, occurredAt, timeZone, date, clientOperationId]);
      await refreshDay(client, owner, { date, timeZone }, before);
      const resultId = randomUUID();
      await client.query(`
        INSERT INTO mutation_results(id,user_id,operation_type,commit_summary) VALUES($1,$2,'log_water',$3)
      `, [resultId, owner, JSON.stringify(entry)]);
      await client.query(`
        INSERT INTO operation_receipts(id,user_id,operation_type,client_operation_id,payload_digest,result_reference)
        VALUES($1,$2,'log_water',$3,$4,$5)
      `, [randomUUID(), owner, clientOperationId, digest, resultId]);
      return entry;
    });
    res.status(201).json({ data });
  }));

  router.patch('/water/:id', routed(async (req, res) => {
    const id = checked(uuidSchema, req.params.id);
    const { amountMl, occurredAt } = checked(waterWriteSchema, req.body);
    const owner: string = res.locals.userId;
    ensureNotFuture(occurredAt);
    const data = await transact(db, owner, async client => {
      const { rows: [existing] } = await client.query<WaterEntry>(`
        SELECT ${entryProjection} FROM water_logs WHERE id=$1 AND user_id=$2
      `, [id, owner]);
      if (!existing) throw missing();
      const date = localDateAt(occurredAt, existing.timeZone);
      const affected = [...new Set([existing.localDate, date])];
      const before = new Map<string, string | null>();
      for (const day of affected) before.set(day, await total(client, owner, day));
      const { rows: [updated] } = await client.query<WaterEntry>(`
        UPDATE water_logs SET amount_ml=$3,occurred_at=$4,recorded_local_date=$5
        WHERE id=$1 AND user_id=$2 RETURNING ${entryProjection}
      `, [id, owner, amountMl, occurredAt, date]);
      for (const day of affected) {
        await refreshDay(client, owner, { date: day, timeZone: existing.timeZone }, before.get(day) ?? null);
      }
      return updated;
    });
    res.json({ data });
  }));

  router.delete('/water/:id', routed(async (req, res) => {
    const id = checked(uuidSchema, req.params.id);
    const owner: string = res.locals.userId;
    await transact(db, owner, async client => {
      const { rows: [existing] } = await client.query<WaterEntry>(`
        SELECT ${entryProjection} FROM water_logs WHERE id=$1 AND user_id=$2
      `, [id, owner]);
      if (!existing) throw missing();
      const before = await total(client, owner, existing.localDate);
      await client.query('DELETE FROM water_logs WHERE id=$1 AND user_id=$2', [id, owner]);
      await refreshDay(client, owner, { date: existing.localDate, timeZone: existing.timeZone }, before);
    });
    res.sendStatus(204);
  }));

  router.get('/goals', routed(async (_req, res) => {
    const owner: string = res.locals.userId;
    const data = await transact(db, owner, async client => {
      const { rows: goals } = await client.query(`
        SELECT ${goalProjection} FROM fitness_goals WHERE user_id=$1 AND type='hydration' AND target_unit='ml'
        ORDER BY effective_from DESC,created_at DESC,id
      `, [owner]);
      const { rows: milestones } = await client.query(`
        SELECT m.id,m.goal_id AS "goalId",m.occurred_at AS "occurredAt"
        FROM milestone_events m JOIN fitness_goals g ON g.user_id=m.user_id AND g.id=m.goal_id
        WHERE m.user_id=$1 AND g.type='hydration' AND g.target_unit='ml'
        ORDER BY m.occurred_at DESC,m.id
      `, [owner]);
      return { goals, milestones, workoutStreak: await streak(client, owner) };
    }, false);
    res.json({ data });
  }));

  router.post('/goals', routed(async (req, res) => {
    const { targetMl } = checked(hydrationGoalCreateSchema, req.body);
    const owner: string = res.locals.userId;
    const data = await transact(db, owner, async client => {
      if ((await client.query(`
        SELECT 1 FROM fitness_goals WHERE user_id=$1 AND type='hydration' AND status='active'
      `, [owner])).rowCount) throw conflict('Retire the current hydration goal before starting a new cycle.');
      const date = localDateAt(new Date().toISOString(), await ownerZone(client, owner));
      const { rows: [row] } = await client.query(`
        INSERT INTO fitness_goals(id,user_id,type,target_value,target_unit,effective_from)
        VALUES($1,$2,'hydration',$3,'ml',$4) RETURNING ${goalProjection}
      `, [randomUUID(), owner, targetMl, date]);
      return row;
    });
    res.status(201).json({ data });
  }));

  router.patch('/goals/:id', routed(async (req, res) => {
    const id = checked(uuidSchema, req.params.id);
    checked(hydrationGoalPatchSchema, req.body);
    const owner: string = res.locals.userId;
    const data = await transact(db, owner, async client => {
      const date = localDateAt(new Date().toISOString(), await ownerZone(client, owner));
      const { rows: [goal] } = await client.query(`
        UPDATE fitness_goals SET status='retired',effective_until=coalesce(effective_until,greatest(effective_from,$3::date)),
          updated_at=now()
        WHERE id=$1 AND user_id=$2 AND type='hydration' AND target_unit='ml'
        RETURNING ${goalProjection}
      `, [id, owner, date]);
      if (!goal) throw missing();
      return goal;
    });
    res.json({ data });
  }));

  return router;
}
