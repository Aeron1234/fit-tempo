import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { aggregateDay, analyticsQuerySchema, localDateAt, localDateSchema, type AnalyticsWeek } from '@fit-tempo/contracts';
import { readNutritionDays } from './nutrition-metrics.js';

const dayMs = 86_400_000;
function dayOffset(date: string, days: number) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * dayMs).toISOString().slice(0, 10);
}
function weekStart(date: string) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return dayOffset(date, -((day + 6) % 7));
}

const scale = 1_000_000n;
function fixed(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));
}
function decimal(value: bigint) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % scale).toString().padStart(6, '0').replace(/0+$/, '');
  return sign + absolute / scale + (fraction ? '.' + fraction : '');
}
function sum(values: (string | null)[]) {
  const known = values.filter((value): value is string => value !== null);
  return known.length ? known.reduce((total, value) => total + fixed(value), 0n) : null;
}
function average(total: bigint | null, days: number) {
  return total === null || days === 0 ? null : decimal((total + BigInt(days) / 2n) / BigInt(days));
}
function asDecimal(total: bigint | null) { return total === null ? null : decimal(total); }

type Workout = { date: string; ended_at: Date | null; actual_duration_seconds: number | null; overlaps_earlier: boolean };
type Water = { date: string; amount: string | null };
type Activity = { date: string; linked_workout_id: string | null; duration_seconds: number | null; distance: string | null };
type Weight = { date: string; kg: string; measured_at: Date };
type Records = { nutrition: ReturnType<typeof aggregateDay>[]; water: Water[]; workouts: Workout[]; activity: Activity[]; weights: Weight[] };

export function summarizeWeek(from: string, to: string, timeZone: string, records: Records): AnalyticsWeek {
  const contains = ({ date }: { date: string }) => date >= from && date <= to;
  const nutritionByDay = new Map(records.nutrition.filter(contains).map(day => [day.date, day]));
  const waterByDay = new Map(records.water.filter(contains).map(day => [day.date, day.amount]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = dayOffset(from, i);
    return { date, nutrition: nutritionByDay.get(date) ?? aggregateDay({ date, timezone: timeZone, status: 'unrecorded', items: [] }),
      waterMl: waterByDay.get(date) ?? null };
  });
  const loggedDays = days.filter(day => day.nutrition.status !== 'unrecorded').length;
  const nutrient = (key: 'calories' | 'protein') => {
    const daily = days.map(day => day.nutrition[key]);
    const total = sum(daily.map(day => day.knownSubtotal));
    return { knownSubtotal: asDecimal(total), average: average(total, loggedDays),
      missingItemCount: daily.reduce((total, day) => total + day.missingItemCount, 0),
      knownDays: daily.filter(day => day.knownSubtotal !== null).length };
  };
  const waterDays = days.filter(day => day.waterMl !== null).length;
  const waterTotal = sum(days.map(day => day.waterMl));
  const standalone = records.activity.filter(row => contains(row) && row.linked_workout_id === null);
  const activityTimes = standalone.flatMap(row => row.duration_seconds === null ? [] : [row.duration_seconds]);
  const activityDistances = standalone.map(row => row.distance);
  const weights = records.weights.filter(contains).sort((a, b) => a.measured_at.getTime() - b.measured_at.getTime());
  const start = weights.find(row => row.date <= dayOffset(from, 2));
  const end = weights.findLast(row => row.date >= dayOffset(to, -2));
  // Active time pauses have no timeline. Exclude later overlaps rather than estimate their active intervals.
  const sessions = records.workouts.filter(contains);
  let durationSeconds: number | null = null;
  let overlapCount = 0;
  let missingDurationCount = 0;
  for (const session of sessions) {
    if (session.actual_duration_seconds === null || (session.ended_at === null && session.actual_duration_seconds > 0)) {
      missingDurationCount++;
    } else if (session.overlaps_earlier) {
      overlapCount++;
    } else {
      durationSeconds = (durationSeconds ?? 0) + session.actual_duration_seconds;
    }
  }
  return {
    from, to, days,
    nutrition: { loggedDays, calories: nutrient('calories'), protein: nutrient('protein') },
    hydration: { loggedDays: waterDays, totalMl: asDecimal(waterTotal), averageMl: average(waterTotal, waterDays) },
    workouts: { completedCount: sessions.length, durationSeconds, missingDurationCount, overlapCount },
    activity: { standaloneCount: standalone.length,
      linkedExcludedCount: records.activity.filter(row => contains(row) && row.linked_workout_id !== null).length,
      durationSeconds: activityTimes.length ? activityTimes.reduce((total, time) => total + time, 0) : null,
      distanceMeters: asDecimal(sum(activityDistances)), missingDurationCount: standalone.length - activityTimes.length,
      missingDistanceCount: activityDistances.filter(distance => distance === null).length },
    weight: { start: start ? { date: start.date, kg: start.kg } : null, end: end ? { date: end.date, kg: end.kg } : null,
      changeKg: start && end && start.date < end.date ? decimal(fixed(end.kg) - fixed(start.kg)) : null },
  };
}

