import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { POSTGRES_SCHEMA_DDL } from '../server/db/drizzle-schema';
import { createPostgresClientDb, type DbClient } from '../server/db/postgres';
import { runScheduledJob } from '../server/jobs';
import { getFeatureFlags } from '../server/modules/featureFlags';
import { createAdDeliveryRouter, getPublisherSdkScript, type AdEventQueueMessage } from '../server/routes/adDelivery';
import { createAdvertiserRouter } from '../server/routes/advertiser';
import { createLoomaIntegrationRouter } from '../server/routes/loomaIntegration';
import { createPublicAndAuthRouter } from '../server/routes/publicAndAuth';
import { createPublisherRouter } from '../server/routes/publisher';
import { FX_RATES } from '../server/security';
import { seedDatabaseIfEmpty } from '../server/seed';
import { executeAppRouterOnHono } from './honoBridge';
import { createR2MediaStorage } from './r2Storage';

export interface WorkerEnv {
  ASSETS: Fetcher;
  MEDIA_BUCKET: R2Bucket;
  EVENT_QUEUE: Queue<AdEventQueueMessage>;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  ADMIN_ORIGIN?: string;
  ADMIN_PASSCODE?: string;
  LOOMA_SESSION_SECRET?: string;
  LOOMA_TRACKING_SECRET?: string;
  LOOMA_SSO_SHARED_SECRET?: string;
  LOOMA_ADAPTER_KEY?: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_WEBHOOK_SECRET?: string;
  FLUTTERWAVE_SECRET_KEY?: string;
  FLUTTERWAVE_WEBHOOK_HASH?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  EMAIL_WEBHOOK_URL?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  ALLOW_SANDBOX_DEPOSITS?: string;
  ALLOW_SANDBOX_VERIFICATION?: string;
}

const ENV_STRING_KEYS: Array<keyof WorkerEnv> = [
  'DATABASE_URL',
  'ADMIN_ORIGIN',
  'ADMIN_PASSCODE',
  'LOOMA_SESSION_SECRET',
  'LOOMA_TRACKING_SECRET',
  'LOOMA_SSO_SHARED_SECRET',
  'LOOMA_ADAPTER_KEY',
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_WEBHOOK_SECRET',
  'FLUTTERWAVE_SECRET_KEY',
  'FLUTTERWAVE_WEBHOOK_HASH',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'EMAIL_WEBHOOK_URL',
  'EMAIL_API_KEY',
  'EMAIL_FROM',
  'ALLOW_SANDBOX_DEPOSITS',
  'ALLOW_SANDBOX_VERIFICATION',
];

export const MEDIA_EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

let isolateBootstrappedKey: string | null = null;

export function syncWorkerEnvToProcessEnv(env: Partial<WorkerEnv>): void {
  process.env.LOOMA_RUNTIME = 'cloudflare-worker';
  for (const key of ENV_STRING_KEYS) {
    const val = env[key];
    if (typeof val === 'string' && val.length > 0) {
      process.env[key] = val;
    }
  }
}

export function resolveWorkerConnectionString(env: Partial<WorkerEnv>): string {
  return env.HYPERDRIVE?.connectionString?.trim() || env.DATABASE_URL?.trim() || '';
}

async function openWorkerDb(env: Partial<WorkerEnv>): Promise<DbClient> {
  const connStr = resolveWorkerConnectionString(env);
  if (!connStr) {
    const err = new Error('Database connection is not configured. Bind Hyperdrive or set DATABASE_URL secret.') as Error & {
      status?: number;
    };
    err.status = 503;
    throw err;
  }

  const needsBootstrap = isolateBootstrappedKey !== connStr;
  const db = await createPostgresClientDb(connStr, { ensureSchema: false });
  if (needsBootstrap) {
    try {
      const check = await db.queryOne<{ roles_cnt: number; settings_cnt: number }>(
        'SELECT (SELECT COUNT(*) FROM roles) AS roles_cnt, (SELECT COUNT(*) FROM platform_settings) AS settings_cnt'
      );
      if (!check || Number(check.roles_cnt) === 0 || Number(check.settings_cnt) === 0) {
        await db.exec(POSTGRES_SCHEMA_DDL);
        await seedDatabaseIfEmpty(db);
      }
    } catch {
      await db.exec(POSTGRES_SCHEMA_DDL);
      await seedDatabaseIfEmpty(db);
    }
    isolateBootstrappedKey = connStr;
  }
  return db;
}

