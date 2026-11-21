import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { lockSchedule } from './schedule.js';

const notificationTypes = z.enum([
  'workout_reminder', 'meal_reminder', 'hydration_reminder', 'weekly_summary', 'milestone', 'inactivity',
]);
type NotificationType = z.infer<typeof notificationTypes>;
type SchedulerMode = 'manual-dry-run' | 'hobby-daily';
const intraday = new Set<NotificationType>(['workout_reminder', 'hydration_reminder']);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const updateSchema = z.strictObject({
  revision: z.number().int().min(0).max(9007199254740990),
  globalOptOut: z.boolean(),
  quietStart: clock.nullable(),
  quietEnd: clock.nullable(),
  enabled: z.record(notificationTypes, z.boolean()),
}).refine(value => value.quietStart === null ? value.quietEnd === null : value.quietEnd !== null && value.quietStart !== value.quietEnd);

type Settings = {
  timeZone: string;
  globalOptOut: boolean;
  quietStart: string | null;
  quietEnd: string | null;
  revision: string;
  enabled: Partial<Record<NotificationType, boolean>>;
};

async function readSettings(db: Pool | PoolClient, owner: string, mode: SchedulerMode) {
  const { rows: [row] } = await db.query<Settings>(`
    SELECT COALESCE(p.time_zone,'Asia/Manila') AS "timeZone",
           COALESCE(s.global_opt_out,false) AS "globalOptOut",
           to_char(s.quiet_start,'HH24:MI') AS "quietStart",
           to_char(s.quiet_end,'HH24:MI') AS "quietEnd",
           COALESCE(s.revision,0) AS revision,
           COALESCE((SELECT jsonb_object_agg(n.type,n.enabled)
             FROM notification_preferences n WHERE n.user_id=$1),'{}') AS enabled
    FROM users u
    LEFT JOIN user_preferences p ON p.user_id=u.id
    LEFT JOIN notification_settings s ON s.user_id=u.id
    WHERE u.id=$1`, [owner]);
  const { enabled, revision, ...settings } = row;
  const data = {
    mode,
    ...settings,
    revision: Number(revision),
    types: notificationTypes.options.map(type => ({ type, supported: !intraday.has(type), enabled: !intraday.has(type) && (enabled[type] ?? false) })),
    nextSendAt: null,
  };
  return { data, enabled };
}

async function cancelJobs(client: PoolClient, owner: string, types: NotificationType[]) {
  await client.query(`
    UPDATE notification_jobs SET status='cancelled',retry_at=NULL,lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,updated_at=now()
    WHERE user_id=$1 AND type=ANY($2::text[]) AND status IN ('pending','leased','failed')
  `, [owner, types]);
}

// Caller holds the same account schedule lock used by preference and workout edits.
export async function invalidateNotificationTimeZone(client: PoolClient, owner: string) {
  await client.query(`
    INSERT INTO notification_settings(user_id,revision) VALUES ($1,1)
    ON CONFLICT (user_id) DO UPDATE SET revision=notification_settings.revision+1
  `, [owner]);
  await client.query('UPDATE notification_preferences SET revision=revision+1,updated_at=now() WHERE user_id=$1', [owner]);
  await cancelJobs(client, owner, notificationTypes.options);
}

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message, requestId: res.locals.requestId } });
}

export function createNotificationsRouter(db: Pool, mode: SchedulerMode) {
  const router = Router();
  router.get('/', async (_req, res) => {
    const { data } = await readSettings(db, res.locals.userId, mode);
    return res.json({ data });
  });

  router.put('/', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Enter valid notification settings and distinct quiet-hour endpoints.');
    const { revision, globalOptOut, quietStart, quietEnd, enabled } = parsed.data;
    if ([...intraday].some(type => enabled[type])) {
      return fail(res, 400, 'SCHEDULER_UNSUPPORTED', 'This scheduler does not support intraday reminders.');
    }
    const owner: string = res.locals.userId;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await lockSchedule(client, owner);
      const { data: current, enabled: stored } = await readSettings(client, owner, mode);
      if (current.revision !== revision) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'REVISION_CONFLICT', 'Notification settings changed. Refresh and try again.');
      }
      const quietChanged = quietStart !== current.quietStart || quietEnd !== current.quietEnd;
      const globalChanged = current.globalOptOut !== globalOptOut;
      const changedTypes = notificationTypes.options.filter(type => (stored[type] ?? false) !== enabled[type]);
      if (quietChanged || globalChanged || changedTypes.length > 0) {
        await client.query(`
          INSERT INTO notification_settings(user_id,global_opt_out,quiet_start,quiet_end,revision)
          VALUES ($1,$2,$3,$4,1)
          ON CONFLICT (user_id) DO UPDATE SET global_opt_out=EXCLUDED.global_opt_out,
            quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,revision=notification_settings.revision+1
        `, [owner, globalOptOut, quietStart, quietEnd]);
        for (const type of notificationTypes.options) {
          await client.query(`
            INSERT INTO notification_preferences(id,user_id,type,enabled,quiet_start,quiet_end)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT(user_id,type) DO UPDATE SET enabled=EXCLUDED.enabled,
              quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,
              revision=notification_preferences.revision+1,updated_at=now()
            WHERE $7 OR (notification_preferences.enabled,notification_preferences.quiet_start,notification_preferences.quiet_end)
              IS DISTINCT FROM (EXCLUDED.enabled,EXCLUDED.quiet_start,EXCLUDED.quiet_end)
          `, [randomUUID(), owner, type, enabled[type], quietStart, quietEnd, globalChanged]);
        }
      }
      const cancelledTypes = globalOptOut || globalChanged || quietChanged ? notificationTypes.options : changedTypes;
      if (cancelledTypes.length > 0) await cancelJobs(client, owner, cancelledTypes);
      const { data } = await readSettings(client, owner, mode);
      await client.query('COMMIT');
      return res.json({ data });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
  return router;
}