// Future template consumers get the same typed totals and coverage, without individual daily entries.
export function weeklyEmailMetrics({ days: _dailyEntries, ...summary }: AnalyticsWeek) {
  void _dailyEntries;
  return summary;
}

async function readRecords(db: PoolClient, owner: string, from: string, to: string, timeZone: string): Promise<Records> {
  const bounds = [owner, from, to];
  const nutrition = await readNutritionDays(db, owner, from, to, timeZone);
  const water = await db.query<Water>(`
    SELECT scope.day::date::text AS date,
      CASE WHEN sum(log.amount_ml) IS NOT NULL THEN trim_scale(sum(log.amount_ml))::text
        WHEN status.state='complete' THEN '0' END AS amount
    FROM generate_series($2::date::timestamp,$3::date::timestamp,interval '1 day') scope(day)
    LEFT JOIN water_logs log ON log.user_id=$1 AND log.recorded_local_date=scope.day::date
    LEFT JOIN daily_tracking_status status ON status.user_id=$1 AND status.recorded_local_date=scope.day::date
      AND status.category='hydration'
    GROUP BY scope.day,status.state
  `, bounds);
  const workouts = await db.query<Workout>(`
    SELECT w.recorded_local_date::text AS date, w.ended_at, w.actual_duration_seconds,
      (w.ended_at > w.started_at AND EXISTS (
        SELECT 1 FROM workout_sessions earlier
        WHERE earlier.user_id=w.user_id AND earlier.status='completed'
          AND (earlier.started_at, earlier.id) < (w.started_at, w.id)
          AND earlier.ended_at > w.started_at
      )) AS overlaps_earlier
    FROM workout_sessions w
    WHERE w.user_id=$1 AND w.recorded_local_date BETWEEN $2 AND $3 AND w.status='completed'
    ORDER BY w.started_at,w.id
  `, bounds);
  const activity = await db.query<Activity>(`
    SELECT recorded_local_date::text AS date, linked_workout_id, duration_seconds, trim_scale(distance_meters)::text AS distance
    FROM activity_logs WHERE user_id=$1 AND recorded_local_date BETWEEN $2 AND $3
  `, bounds);
  const weights = await db.query<Weight>(`
    SELECT recorded_local_date::text AS date, trim_scale(weight_kg)::text AS kg, measured_at
    FROM weight_logs WHERE user_id=$1 AND recorded_local_date BETWEEN $2 AND $3 ORDER BY measured_at,id
  `, bounds);
  return { nutrition, water: water.rows, workouts: workouts.rows, activity: activity.rows, weights: weights.rows };
}

export function createAnalyticsRouter(db: Pool) {
  const router = Router();
  router.get('/analytics', async (req, res, next) => {
    const query = analyticsQuerySchema.safeParse(req.query);
    const invalid = () => res.status(400).json({ error: {
      code: 'VALIDATION_ERROR', message: 'Choose a complete Monday–Sunday week before the current local week.', requestId: res.locals.requestId,
    } });
    if (!query.success || Boolean(query.data.from) !== Boolean(query.data.to)) return invalid();
    const owner: string = res.locals.userId;
    const client = await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const preferences = await client.query<{ time_zone: string }>('SELECT time_zone FROM user_preferences WHERE user_id=$1', [owner]);
      const timeZone = preferences.rows[0]?.time_zone ?? 'Asia/Manila';
      const currentLocalWeek = weekStart(localDateAt(new Date().toISOString(), timeZone));
      const from = query.data.from ?? dayOffset(currentLocalWeek, -7);
      const to = query.data.to ?? dayOffset(from, 6);
      const preceding = dayOffset(from, -7);
      if (!localDateSchema.safeParse(preceding).success || from !== weekStart(from) || to !== dayOffset(from, 6) || to >= currentLocalWeek) {
        await client.query('ROLLBACK');
        return invalid();
      }
      const records = await readRecords(client, owner, preceding, to, timeZone);
      const data = { timeZone, current: summarizeWeek(from, to, timeZone, records),
        previous: summarizeWeek(preceding, dayOffset(from, -1), timeZone, records) };
      await client.query('COMMIT');
      return res.json({ data });
    } catch (error) {
      await client.query('ROLLBACK');
      return next(error);
    } finally {
      client.release();
    }
  });
  return router;
}
