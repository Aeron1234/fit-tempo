import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { lockSchedule } from './schedule.js';

const types = ['meal_reminder', 'weekly_summary', 'milestone', 'inactivity'];
const batchSize = 8;
const leaseSeconds = 30;
const attemptLimit = 3;
type Result = 'accepted' | 'retryable' | 'rejected' | 'unknown';
type Options = {
  dryRun: boolean;
  reserve: () => Promise<boolean>;
  send: (message: { to: string; type: string }) => Promise<Result>;
  now?: () => Date;
  recipientFilter?: string;
};
type Job = { id: string; user_id: string; type: string; attempts: number; lease_token: string };

export function resolveNotificationWallTime(date: string, time: string, zone: string): Date {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  function localAt(instant: number) {
    const fields = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, Number(part.value)]));
    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  }
  const probes = [wall - 86_400_000, wall, wall + 86_400_000];
  const direct = probes.map(probe => wall - (localAt(probe) - probe)).filter(instant => localAt(instant) === wall);
  if (direct.length) return new Date(Math.min(...direct));
  let after: { local: number; instant: number } | undefined;
  for (let instant = wall - 26 * 3_600_000; instant <= wall + 26 * 3_600_000; instant += 60_000) {
    const local = localAt(instant);
    if (local === wall) return new Date(instant);
    if (local > wall && (!after || local < after.local)) after = { local, instant };
  }
  if (!after) throw new Error('Invalid notification wall time.');
  return new Date(after.instant);
}

async function transaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='750ms'; SET LOCAL statement_timeout='3000ms'");
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

const releaseLease = 'lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL';
const trackingDates = `
  SELECT recorded_local_date FROM meals WHERE user_id=scope.user_id AND deleted_at IS NULL
  UNION ALL SELECT recorded_local_date FROM water_logs WHERE user_id=scope.user_id
  UNION ALL SELECT recorded_local_date FROM workout_sessions WHERE user_id=scope.user_id AND status='completed'
  UNION ALL SELECT recorded_local_date FROM activity_logs WHERE user_id=scope.user_id
  UNION ALL SELECT recorded_local_date FROM weight_logs WHERE user_id=scope.user_id
`;
const weeklyData = `EXISTS (SELECT 1 FROM (${trackingDates}) tracking
  WHERE recorded_local_date BETWEEN scope.week_start-7 AND scope.week_start-1)`;
const partialNutrition = `EXISTS (SELECT 1 FROM daily_tracking_status day
  WHERE day.user_id=scope.user_id AND day.category='nutrition'
    AND day.recorded_local_date=scope.local_day AND day.state='partial')`;
const inactivityEpisode = `(SELECT max(recorded_local_date) FROM (${trackingDates}) tracked)`;
const localScope = (user: string, instant: string) => `
  CROSS JOIN LATERAL (SELECT COALESCE(p.fixed_time_zone,pref.time_zone,'Asia/Manila') AS zone) timezone
  CROSS JOIN LATERAL (SELECT ${instant}::timestamptz AT TIME ZONE timezone.zone AS wall) calendar
  CROSS JOIN LATERAL (SELECT ${user} AS user_id, calendar.wall::date AS local_day,
    date_trunc('week',calendar.wall)::date AS week_start) scope
`;

type Occurrence = { user_id: string; type: string; revision: string; identity: string; zone: string; start: string; end: string };

