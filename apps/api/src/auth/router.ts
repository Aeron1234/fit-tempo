import { createHmac, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Router, raw, type Request, type RequestHandler, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { deriveReplacement, equalHash, hashToken, opaqueToken, signAccess, verifyAccess } from './crypto.js';
import type { AccountEmailSender } from './mailbox.js';
import type { createPrivateStorageService } from '../storage/index.js';

type Options = {
  db: Pool;
  sender: AccountEmailSender;
  jwtSecret: string;
  csrfSecret: string;
  frontendUrl: string;
  production: boolean;
  limits?: { loginIp: RequestHandler; loginAccount: RequestHandler;
    emailMinute: RequestHandler; emailHour: RequestHandler; api: RequestHandler; search?: RequestHandler };
  storage?: ReturnType<typeof createPrivateStorageService>;
  profile?: ReturnType<typeof Router>;
  food?: ReturnType<typeof Router>;
  manualFood?: ReturnType<typeof Router>;
  meals?: ReturnType<typeof Router>;
  ingredients?: ReturnType<typeof Router>;
  planner?: ReturnType<typeof Router>;
  exercises?: ReturnType<typeof Router>;
  workouts?: ReturnType<typeof Router>;
  schedule?: ReturnType<typeof Router>;
  activity?: ReturnType<typeof Router>;
  hydration?: ReturnType<typeof Router>;
  analytics?: ReturnType<typeof Router>;
  admin?: ReturnType<typeof Router>;
  notifications?: ReturnType<typeof Router>;
  foodRecognition?: ReturnType<typeof Router>;
};
type Identity = { id: string; sessionId: string; role: 'trainee' | 'admin' };
const credentials = z.strictObject({ email: z.email().max(320), password: z.string().min(12).max(256) });
const tokenInput = z.strictObject({ token: z.string().min(32).max(256) });
const cookie = (request: Request, name: string) => request.headers.cookie?.split(';').map((part) => part.trim())
  .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const nowPlus = (ms: number) => new Date(Date.now() + ms);
const error = (response: Response, status: number, code: string, message: string) =>
  response.status(status).json({ error: { code, message, requestId: response.locals.requestId } });
const generic = { data: { accepted: true } };

export function createAuthRouter(options: Options) {
  if (options.jwtSecret.length < 32 || options.csrfSecret.length < 32) throw new Error('Auth secrets require at least 32 characters.');
  if (options.production && 'messages' in options.sender) throw new Error('Test mailbox is forbidden in production.');
  const router = Router();
  if (options.limits) router.use(options.limits.api);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const prefix = options.production ? '__Host-fitness_' : 'fitness_dev_';
  const accessName = `${prefix}access`, refreshName = `${prefix}refresh`, csrfName = `${prefix}csrf`;
  const cookieOptions = { httpOnly: true, secure: options.production, sameSite: 'lax' as const, path: '/' };
  const clear = (res: Response) => {
    for (const name of [accessName, refreshName, csrfName]) res.clearCookie(name, cookieOptions);
  };
  const csrfSignature = (nonce: string, sid: string) => createHmac('sha256', options.csrfSecret)
    .update(`${nonce}:${sid}`).digest('base64url');
  const issueCsrf = (res: Response, sid = 'anonymous') => {
    const nonce = opaqueToken();
    const token = `${nonce}.${csrfSignature(nonce, sid)}`;
    res.cookie(csrfName, token, { ...cookieOptions, maxAge: 30 * 60_000 });
    return token;
  };
  async function current(req: Request): Promise<Identity | null> {
    const access = cookie(req, accessName);
    if (!access) return null;
    try {
      const claims = await verifyAccess(access, options.jwtSecret);
      const result = await options.db.query<{ id: string; session_id: string; role_code: 'trainee' | 'admin' }>(
        `SELECT u.id, s.id AS session_id, u.role_code FROM sessions s
         JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND u.id=$2 AND u.active=true
         AND u.verified_at IS NOT NULL AND s.revoked_at IS NULL
         AND s.idle_expires_at>now() AND s.absolute_expires_at>now()`,
        [claims.sessionId, claims.userId]);
      const row = result.rows[0];
      return row ? { id: row.id, sessionId: row.session_id, role: row.role_code } : null;
    } catch { return null; }
  }
  async function refreshSession(req: Request): Promise<string | undefined> {
    const refresh = cookie(req, refreshName);
    if (!refresh) return undefined;
    const matched = await options.db.query<{ session_id: string }>(
      `SELECT rt.session_id FROM refresh_tokens rt JOIN sessions s ON s.id=rt.session_id
       JOIN users u ON u.id=s.user_id
       WHERE rt.token_hash=$1 AND rt.expires_at>now() AND s.revoked_at IS NULL
       AND s.idle_expires_at>now() AND s.absolute_expires_at>now()
       AND u.active=true AND u.verified_at IS NOT NULL`, [hashToken(refresh)]);
    return matched.rows[0]?.session_id;
  }
  async function csrf(req: Request, res: Response, next: (err?: unknown) => void) {
    if (req.headers.origin !== new URL(options.frontendUrl).origin) return error(res, 403, 'CSRF_INVALID', 'Invalid request origin.');
    const supplied = req.header('x-csrf-token');
    const stored = cookie(req, csrfName);
    if (!supplied || !stored || supplied !== stored) return error(res, 403, 'CSRF_INVALID', 'Invalid CSRF token.');
    const [nonce, mac] = supplied.split('.');
    if (!nonce || !mac) return error(res, 403, 'CSRF_INVALID', 'Invalid CSRF token.');
    const identity = await current(req);
    const boundSession = identity?.sessionId ?? await refreshSession(req);
    const expected = csrfSignature(nonce, boundSession ?? 'anonymous');
    if (!equalHash(mac, expected)) return error(res, 403, 'CSRF_INVALID', 'Invalid CSRF token.');
    next();
  }
  function setSession(res: Response, access: string, refresh: string, sid: string) {
    res.cookie(accessName, access, { ...cookieOptions, maxAge: 10 * 60_000 });
    res.cookie(refreshName, refresh, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60_000 });
    issueCsrf(res, sid);
  }
  async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await options.db.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (cause) { await client.query('ROLLBACK'); throw cause; }
    finally { client.release(); }
  }
  async function issuePurpose(userId: string, purpose: 'verify_email' | 'reset_password') {
    const token = opaqueToken();
    await options.db.query(`INSERT INTO verification_tokens(id,user_id,purpose,token_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), userId, purpose, hashToken(token),
      nowPlus(purpose === 'verify_email' ? 86_400_000 : 900_000)]);
    return token;
  }
  async function sendPurpose(userId: string, email: string, purpose: 'verify_email' | 'reset_password') {
    const token = await issuePurpose(userId, purpose);
    const path = purpose === 'verify_email' ? '/verify-email' : '/reset-password';
    await options.sender.send({ to: email, kind: purpose,
      url: `${new URL(options.frontendUrl).origin}${path}?token=${encodeURIComponent(token)}` });
  }
  async function issueSession(client: PoolClient, userId: string) {
    const sid = randomUUID(), family = randomUUID(), refresh = opaqueToken();
    await client.query(`INSERT INTO sessions(id,user_id,idle_expires_at,absolute_expires_at)
      VALUES ($1,$2,$3,$4)`, [sid, userId, nowPlus(7 * 86_400_000), nowPlus(30 * 86_400_000)]);
    await client.query(`INSERT INTO refresh_tokens(id,session_id,family_id,token_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), sid, family, hashToken(refresh), nowPlus(30 * 86_400_000)]);
    return { sid, refresh };
  }

  router.get('/csrf', async (req, res) => res.json({ data: {
    csrfToken: issueCsrf(res, (await current(req))?.sessionId ?? await refreshSession(req)),
  } }));
  // Scanner-safe landing requests: no token is consumed on GET.
  router.get('/verify-email', (_req, res) => res.json({ data: { action: 'POST_REQUIRED' } }));
  router.get('/reset-password', (_req, res) => res.json({ data: { action: 'POST_REQUIRED' } }));

  router.post('/register', ...(options.limits ? [options.limits.loginIp, options.limits.emailHour] : []), csrf, async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return error(res, 400, 'VALIDATION_ERROR', 'Invalid registration details.');
    const email = parsed.data.email.trim().toLowerCase();
    const hash = await argon2.hash(parsed.data.password, { type: argon2.argon2id });
    const id = randomUUID();
    const created = await options.db.query(`INSERT INTO users(id,email,password_hash,role_code)
      VALUES ($1,$2,$3,'trainee') ON CONFLICT(email) DO NOTHING RETURNING id,email`, [id, email, hash]);
    if (created.rows[0]) {
      try { await sendPurpose(created.rows[0].id, created.rows[0].email, 'verify_email'); }
      catch { /* Keep the generic response. An explicit resend can issue another link. */ }
    }
    return res.status(202).json(generic);
  });
  router.post('/resend-verification', ...(options.limits ? [options.limits.emailMinute, options.limits.emailHour] : []), csrf, async (req, res) => {
    const parsed = z.strictObject({ email: z.email() }).safeParse(req.body);
    if (!parsed.success) return error(res, 400, 'VALIDATION_ERROR', 'Invalid email.');
    const found = await options.db.query<{ id: string; email: string }>(
      'SELECT id,email FROM users WHERE email=$1 AND active=true AND verified_at IS NULL', [parsed.data.email.toLowerCase()]);
    if (found.rows[0]) {
      try { await sendPurpose(found.rows[0].id, found.rows[0].email, 'verify_email'); }
      catch { /* Preserve a generic response; delivery retry/monitoring is a later adapter concern. */ }
    }
    return res.status(202).json(generic);
  });
  router.post('/verify-email', csrf, async (req, res) => {
    const parsed = tokenInput.safeParse(req.body);
    if (!parsed.success) return error(res, 400, 'VALIDATION_ERROR', 'Invalid token.');
    const changed = await transaction(async (client) => {
      const token = await client.query<{ id: string; user_id: string }>(
        `SELECT id,user_id FROM verification_tokens WHERE token_hash=$1 AND purpose='verify_email'
         AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [hashToken(parsed.data.token)]);
      if (!token.rows[0]) return false;
      const active = await client.query('UPDATE users SET verified_at=COALESCE(verified_at,now()) WHERE id=$1 AND active=true RETURNING id', [token.rows[0].user_id]);
      if (!active.rowCount) return false;
      await client.query('UPDATE verification_tokens SET consumed_at=now() WHERE id=$1', [token.rows[0].id]);
      return true;
    });
    return changed ? res.json(generic) : error(res, 400, 'VALIDATION_ERROR', 'Invalid or expired token.');
  });
  router.post('/login', ...(options.limits ? [options.limits.loginIp, options.limits.loginAccount] : []), csrf, async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return error(res, 400, 'VALIDATION_ERROR', 'Invalid credentials.');
    const found = await options.db.query<{ id: string; password_hash: string }>(
      'SELECT id,password_hash FROM users WHERE email=$1 AND active=true AND verified_at IS NOT NULL',
      [parsed.data.email.trim().toLowerCase()]);
    const user = found.rows[0];
    if (!user || !(await argon2.verify(user.password_hash, parsed.data.password)))
      return error(res, 401, 'UNAUTHENTICATED', 'Invalid credentials.');
    const session = await transaction(async client => {
      const eligible = await client.query(
        'SELECT id FROM users WHERE id=$1 AND active AND verified_at IS NOT NULL AND password_hash=$2 FOR UPDATE',
        [user.id, user.password_hash],
      );
      return eligible.rowCount ? issueSession(client, user.id) : null;
    });
    if (!session) return error(res, 401, 'UNAUTHENTICATED', 'Invalid credentials.');
    setSession(res, await signAccess(user.id, session.sid, options.jwtSecret), session.refresh, session.sid);
    return res.json({ data: { authenticated: true } });
  });
  router.post('/refresh', csrf, async (req, res) => {
    const old = cookie(req, refreshName);
    if (!old) return error(res, 401, 'UNAUTHENTICATED', 'Session unavailable.');
    const refreshed = await transaction(async (client) => {
      const result = await client.query<{ id: string; session_id: string; family_id: string; user_id: string; consumed_at: Date | null; replacement_id: string | null }>(
        `SELECT rt.id,rt.session_id,rt.family_id,s.user_id,rt.consumed_at,rt.replacement_id
         FROM refresh_tokens rt JOIN sessions s ON s.id=rt.session_id JOIN users u ON u.id=s.user_id
         WHERE rt.token_hash=$1 AND rt.expires_at>now() AND s.revoked_at IS NULL
         AND s.idle_expires_at>now() AND s.absolute_expires_at>now()
         AND u.active=true AND u.verified_at IS NOT NULL FOR UPDATE OF rt`, [hashToken(old)]);
      const row = result.rows[0];
      if (!row) return null;
      const replacement = deriveReplacement(old, options.csrfSecret);
      if (row.consumed_at) {
        // A bounded grace window recovers a lost response or second tab without revoking a legitimate session.
        if (row.replacement_id && Date.now() - new Date(row.consumed_at).getTime() <= 10_000) {
          const existing = await client.query('SELECT id FROM refresh_tokens WHERE id=$1 AND token_hash=$2',
            [row.replacement_id, hashToken(replacement)]);
          if (existing.rowCount) return { sid: row.session_id, userId: row.user_id, refresh: replacement };
        }
        await client.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [row.session_id]);
        return null;
      }
      const nextId = randomUUID();
      await client.query(`INSERT INTO refresh_tokens(id,session_id,family_id,token_hash,expires_at)
        VALUES ($1,$2,$3,$4,(SELECT absolute_expires_at FROM sessions WHERE id=$2))`,
      [nextId, row.session_id, row.family_id, hashToken(replacement)]);
      await client.query('UPDATE refresh_tokens SET consumed_at=now(),replacement_id=$2 WHERE id=$1', [row.id, nextId]);
      await client.query(`UPDATE sessions SET idle_expires_at=LEAST(absolute_expires_at,now()+interval '7 days') WHERE id=$1`, [row.session_id]);
      return { sid: row.session_id, userId: row.user_id, refresh: replacement };
    });
    if (!refreshed) { clear(res); return error(res, 401, 'UNAUTHENTICATED', 'Session unavailable.'); }
    setSession(res, await signAccess(refreshed.userId, refreshed.sid, options.jwtSecret), refreshed.refresh, refreshed.sid);
    return res.json({ data: { authenticated: true } });
  });
  router.post('/logout', csrf, async (req, res) => {
    const identity = await current(req);
    const sid = identity?.sessionId ?? await refreshSession(req);
    if (sid) await options.db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [sid]);
    clear(res);
    return res.json(generic);
  });
  router.get('/me', async (req, res) => {
    const identity = await current(req);
    return identity ? res.json({ data: { id: identity.id, role: identity.role } })
      : error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
  });
  if (options.profile) {
    router.use('/phase09', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (req.method === 'PATCH') return csrf(req, res, next);
      next();
    }, options.profile);
  }
  if (options.food && options.manualFood) {
    const requireFoodIdentity: RequestHandler = async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      next();
    };
    router.use('/phase10/catalog', requireFoodIdentity, ...(options.limits?.search ? [options.limits.search] : []), options.food);
    router.use('/phase10/manual', requireFoodIdentity, csrf, options.manualFood);
  }
  if (options.meals) {
    router.use('/phase11', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.meals);
  }
  if (options.ingredients) {
    router.use('/phase12', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.ingredients);
  }
  if (options.planner) {
    router.use('/phase13', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.planner);
  }
  if (options.exercises) {
    router.use('/phase14', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.exercises);
  }
  if (options.workouts) {
    router.use('/phase15', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.workouts);
  }
  if (options.schedule) {
    router.use('/phase16', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.schedule);
  }
  if (options.activity) {
    router.use('/phase17', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.activity);
  }
  if (options.hydration) {
    router.use('/phase18', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.hydration);
  }
  if (options.foodRecognition) {
    router.use('/phase19', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.foodRecognition);
  }
  if (options.analytics) {
    router.use('/phase20', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.analytics);
  }
  if (options.notifications) {
    router.use('/phase22/notification-preferences', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.notifications);
  }
  if (options.admin) {
    router.use('/phase24', async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      if (identity.role !== 'admin') return error(res, 403, 'FORBIDDEN', 'Admin role required.');
      res.locals.userId = identity.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return csrf(req, res, next);
      next();
    }, options.admin);
  }
  router.get('/admin-check', async (req, res) => {
    const identity = await current(req);
    if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
    return identity.role === 'admin' ? res.json({ data: { authorized: true } })
      : error(res, 403, 'FORBIDDEN', 'Admin role required.');
  });
  if (options.storage) {
    const service = options.storage;
    const uploadInput = z.strictObject({
      kind: z.enum(['food_photo', 'profile_image', 'progress_photo']),
      mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
      declaredBytes: z.number().int().positive(),
    });
    const fileId = z.uuid();
    const storageError = (res: Response, cause: unknown) => {
      if (cause && typeof cause === 'object' && 'status' in cause && 'code' in cause &&
          typeof cause.status === 'number' && typeof cause.code === 'string')
        return error(res, cause.status, cause.code, cause instanceof Error ? cause.message : 'File unavailable.');
      throw cause;
    };
    router.post('/files/grants', csrf, async (req, res) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      const input = uploadInput.safeParse(req.body);
      if (!input.success) return error(res, 400, 'VALIDATION_ERROR', 'Invalid upload request.');
      try { return res.status(201).json({ data: await service.authorize({ userId: identity.id, ...input.data }) }); }
      catch (cause) { return storageError(res, cause); }
    });
    const imageBody = raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' });
    router.put('/files/:id/content', csrf, async (req, res, next) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      if (!fileId.safeParse(req.params.id).success) return error(res, 404, 'NOT_FOUND', 'File unavailable.');
      const mimeType = req.headers['content-type']?.split(';')[0]?.toLowerCase();
      if (!uploadInput.shape.mimeType.safeParse(mimeType).success)
        return error(res, 400, 'INVALID_FILE_TYPE', 'Only JPEG, PNG and WebP are supported.');
      imageBody(req, res, (cause) => {
        if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 413)
          return error(res, 413, 'FILE_TOO_LARGE', 'The file exceeds the upload limit.');
        if (cause) return next(cause);
        if (!Buffer.isBuffer(req.body)) return error(res, 400, 'INVALID_IMAGE', 'Image bytes required.');
        service.receiveUpload({ userId: identity.id, id: req.params.id as string,
          mimeType: mimeType as 'image/jpeg' | 'image/png' | 'image/webp', bytes: req.body })
          .then(() => res.status(204).end()).catch((failure: unknown) => storageError(res, failure));
      });
    });
    router.post('/files/:id/finalize', csrf, async (req, res) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      if (!fileId.safeParse(req.params.id).success) return error(res, 404, 'NOT_FOUND', 'File unavailable.');
      try { return res.json({ data: await service.finalize({ userId: identity.id, id: req.params.id as string }) }); }
      catch (cause) { return storageError(res, cause); }
    });
    router.get('/files/:id/access', async (req, res) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      if (!fileId.safeParse(req.params.id).success) return error(res, 404, 'NOT_FOUND', 'File unavailable.');
      try { return res.json({ data: await service.access(identity.id, req.params.id as string) }); }
      catch (cause) { return storageError(res, cause); }
    });
    router.delete('/files/:id', csrf, async (req, res) => {
      const identity = await current(req);
      if (!identity) return error(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
      if (!fileId.safeParse(req.params.id).success) return error(res, 404, 'NOT_FOUND', 'File unavailable.');
      try { await service.remove(identity.id, req.params.id as string); return res.status(204).end(); }
      catch (cause) { return storageError(res, cause); }
    });
  }
  router.post('/forgot-password', ...(options.limits ? [options.limits.emailMinute, options.limits.emailHour] : []), csrf, async (req, res) => {
    const parsed = z.strictObject({ email: z.email() }).safeParse(req.body);
    if (!parsed.success) return error(res, 400, 'VALIDATION_ERROR', 'Invalid email.');
    const found = await options.db.query<{ id: string; email: string }>(
      'SELECT id,email FROM users WHERE email=$1 AND active=true', [parsed.data.email.trim().toLowerCase()]);
    if (found.rows[0]) {
      try { await sendPurpose(found.rows[0].id, found.rows[0].email, 'reset_password'); }
      catch { /* Never reveal account existence through sender availability. */ }
    }
    return res.status(202).json(generic);
  });
  router.post('/reset-password', csrf, async (req, res) => {
    const parsed = z.strictObject({ token: tokenInput.shape.token, password: credentials.shape.password }).safeParse(req.body);
    if (!parsed.success) return error(res, 400, 'VALIDATION_ERROR', 'Invalid reset request.');
    const hash = await argon2.hash(parsed.data.password, { type: argon2.argon2id });
    const changed = await transaction(async (client) => {
      const token = await client.query<{ id: string; user_id: string }>(
        `SELECT id,user_id FROM verification_tokens WHERE token_hash=$1 AND purpose='reset_password'
         AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [hashToken(parsed.data.token)]);
      if (!token.rows[0]) return false;
      const active = await client.query('UPDATE users SET password_hash=$2 WHERE id=$1 AND active=true RETURNING id', [token.rows[0].user_id, hash]);
      if (!active.rowCount) return false;
      await client.query('UPDATE verification_tokens SET consumed_at=now() WHERE id=$1', [token.rows[0].id]);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [token.rows[0].user_id]);
      return true;
    });
    if (changed) {
      clear(res);
      return res.json(generic);
    }
    return error(res, 400, 'VALIDATION_ERROR', 'Invalid or expired token.');
  });
  return router;
}
