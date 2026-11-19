import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

export type RedisCommands = { sendCommand(command: string[]): Promise<RedisReply> };
type Options = {
  redis: RedisCommands;
  verifiedUserId?: (request: Request) => Promise<string | undefined> | string | undefined;
};
const ip = (request: Request) => `ip:${ipKeyGenerator(request.ip ?? 'unknown', 56)}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const userKey = (options: Options) => async (request: Request) => {
  const id = await options.verifiedUserId?.(request);
  return id ? `user:${id}` : ip(request);
};
const accountKey = (request: Request) => {
  const value = request.body?.email;
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? `account:${digest(value.trim().toLowerCase())}` : ip(request);
};

/** One store per limiter; atomic Redis increments share counters across API instances. */
export function createLimiters(options: Options) {
  const make = (name: string, windowMs: number, limit: number,
    keyGenerator: (request: Request) => string | Promise<string>): RequestHandler => {
    const middleware = rateLimit({
      windowMs, limit, keyGenerator, standardHeaders: 'draft-8', legacyHeaders: false,
      passOnStoreError: false,
      store: new RedisStore({ prefix: `fit-tempo:limit:${name}:`,
        sendCommand: (...command: string[]) => options.redis.sendCommand(command) }),
      handler: (_request: Request, response: Response) => {
        response.status(429).json({ error: { code: 'RATE_LIMITED',
          message: 'Too many requests. Please try again later.', requestId: response.locals.requestId } });
      },
    });
    // A Redis outage is dependency failure, not a quota decision.
    return (request, response, next) => {
      const unavailable = () => {
        if (!response.headersSent) response.status(503).json({ error: { code: 'DEPENDENCY_UNAVAILABLE',
          message: 'The request limit service is temporarily unavailable.', requestId: response.locals.requestId } });
      };
      try {
        Promise.resolve(middleware(request, response, (cause?: unknown) => {
          if (cause) unavailable();
          else next();
        })).catch(unavailable);
      } catch { unavailable(); }
    };
  };
  return {
    coarseIp: make('coarse-ip', 60_000, 300, ip),
    api: make('api-user', 60_000, 120, userKey(options)),
    loginIp: make('login-ip', 15 * 60_000, 10, ip),
    loginAccount: make('login-account', 15 * 60_000, 5, accountKey),
    search: make('search', 60_000, 20, userKey(options)),
    ai: make('ai-user-day', 86_400_000, 3, userKey(options)),
    emailMinute: make('email-recipient-minute', 60_000, 1, accountKey),
    emailHour: make('email-recipient-hour', 60 * 60_000, 5, accountKey),
  };
}