async function expand(db: Pool, now: Date, recipient: string | null) {
  return transaction(db, async client => {
    const { rows: [lock] } = await client.query<{ held: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('fit-tempo-notification-expansion')) AS held",
    );
    if (!lock.held) return 0;
    const { rows } = await client.query<Occurrence>(`
      SELECT p.user_id,p.type,p.revision, occurrence.identity,timezone.zone,
        scope.local_day::text AS start,(scope.local_day+1)::text AS end
      FROM notification_preferences p JOIN users u ON u.id=p.user_id
      LEFT JOIN notification_settings s ON s.user_id=p.user_id
      LEFT JOIN user_preferences pref ON pref.user_id=p.user_id
      ${localScope('p.user_id', '$1')}
      CROSS JOIN LATERAL (
        SELECT 'day:'||scope.local_day AS identity WHERE p.type='meal_reminder' AND ${partialNutrition}
        UNION ALL SELECT 'week:'||(scope.week_start-7) WHERE p.type='weekly_summary'
          AND extract(dow FROM scope.local_day)=COALESCE(p.weekday,1) AND ${weeklyData}
        UNION ALL SELECT 'milestone:'||m.id FROM milestone_events m WHERE p.type='milestone'
          AND m.user_id=p.user_id AND m.occurred_at > $1::timestamptz-interval '2 days'
          AND m.occurred_at <= $1
        UNION ALL SELECT 'inactivity:'||episode.last_day FROM
          (SELECT ${inactivityEpisode} AS last_day) episode
          WHERE p.type='inactivity' AND episode.last_day <= scope.local_day-7
      ) occurrence
      WHERE p.enabled AND u.active AND u.verified_at IS NOT NULL
        AND NOT COALESCE(s.global_opt_out,false) AND ($2::text IS NULL OR u.email=$2)
        AND NOT EXISTS (SELECT 1 FROM notification_jobs j WHERE j.user_id=p.user_id
          AND j.type=p.type AND j.occurrence_identity=occurrence.identity)
      ORDER BY p.user_id,p.type,occurrence.identity LIMIT 32
    `, [now, recipient]);
    let inserted = 0;
    let previousOwner: string | undefined;
    for (const row of rows) {
      const due = resolveNotificationWallTime(row.start, '00:00', row.zone);
      const expires = resolveNotificationWallTime(row.end, '00:00', row.zone);
      if (due > now || expires <= now) continue;
      if (row.user_id !== previousOwner) {
        await lockSchedule(client, row.user_id);
        previousOwner = row.user_id;
      }
      const result = await client.query(`
        INSERT INTO notification_jobs(id,user_id,type,occurrence_identity,scheduled_at,expires_at,preference_revision)
        SELECT gen_random_uuid(),$1,$2,$3,$4,$5,$6
        WHERE EXISTS (SELECT 1 FROM notification_preferences p JOIN users u ON u.id=p.user_id
          WHERE p.user_id=$1 AND p.type=$2 AND p.enabled AND p.revision=$6 AND u.active AND u.verified_at IS NOT NULL)
        ON CONFLICT DO NOTHING
      `, [row.user_id, row.type, row.identity, due, expires, row.revision]);
      inserted += result.rowCount ?? 0;
    }
    // The cursor records the latest evaluation. A later run only expands its current window.
    if (!recipient) await client.query(`
      INSERT INTO scheduler_cursors(partition_key,evaluated_through) VALUES ('hobby-daily',$1)
      ON CONFLICT (partition_key) DO UPDATE SET
        evaluated_through=GREATEST(scheduler_cursors.evaluated_through,EXCLUDED.evaluated_through),updated_at=now()
    `, [now]);
    return inserted;
  });
}
async function recover(db: Pool, now: Date, recipient: string | null) {
  return db.query<{ status: string }>(`
    WITH targets AS (
      SELECT id FROM notification_jobs
      WHERE ((status IN ('leased','sending') AND lease_expires_at <= $1)
        OR (status IN ('pending','failed') AND expires_at <= $1))
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id=user_id AND u.email=$2))
      ORDER BY COALESCE(lease_expires_at,expires_at),id LIMIT 32 FOR UPDATE SKIP LOCKED
    ), recovered AS (
      UPDATE notification_jobs j SET status=CASE
        WHEN j.status='sending' THEN 'unknown'
        WHEN j.expires_at <= $1 THEN 'expired'
        WHEN j.attempts > 0 THEN 'failed'
        ELSE 'pending' END,
        retry_at=CASE WHEN j.status='leased' AND j.expires_at>$1 AND j.attempts>0 THEN $1 END,
        ${releaseLease},updated_at=$1
      FROM targets WHERE j.id=targets.id RETURNING j.*
    ), logged AS (
      INSERT INTO notification_logs(id,user_id,job_id,template_key,subject_key,attempt_number,
        status,scheduled_at,error_category,idempotency_key)
      SELECT gen_random_uuid(),user_id,id,type,type,attempts,'unknown',scheduled_at,'sending_lease_expired',id||':'||attempts
      FROM recovered WHERE status='unknown' AND attempts>0 ON CONFLICT (job_id,attempt_number) DO NOTHING
    )
    SELECT status FROM recovered
  `, [now, recipient]);
}