export async function withWorkerDb<T>(env: Partial<WorkerEnv>, fn: (db: DbClient) => Promise<T>): Promise<T> {
  const db = await openWorkerDb(env);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

export function createWorkerApp() {
  const app = new Hono<{ Bindings: WorkerEnv }>();

  app.use('*', async (c, next) => {
    syncWorkerEnvToProcessEnv(c.env);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });

  app.onError((err, c) => {
    const path = new URL(c.req.url).pathname;
    console.error(`[worker] Unhandled error on ${path}:`, err);
    if (path.startsWith('/api') || path.startsWith('/sdk')) {
      const errObj = err as { status?: number; message?: string };
      const status = typeof errObj?.status === 'number' && errObj.status >= 400 && errObj.status < 600 ? errObj.status : 500;
      const message =
        status >= 500
          ? status === 503
            ? 'Service temporarily unavailable'
            : 'Internal server error'
          : err instanceof Error
            ? err.message
            : 'Request failed';
      return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 413 | 500 | 503);
    }
    return c.text('Internal server error', 500);
  });

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      service: 'looma-advertising',
      runtime: 'cloudflare-workers-hono',
      bindings: {
        r2MediaBucket: Boolean(c.env?.MEDIA_BUCKET),
        eventQueue: Boolean(c.env?.EVENT_QUEUE),
        hyperdrive: Boolean(c.env?.HYPERDRIVE),
        databaseConfigured: Boolean(resolveWorkerConnectionString(c.env || {})),
      },
    });
  });

  app.get('/api/public/fx-rates', (c) => {
    return c.json({ baseCurrency: 'USD', rates: FX_RATES });
  });

  // Serve creative media stored in Cloudflare R2 bucket (`looma-ads-media`)
  app.get('/api/media/:filename', async (c) => {
    const rawName = String(c.req.param('filename') || '');
    if (!/^[a-zA-Z0-9._-]+$/.test(rawName)) {
      return c.json({ error: 'Invalid media filename' }, 400);
    }
    const dotIdx = rawName.lastIndexOf('.');
    const ext = dotIdx >= 0 ? rawName.slice(dotIdx).toLowerCase() : '';
    const fallbackMime = MEDIA_EXT_TO_MIME[ext];
    if (!fallbackMime) {
      return c.json({ error: 'Unsupported media file' }, 404);
    }

    const r2 = createR2MediaStorage(c.env.MEDIA_BUCKET);
    const obj = await r2.get(rawName);
    if (!obj) {
      return c.json({ error: 'Media asset not found' }, 404);
    }

    return new Response(new Uint8Array(obj.data), {
      status: 200,
      headers: {
        'Content-Type': obj.contentType || fallbackMime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });

  // Public cross-origin ad delivery & Looma adapter routes
  app.use('/api/v1/looma/*', cors({ origin: '*' }));
  app.use('/api/v1/ad/*', cors({ origin: '*' }));
  app.use('/sdk/*', cors({ origin: '*' }));

  app.get('/sdk/looma-ads.js', async (c) => {
    return withWorkerDb(c.env, async (db) => {
      const flags = await getFeatureFlags(db);
      const body = !flags.third_party_sdk_distribution_enabled
        ? `/* LOOMA ADS External Publisher SDK distribution is disabled at initial launch (Looma first-party mode active). */\n${getPublisherSdkScript()}`
        : getPublisherSdkScript();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-Looma-SDK-Mode': flags.third_party_sdk_distribution_enabled ? 'external-enabled' : 'first-party-only',
        },
      });
    });
  });

  const enqueueToCloudflare =
    (env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void } | undefined) => (msg: AdEventQueueMessage) => {
      if (!env.EVENT_QUEUE) return;
      const p = env.EVENT_QUEUE.send(msg).catch((err) => {
        console.error('Failed to enqueue ad event to Cloudflare Queue:', err);
      });
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(p);
      }
    };

  app.all('/api/v1/looma/*', async (c) => {
    const res = await withWorkerDb(c.env, async (db) =>
      executeAppRouterOnHono(c, '/api/v1/looma', createLoomaIntegrationRouter(db))
    );
    return res ?? c.json({ error: 'API endpoint not found' }, 404);
  });

  app.all('/api/v1/ad/*', async (c) => {
    const execCtx = (() => {
      try {
        return c.executionCtx;
      } catch {
        return undefined;
      }
    })();
    const res = await withWorkerDb(c.env, async (db) =>
      executeAppRouterOnHono(
        c,
        '/api/v1/ad',
        createAdDeliveryRouter(db, { onEvent: enqueueToCloudflare(c.env, execCtx) })
      )
    );
    return res ?? c.json({ error: 'API endpoint not found' }, 404);
  });

  app.all('/api/advertiser/*', async (c) => {
    c.header('Cache-Control', 'no-store');
    const res = await withWorkerDb(c.env, async (db) =>
      executeAppRouterOnHono(c, '/api/advertiser', createAdvertiserRouter(db, createR2MediaStorage(c.env.MEDIA_BUCKET)))
    );
    return res ?? c.json({ error: 'API endpoint not found' }, 404);
  });

  app.all('/api/publisher/*', async (c) => {
    c.header('Cache-Control', 'no-store');
    const res = await withWorkerDb(c.env, async (db) =>
      executeAppRouterOnHono(c, '/api/publisher', createPublisherRouter(db))
    );
    return res ?? c.json({ error: 'API endpoint not found' }, 404);
  });

  // Isolate admin console on its dedicated Worker origin (looma-ads-admin)
  app.all('/api/admin', (c) => c.json({ error: 'Not found' }, 404));
  app.all('/api/admin/*', (c) => c.json({ error: 'Not found' }, 404));

  app.all('/api/*', async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/api/auth')) {
      c.header('Cache-Control', 'no-store');
    }
    const res = await withWorkerDb(c.env, async (db) =>
      executeAppRouterOnHono(c, '/api', createPublicAndAuthRouter(db))
    );
    return res ?? c.json({ error: 'API endpoint not found' }, 404);
  });

  // Never expose admin routes on the public domain
  app.all('/admin', (c) => c.text('Not found', 404));
  app.all('/admin/*', (c) => c.text('Not found', 404));

  // Main React + Vite SPA assets
  app.all('*', async (c) => {
    if (!c.env?.ASSETS) {
      return c.text('Not found', 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return app;
}

const app = createWorkerApp();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<AdEventQueueMessage>, env: WorkerEnv): Promise<void> {
    syncWorkerEnvToProcessEnv(env);
    const connStr = resolveWorkerConnectionString(env);
    if (!connStr) {
      for (const msg of batch.messages) msg.ack();
      return;
    }

    await withWorkerDb(env, async (db) => {
      for (const msg of batch.messages) {
        try {
          const body = msg.body;
          if (!body || !body.eventType || !body.entityId) {
            msg.ack();
            continue;
          }
          await db.execute(
            `INSERT INTO event_logs (id, event_type, entity_type, entity_id, payload_json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING`,
            [
              `qevt_${msg.id}`,
              String(body.eventType),
              String(body.entityType || 'ad_event'),
              String(body.entityId),
              JSON.stringify(body.payload ?? {}),
            ]
          );
          msg.ack();
        } catch (err) {
          console.error('Queue message processing failed:', err);
          msg.retry();
        }
      }
    });
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    syncWorkerEnvToProcessEnv(env);
    const connStr = resolveWorkerConnectionString(env);
    if (!connStr) {
      console.warn('Scheduled Cron Trigger skipped: database connection not configured.');
      return;
    }

    await withWorkerDb(env, async (db) => {
      if (controller.cron === '0 0 * * *') {
        await runScheduledJob(db, 'daily_budget_reset', 'cloudflare-cron');
        await runScheduledJob(db, 'publisher_earnings_settlement', 'cloudflare-cron');
      } else {
        await runScheduledJob(db, 'release_expired_reservations', 'cloudflare-cron');
        await runScheduledJob(db, 'expired_token_cleanup', 'cloudflare-cron');
      }
    });
  },
};
