import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { readNutritionDays } from './nutrition-metrics.js';
import { invalidateNotificationTimeZone } from './notifications.js';
import {
  aggregateDay, dashboardFixtures, localDateAt, localDateSchema,
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
    const owner: string = res.locals.userId;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let oldTimeZone: string | undefined;
      if (timeZone !== undefined) {
        await client.query('INSERT INTO schedule_revisions (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [owner]);
        await client.query('SELECT revision FROM schedule_revisions WHERE user_id=$1 FOR UPDATE', [owner]);
        const previous = await client.query<Preferences>(`SELECT ${preferencesColumns} FROM user_preferences WHERE user_id=$1`, [owner]);
        oldTimeZone = (previous.rows[0] ?? defaultPreferences).timeZone;
      }
      const result = await client.query<Preferences>(`
      INSERT INTO user_preferences (user_id, time_zone, mass_unit, theme)
      VALUES ($1, COALESCE($2, 'Asia/Manila'), COALESCE($3, 'kg'), COALESCE($4, 'system'))
      ON CONFLICT (user_id) DO UPDATE SET
        time_zone = COALESCE($2, user_preferences.time_zone),
        mass_unit = COALESCE($3, user_preferences.mass_unit),
        theme = COALESCE($4, user_preferences.theme),
        updated_at = now()
      RETURNING ${preferencesColumns}
      `, [owner, timeZone ?? null, massUnit ?? null, theme ?? null]);
      if (timeZone !== undefined && oldTimeZone !== timeZone) {
        await client.query('UPDATE schedule_revisions SET revision=revision+1, updated_at=now() WHERE user_id=$1', [owner]);
        await invalidateNotificationTimeZone(client, owner);
      }
      await client.query('COMMIT');
      return res.json({ data: result.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    const [day] = await readNutritionDays(db, userId, date, date, preferences.timeZone);
    return res.json({ data: day, meta });
  });

  return router;
}