async function claim(db: Pool, now: Date, runId: string, recipient: string | null) {
  const { rows: [job] } = await db.query<Job>(`
    WITH target AS (
      SELECT id FROM notification_jobs
      WHERE (status='pending' OR (status='failed' AND retry_at IS NOT NULL))
        AND COALESCE(retry_at,scheduled_at)<=$1 AND expires_at>$1 AND attempts<$4
        AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id=user_id AND u.email=$6))
      ORDER BY COALESCE(retry_at,scheduled_at),id LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE notification_jobs j SET status='leased',lease_owner=$2,lease_token=$3,
      lease_expires_at=$1::timestamptz+make_interval(secs=>$5),updated_at=$1
    FROM target WHERE j.id=target.id
    RETURNING j.id,j.user_id,j.type,j.attempts,j.lease_token
  `, [now, runId, randomUUID(), attemptLimit, leaseSeconds, recipient]);
  return job;
}

async function prepare(db: Pool, job: Job, options: Options, now: Date) {
  return transaction(db, async client => {
    await lockSchedule(client, job.user_id);
    const { rows: [candidate] } = await client.query<{ email: string; quiet: boolean; eligible: boolean; expired: boolean }>(`
      SELECT u.email, j.expires_at <= $3 AS expired,
        COALESCE(u.active AND u.verified_at IS NOT NULL AND p.enabled
          AND p.revision=j.preference_revision AND NOT COALESCE(s.global_opt_out,false)
          AND j.type=ANY($4::text[]) AND ($5::text IS NULL OR u.email=$5)
          AND CASE j.type
            WHEN 'meal_reminder' THEN ${partialNutrition}
            WHEN 'weekly_summary' THEN ${weeklyData}
              AND (j.occurrence_identity NOT LIKE 'week:%' OR j.occurrence_identity='week:'||(scope.week_start-7))
            WHEN 'milestone' THEN EXISTS (SELECT 1 FROM milestone_events m
              WHERE m.user_id=j.user_id AND j.occurrence_identity='milestone:'||m.id)
            WHEN 'inactivity' THEN j.occurrence_identity='inactivity:'||${inactivityEpisode}
            ELSE false END, false) AS eligible,
        COALESCE(CASE WHEN hours.start_at < hours.end_at
          THEN local.clock>=hours.start_at AND local.clock<hours.end_at
          WHEN hours.start_at > hours.end_at
          THEN local.clock>=hours.start_at OR local.clock<hours.end_at ELSE false END,false) AS quiet
      FROM notification_jobs j JOIN users u ON u.id=j.user_id
      LEFT JOIN notification_preferences p ON p.user_id=j.user_id AND p.type=j.type
      LEFT JOIN notification_settings s ON s.user_id=j.user_id
      LEFT JOIN user_preferences pref ON pref.user_id=j.user_id
      ${localScope('j.user_id', '$3')}
      CROSS JOIN LATERAL (SELECT calendar.wall::time AS clock) local
      CROSS JOIN LATERAL (SELECT COALESCE(s.quiet_start,p.quiet_start) AS start_at, COALESCE(s.quiet_end,p.quiet_end) AS end_at) hours
      WHERE j.id=$1 AND j.lease_token=$2 AND j.status='leased' AND j.lease_expires_at>$3
      FOR UPDATE OF j
    `, [job.id, job.lease_token, now, types, options.recipientFilter ?? null]);
    if (!candidate) return { outcome: 'skipped' } as const;
    if (candidate.expired || !candidate.eligible) {
      await client.query(`UPDATE notification_jobs SET status=$3,retry_at=NULL,${releaseLease},updated_at=$4
        WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, candidate.expired ? 'expired' : 'cancelled', now]);
      return { outcome: candidate.expired ? 'expired' : 'skipped' } as const;
    }
    if (candidate.quiet) {
      await client.query(`UPDATE notification_jobs SET status='failed',retry_at=$3::timestamptz+interval '30 minutes',
        ${releaseLease},updated_at=$3 WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, now]);
      return { outcome: 'skipped' } as const;
    }
    // Capacity is reserved outside of the database transaction.
    if (!options.dryRun) {
      await client.query(`UPDATE notification_jobs SET status='sending',attempts=attempts+1,retry_at=NULL,
        lease_expires_at=$3::timestamptz+make_interval(secs=>$4),updated_at=$3
        WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, now, leaseSeconds]);
    }
    return { outcome: 'send', to: candidate.email } as const;
  });
}

async function unclaim(db: Pool, job: Job, now: Date) {
  await db.query(`UPDATE notification_jobs SET status=CASE WHEN attempts>0 THEN 'failed' ELSE 'pending' END,
    ${releaseLease},updated_at=$3 WHERE id=$1 AND lease_token=$2 AND status='leased'`, [job.id, job.lease_token, now]);
}

async function finalize(db: Pool, job: Job, result: Result, now: Date) {
  const status = result === 'accepted' || result === 'unknown' ? result : 'failed';
  const finished = await db.query(`
    WITH finished AS (
      UPDATE notification_jobs SET status=$3,${releaseLease},updated_at=$4,
        retry_at=CASE WHEN $5 AND attempts<$6 AND expires_at>$7 THEN $7 END
      WHERE id=$1 AND lease_token=$2 AND status='sending' RETURNING *
    )
    INSERT INTO notification_logs(id,user_id,job_id,template_key,subject_key,attempt_number,
      status,scheduled_at,accepted_at,error_category,idempotency_key)
    SELECT gen_random_uuid(),user_id,id,type,type,attempts,$3,scheduled_at,
      CASE WHEN $3='accepted' THEN $4::timestamptz END,$8,id||':'||attempts FROM finished
  `, [job.id, job.lease_token, status, now, result === 'retryable', attemptLimit,
    new Date(now.getTime() + 60_000 * 2 ** job.attempts + Math.floor(Math.random() * 10000)),
    result === 'accepted' ? null : result]);
  return finished.rowCount === 1 ? status : 'skipped';
}

export async function runNotificationDispatch(db: Pool, options: Options) {
  const start = Date.now();
  const now = options.now ?? (() => new Date());
  const recipient = options.recipientFilter ?? null;
  const runId = randomUUID();
  const summary = { runId, evaluated: 0, enqueued: 0, accepted: 0, skipped: 0, failed: 0, unknown: 0, expired: 0, remaining: 0, elapsedMs: 0 };
  if (!options.dryRun) {
    summary.enqueued = await expand(db, now(), recipient);
    const recovered = await recover(db, now(), recipient);
    for (const { status } of recovered.rows) {
      if (status === 'unknown' || status === 'expired') summary[status]++;
    }
    for (let index = 0; index < batchSize && Date.now() - start < 10_000; index++) {
      const job = await claim(db, now(), runId, recipient);
      if (!job) break;
      summary.evaluated++;
      if (!await options.reserve().catch(() => false)) {
        await unclaim(db, job, now());
        break;
      }
      const ready = await prepare(db, job, options, now());
      if (ready.outcome !== 'send') {
        summary[ready.outcome]++;
        continue;
      }
      const result = await options.send({ to: ready.to, type: job.type }).catch(() => 'unknown' as const);
      summary[await finalize(db, job, result, now())]++;
    }
  }
  const { rows: [backlog] } = await db.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM notification_jobs WHERE (status='pending' OR (status='failed' AND retry_at IS NOT NULL))
        AND COALESCE(retry_at,scheduled_at)<=$1 AND expires_at>$1
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id=user_id AND u.email=$2))
        LIMIT 1000
    ) due`, [now(), recipient]);
  summary.remaining = backlog.count;
  summary.elapsedMs = Date.now() - start;
  return summary;
}
