import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  aggregateDay, dashboardFixtures, decimalSchema, localDateAt, localDateSchema,
  positiveDecimalSchema, syntheticDashboardDates, timeZoneSchema,
} from '@fit-tempo/contracts';

const profilePatch = z.strictObject({
  displayName: z.string().trim().min(1).max(120).optional(),
  heightCm: positiveDecimalSchema.nullable().optional(),
}).refine(value => Object.keys(value).length > 0);
const preferencesPatch = z.strictObject({
  timeZone: timeZoneSchema.optional(),
  massUnit: z.enum(['kg', 'lb']).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
}).refine(value => Object.keys(value).length > 0);
const dashboardQuery = z.strictObject({ date: localDateSchema.optional() });

type Profile = { displayName: string | null; heightCm: string | null };
type Preferences = {
  timeZone: string;
  massUnit: 'kg' | 'lb';
  theme: 'system' | 'light' | 'dark';
};
const defaultPreferences: Preferences = { timeZone: 'Asia/Manila', massUnit: 'kg', theme: 'system' };
const preferencesColumns = 'time_zone AS "timeZone", mass_unit AS "massUnit", theme';
const profileColumns = 'display_name AS "displayName", trim_scale(height_cm)::text AS "heightCm"';

function invalid(res: Response, message: string) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, requestId: res.locals.requestId } });
}

function nutrient(value: unknown) {
  const result = decimalSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function createProfileRouter(db: Pool, synthetic: boolean) {
  const router = Router();

  async function readPreferences(userId: string) {
    const result = await db.query<Preferences>(`SELECT ${preferencesColumns} FROM user_preferences WHERE user_id = $1`, [userId]);
    return result.rows[0] ?? defaultPreferences;
  }

  router.get('/profile', async (_req, res) => {
    const result = await db.query<Profile>(`SELECT ${profileColumns} FROM profiles WHERE user_id = $1`, [res.locals.userId]);
    res.json({ data: result.rows[0] ?? { displayName: null, heightCm: null } });
  });

  router.patch('/profile', async (req, res) => {
    const parsed = profilePatch.safeParse(req.body);
    if (!parsed.success) return invalid(res, 'Enter a display name and a valid height in centimeters.');
    const { displayName, heightCm } = parsed.data;
    const result = await db.query<Profile>(`
      INSERT INTO profiles (user_id, display_name, height_cm)
      VALUES ($1, COALESCE($2, 'Fit Tempo member'), $3)
      ON CONFLICT (user_id) DO UPDATE SET
        display_name = COALESCE($2, profiles.display_name),
        height_cm = CASE WHEN $4::boolean THEN $3 ELSE profiles.height_cm END,
        updated_at = now()
      RETURNING ${profileColumns}
    `, [res.locals.userId, displayName ?? null, heightCm ?? null, heightCm !== undefined]);
    return res.json({ data: result.rows[0] });
  });

  router.get('/preferences', async (_req, res) => {
    res.json({ data: await readPreferences(res.locals.userId) });
  });

  router.patch('/preferences', async (req, res) => {
    const parsed = preferencesPatch.safeParse(req.body);
    if (!parsed.success) return invalid(res, 'Enter a supported time zone, mass unit, or theme.');
    const { timeZone, massUnit, theme } = parsed.data;
    const result = await db.query<Preferences>(`
      INSERT INTO user_preferences (user_id, time_zone, mass_unit, theme)
      VALUES ($1, COALESCE($2, 'Asia/Manila'), COALESCE($3, 'kg'), COALESCE($4, 'system'))
      ON CONFLICT (user_id) DO UPDATE SET
        time_zone = COALESCE($2, user_preferences.time_zone),
        mass_unit = COALESCE($3, user_preferences.mass_unit),
        theme = COALESCE($4, user_preferences.theme),
        updated_at = now()
      RETURNING ${preferencesColumns}
    `, [res.locals.userId, timeZone ?? null, massUnit ?? null, theme ?? null]);
    return res.json({ data: result.rows[0] });
  });

  router.get('/dashboard', async (req, res) => {
    const parsed = dashboardQuery.safeParse(req.query);
    if (!parsed.success) return invalid(res, 'Enter a valid dashboard date (YYYY-MM-DD).');
    const userId: string = res.locals.userId;
    const meta = { mode: synthetic ? 'synthetic-demo' : 'local', fixtureDates: synthetic ? syntheticDashboardDates : [] };
    if (synthetic) {
      const fixture = dashboardFixtures[parsed.data.date ?? syntheticDashboardDates[0]];
      if (!fixture) return invalid(res, 'Choose one of the example dates.');
      return res.json({ data: aggregateDay(fixture), meta });
    }

    const preferences = await readPreferences(userId);
    const date = parsed.data.date ?? localDateAt(new Date().toISOString(), preferences.timeZone);
    const result = await db.query<{
      status: 'unrecorded' | 'partial' | 'complete' | null;
      entry_count: number | null;
      timezone: string | null;
      meal_id: string | null;
      item_id: string | null;
      calories: unknown;
      protein: unknown;
    }>(`
      WITH scope AS (SELECT $1::uuid AS owner, $2::date AS day)
      SELECT status.state AS status, status.entry_count,
        COALESCE(status.recorded_time_zone, meal.recorded_time_zone) AS timezone,
        meal.id AS meal_id, item.id AS item_id,
        item.nutrition_snapshot #> '{consumedNutrients,energyKcal}' AS calories,
        item.nutrition_snapshot #> '{consumedNutrients,proteinG}' AS protein
      FROM scope
      LEFT JOIN daily_tracking_status status ON status.user_id = scope.owner
        AND status.recorded_local_date = scope.day AND status.category = 'nutrition'
      LEFT JOIN meals meal ON meal.user_id = scope.owner AND meal.recorded_local_date = scope.day
        AND meal.deleted_at IS NULL
      LEFT JOIN meal_items item ON item.meal_id = meal.id
      ORDER BY meal.occurred_at, meal.id, item.id
    `, [userId, date]);
    const first = result.rows[0];
    const items = result.rows.filter(row => row.item_id).map(row => ({
      calories: nutrient(row.calories),
      protein: nutrient(row.protein),
    }));
    const hasEntries = Boolean(first?.meal_id || first?.entry_count);
    const status = first?.status === 'complete' ? 'complete' : hasEntries ? 'partial' : 'unrecorded';
    return res.json({ data: aggregateDay({
      date, timezone: first?.timezone ?? preferences.timeZone, status, items, hasEntries,
    }), meta });
  });

  return router;
}
