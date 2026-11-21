import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export const notificationCronPath = '/api/cron/process-notifications';

export function createNotificationCron(secret: string | undefined, run?: () => Promise<object>): RequestHandler {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = secret ? digest(`Bearer ${secret}`) : undefined;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.sendStatus(405);
    if (!expected || !timingSafeEqual(digest(req.get('authorization') ?? ''), expected)) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
    }
    if (!run) return res.status(503).json({ error: { code: 'DISPATCH_UNAVAILABLE' } });
    return res.json({ data: await run() });
  };
}
