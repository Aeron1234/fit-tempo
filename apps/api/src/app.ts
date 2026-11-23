import { createHash, randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { healthResponseSchema } from "@fit-tempo/contracts";
import { readEnvironment } from "./config/env.js";
import { createNotificationsRouter } from './notifications.js';
import { createNotificationCron, notificationCronPath } from './notification-cron.js';
import { createNotificationEmailSender } from './notification-emailjs.js';
import { createAdminRouter } from './admin.js';

export const config = readEnvironment();
export const app = express();
let runNotificationCron: (() => Promise<object>) | undefined;
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
        ai: config.AI_ADAPTER !== "disabled",
        email: config.EMAIL_ADAPTER,
        scheduler: config.SCHEDULER_MODE,
      },
    },
  });

  response.json(payload);
});

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
  let reserveEmail: (() => Promise<boolean>) | undefined;
  let reserveRecognition: ((owner: string) => Promise<boolean>) | undefined;
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
    if (config.EMAIL_ADAPTER === 'emailjs') {
      const scope = createHash('sha256').update(config.EMAILJS_PUBLIC_KEY!).digest('hex');
      reserveEmail = async () => redis.isReady && await redis
        .withCommandOptions({ abortSignal: AbortSignal.timeout(1000) })
        .set(`fit-tempo:emailjs:pace:${scope}`, '1', { NX: true, PX: 1100 }) === 'OK';
    }
    takeProviderBudget = async provider => {
      const count = await redis.eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return count",
        { keys: [`fit-tempo:food-provider:${provider}`], arguments: [] },
      );
      return typeof count === 'number' && count <= (provider === 'off' ? 7 : 10);
    };
    reserveRecognition = async owner => {
      const bucket = new Date().toISOString().slice(0, 10);
      const scope = `fit-tempo:{fixture-recognition}:${bucket}`;
      const reserved = await redis.eval(
        `if tonumber(redis.call('GET', KEYS[1]) or '0') >= 3 or
            tonumber(redis.call('GET', KEYS[2]) or '0') >= 30 then return 0 end
          for i = 1, 2 do
            if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], 172800) end
          end
          return 1`,
        { keys: [`${scope}:user:${owner}`, `${scope}:project`], arguments: [] },
      );
      return reserved === 1;
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
  const [{ createProfileRouter }, { createFoodRouter }, { createManualFoodRouter }, { createMealsRouter }, { createIngredientsRouter }, { createPlannerRouter }, { createExercisesRouter }, { createWorkoutsRouter }, { createScheduleRouter }, { createActivityRouter }, { createHydrationRouter }, { createFoodRecognitionRouter, createGroqFoodRecognizer }, { createAnalyticsRouter }] = await Promise.all([
    import('./profile.js'), import('./food/index.js'), import('./manual-food.js'), import('./meals.js'), import('./ingredients.js'), import('./planner.js'), import('./exercises.js'), import('./workouts.js'), import('./schedule.js'), import('./activity.js'), import('./hydration.js'), import('./food-recognition.js'), import('./analytics.js'),
  ]);
  let sender: Parameters<typeof createAuthRouter>[0]['sender'];
  if (config.EMAIL_ADAPTER === 'emailjs') {
    const { createEmailJsAccountSender, EmailJsAccountSendError } = await import('./auth/emailjs.js');
    const emailjs = createEmailJsAccountSender({
      serviceId: config.EMAILJS_SERVICE_ID!,
      publicKey: config.EMAILJS_PUBLIC_KEY!,
      privateKey: config.EMAILJS_PRIVATE_KEY!,
      verifyTemplateId: config.EMAILJS_VERIFY_TEMPLATE_ID!,
      resetTemplateId: config.EMAILJS_RESET_TEMPLATE_ID!,
      reserve: reserveEmail!,
    });
    sender = {
      async send(message) {
        try {
          await emailjs.send(message);
          console.info('EmailJS account email accepted', message.kind);
        } catch (error) {
          console.warn('EmailJS account email', message.kind,
            error instanceof EmailJsAccountSendError ? error.outcome : 'unknown',
            error instanceof EmailJsAccountSendError ? error.providerStatus ?? '' : '');
          throw error;
        }
      },
    };
  } else {
    sender = createTestMailbox(config.NODE_ENV === 'production');
  }
  if (config.CRON_SECRET) {
    const { runNotificationDispatch } = await import('./notification-dispatch.js');
    const recipient = config.NOTIFICATION_TEST_RECIPIENT;
    const send = recipient ? createNotificationEmailSender({
      serviceId: config.EMAILJS_SERVICE_ID!,
      publicKey: config.EMAILJS_PUBLIC_KEY!,
      privateKey: config.EMAILJS_PRIVATE_KEY!,
      templateId: config.EMAILJS_REMINDER_TEMPLATE_ID!,
      summaryTemplateId: config.EMAILJS_SUMMARY_TEMPLATE_ID!,
      recipient,
      frontendUrl: config.FRONTEND_URL,
    }) : async () => 'unknown' as const;
    runNotificationCron = async () => {
      const result = await runNotificationDispatch(db, {
        dryRun: !recipient,
        recipientFilter: recipient,
        reserve: reserveEmail ?? (async () => false),
        send,
      });
      console.info('Notification cron completed', { dryRun: !recipient, ...result });
      return result;
    };
  }
  const authRouter = createAuthRouter({
      db,
      sender,
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
      planner: createPlannerRouter(db),
      exercises: createExercisesRouter(db),
      workouts: createWorkoutsRouter(db),
      schedule: createScheduleRouter(db),
      activity: createActivityRouter(db),
      hydration: createHydrationRouter(db),
      analytics: createAnalyticsRouter(db),
      admin: createAdminRouter(db),
      notifications: createNotificationsRouter(db, config.SCHEDULER_MODE),
      foodRecognition: createFoodRecognitionRouter({
        mode: config.AI_ADAPTER === 'disabled' ? 'disabled' : 'synthetic',
        reserve: reserveRecognition,
        recognize: config.AI_ADAPTER === 'groq-synthetic'
          ? createGroqFoodRecognizer({ apiKey: config.GROQ_API_KEY!, model: config.GROQ_MODEL! })
          : undefined,
      }),
    });
  app.use('/api/v1/auth', (request, response, next) => {
    if (/^\/(?:files|phase09|phase10|phase11|phase12|phase13|phase14|phase15|phase16|phase17|phase18|phase19|phase20|phase22|phase24)(?:\/|$)/i.test(request.path)) return response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'This API route is unavailable.', requestId: response.locals.requestId },
    });
    return authRouter(request, response, next);
  });
  app.use('/api/v1/foods', (request, response, next) => {
    if (request.method !== 'GET') return next();
    request.url = '/phase10/catalog' + (request.path === '/' ? '/search' + request.url.slice(1) : request.url);
    return authRouter(request, response, next);
  });
  app.use('/api/v1/admin', (request, response, next) => {
    request.url = '/phase24' + request.url;
    return authRouter(request, response, next);
  });
  app.get('/api/v1/exercises', (request, response, next) => {
    request.url = '/phase14/exercises' + request.url.slice(request.path.length);
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
    if (/^\/(?:meal-plans|shopping-list)(?:\/|$)/.test(path)) {
      request.url = '/phase13' + request.url;
      return authRouter(request, response, next);
    }
    if (/^\/(?:exercises|routines)(?:\/|$)/.test(path)) {
      request.url = '/phase14' + request.url;
      return authRouter(request, response, next);
    }
    if (/^\/workout-sessions(?:\/|$)/.test(path)) {
      request.url = '/phase15' + request.url;
      return authRouter(request, response, next);
    }
    if (/^\/(?:availability|scheduled-workouts|schedule-proposals)(?:\/|$)/.test(path)) {
      request.url = '/phase16' + request.url;
      return authRouter(request, response, next);
    }
    if (/^\/(?:activity|weight|measurements)(?:\/|$)/.test(path)) {
      request.url = '/phase17' + request.url;
      return authRouter(request, response, next);
    }
    if (/^\/(?:water|goals|milestones|streak)(?:\/|$)/.test(path)) {
      request.url = '/phase18' + request.url;
      return authRouter(request, response, next);
    }
    if (/^\/ai\/food-suggestions(?:\/fixtures\/[a-z0-9-]+)?$/.test(path)) {
      request.url = '/phase19' + request.url;
      return authRouter(request, response, next);
    }
    if (path === '/analytics') {
      request.url = '/phase20' + request.url;
      return authRouter(request, response, next);
    }
    if (path === '/notification-preferences') {
      request.url = '/phase22' + request.url;
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

app.all(notificationCronPath, createNotificationCron(config.CRON_SECRET, runNotificationCron));

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
