import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { healthResponseSchema } from "@fit-tempo/contracts";
import { readEnvironment } from "./config/env.js";

export const config = readEnvironment();
export const app = express();
app.use(express.json({ limit: "32kb" }));

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.locals.requestId = randomUUID();
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.get("/api/v1/health", (_request, response) => {
  const payload = healthResponseSchema.parse({
    data: {
      status: "ok",
      service: "fit-tempo-api",
      mode: config.APP_MODE,
      capabilities: {
        ai: false,
        email: "test-mailbox",
        scheduler: "manual-dry-run",
      },
    },
  });

  response.json(payload);
});

// The local adapter is injected only when all auth configuration is present.
// Production fails closed in the environment parser until a real sender is connected.
if (config.DATABASE_URL && config.JWT_ACCESS_SECRET && config.CSRF_SECRET) {
  const [{ Pool }, { createAuthRouter }, { createTestMailbox }] =
    await Promise.all([
      import("pg"),
      import("./auth/router.js"),
      import("./auth/mailbox.js"),
    ]);
  const db = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
  let storage: Parameters<typeof createAuthRouter>[0]['storage'];
  if (config.STORAGE_BUCKET && config.STORAGE_REGION && config.STORAGE_ACCESS_KEY && config.STORAGE_SECRET_KEY) {
    const [{ createPrivateStorageService }, { createPgFileMetadata }, { createSupabasePrivateObjects }] =
      await Promise.all([import('./storage/index.js'), import('./storage-pg.js'), import('./storage-supabase.js')]);
    storage = createPrivateStorageService({
      metadata: createPgFileMetadata(db),
      objects: createSupabasePrivateObjects({ bucket: config.STORAGE_BUCKET, region: config.STORAGE_REGION,
        endpoint: config.STORAGE_ENDPOINT!,
        credentials: { accessKeyId: config.STORAGE_ACCESS_KEY, secretAccessKey: config.STORAGE_SECRET_KEY } }),
    });
  }
  let limits;
  let takeProviderBudget: ((provider: 'usda' | 'off') => Promise<boolean>) | undefined;
  if (config.REDIS_URL) {
    const [{ createClient }, { createLimiters }, { verifyAccess }] =
      await Promise.all([
        import("redis"),
        import("./limits/index.js"),
        import("./auth/crypto.js"),
      ]);
    const redis = createClient({
      url: config.REDIS_URL,
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (retries: number) =>
          retries > 3
            ? new Error("Redis unavailable")
            : Math.min(100 * retries, 500),
      },
    });
    redis.on("error", () => {
      /* Limiter store rejects requests while unavailable. */
    });
    await redis.connect();
    takeProviderBudget = async provider => {
      const count = await redis.eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return count",
        { keys: [`fit-tempo:food-provider:${provider}`], arguments: [] },
      );
      return typeof count === 'number' && count <= (provider === 'off' ? 7 : 10);
    };
    limits = createLimiters({
      redis: { sendCommand: (command) => redis.sendCommand(command) },
      verifiedUserId: async (request) => {
        const name =
          config.NODE_ENV === "production"
            ? "__Host-fitness_access"
            : "fitness_dev_access";
        const token = request.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${name}=`))
          ?.slice(name.length + 1);
        if (!token) return undefined;
        try {
          const claims = await verifyAccess(token, config.JWT_ACCESS_SECRET!);
          const active = await db.query(
            `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.id=$1 AND u.id=$2 AND s.revoked_at IS NULL AND s.idle_expires_at>now()
            AND s.absolute_expires_at>now() AND u.active=true AND u.verified_at IS NOT NULL`,
            [claims.sessionId, claims.userId],
          );
          return active.rowCount ? claims.userId : undefined;
        } catch {
          return undefined;
        }
      },
    });
    app.use("/api/v1/auth", limits.coarseIp);
  }
  const [{ createProfileRouter }, { createFoodRouter }, { createManualFoodRouter }, { createMealsRouter }, { createIngredientsRouter }] = await Promise.all([
    import('./profile.js'), import('./food/index.js'), import('./manual-food.js'), import('./meals.js'), import('./ingredients.js'),
  ]);
  const authRouter = createAuthRouter({
      db,
      sender: createTestMailbox(config.NODE_ENV === "production"),
      jwtSecret: config.JWT_ACCESS_SECRET!,
      csrfSecret: config.CSRF_SECRET!,
      frontendUrl: config.FRONTEND_URL,
      production: config.NODE_ENV === "production",
      limits,
      storage,
      profile: createProfileRouter(db, config.APP_MODE === 'synthetic-demo'),
      food: createFoodRouter({
        db,
        usdaApiKey: config.FOOD_ADAPTER === 'live' ? config.USDA_API_KEY : undefined,
        openFoodFacts: config.FOOD_ADAPTER === 'live' && Boolean(config.OPEN_FOOD_FACTS_USER_AGENT),
        openFoodFactsUserAgent: config.OPEN_FOOD_FACTS_USER_AGENT,
        takeProviderBudget,
      }),
      manualFood: createManualFoodRouter(db),
      meals: createMealsRouter(db),
      ingredients: createIngredientsRouter(db),
    });
  app.use('/api/v1/auth', (request, response, next) => {
    if (/^\/(?:files|phase09|phase10|phase11|phase12)(?:\/|$)/i.test(request.path)) return response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'This API route is unavailable.', requestId: response.locals.requestId },
    });
    return authRouter(request, response, next);
  });
  app.use('/api/v1/foods', (request, response, next) => {
    if (request.method !== 'GET') return next();
    request.url = '/phase10/catalog' + (request.path === '/' ? '/search' + request.url.slice(1) : request.url);
    return authRouter(request, response, next);
  });
  app.use('/api/v1/me', (request, response, next) => {
    const path = request.path;
    if (path === '/foods' && request.method === 'POST') {
      request.url = '/phase10/manual';
      return authRouter(request, response, next);
    }
    if (['/profile', '/preferences', '/dashboard'].includes(path)) {
      request.url = '/phase09' + request.url;
      return authRouter(request, response, next);
    }
    if (/^\/(?:meals|tracking-days)(?:\/|$)/.test(path)) {
      request.url = '/phase11' + request.url;
      return authRouter(request, response, next);
    }
    if (/^\/(?:recipes|pantry|ingredient-prices)(?:\/|$)/.test(path)) {
      request.url = '/phase12' + request.url;
      return authRouter(request, response, next);
    }
    if (!storage) return next();
    if (path === '/uploads/authorize') request.url = '/files/grants';
    else if (/^\/uploads\/[0-9a-f-]+\/(?:finalize|content)$/.test(path)) request.url = path.replace('/uploads/', '/files/');
    else if (/^\/files\/[0-9a-f-]+(?:\/access)?$/.test(path)) request.url = path;
    else return next();
    return authRouter(request, response, next);
  });
}

app.use((_request, response) => {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "This API route is unavailable.",
      requestId: response.locals.requestId,
    },
  });
});

const handleError: ErrorRequestHandler = (
  _error,
  _request,
  response,
  _next,
) => {
  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
      requestId: response.locals.requestId,
    },
  });
};

app.use(handleError);

export default app;
