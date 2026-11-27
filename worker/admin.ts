import { Hono } from 'hono';
import { createAdminRouter } from '../server/routes/admin';
import { createPublicAndAuthRouter } from '../server/routes/publicAndAuth';
import { FX_RATES } from '../server/security';
import { executeAppRouterOnHono } from './honoBridge';
import {
  MEDIA_EXT_TO_MIME,
  resolveWorkerConnectionString,
  syncWorkerEnvToProcessEnv,
  withWorkerDb,
  type WorkerEnv,
} from './index';
import { createR2MediaStorage } from './r2Storage';

export function createAdminWorkerApp() {
  const app = new Hono<{ Bindings: WorkerEnv }>();

  app.use('*', async (c, next) => {
    syncWorkerEnvToProcessEnv(c.env);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });

  app.onError((err, c) => {
    const path = new URL(c.req.url).pathname;
    console.error(`[admin-worker] Unhandled error on ${path}:`, err);
    if (path.startsWith('/api')) {
      const errObj = err as { status?: number; message?: string };
      const status =
        typeof errObj?.status === 'number' && errObj.status >= 400 && errObj.status < 600 ? errObj.status : 500;
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
      service: 'looma-advertising-admin',
      runtime: 'cloudflare-workers-hono',
      bindings: {
        r2MediaBucket: Boolean(c.env?.MEDIA_BUCKET),
        hyperdrive: Boolean(c.env?.HYPERDRIVE),
        databaseConfigured: Boolean(resolveWorkerConnectionString(c.env || {})),
      },
    });
  });

  app.get('/api/public/fx-rates', (c) => {
    return c.json({ baseCurrency: 'USD', rates: FX_RATES });
  });

  // Stream uploaded creative media from Cloudflare R2 for moderation previews
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

  // Reject non-admin domain surfaces cleanly
  app.all('/api/advertiser/*', (c) => c.json({ error: 'Not found' }, 404));
  app.all('/api/publisher/*', (c) => c.json({ error: 'Not found' }, 404));
  app.all('/api/v1/*', (c) => c.json({ error: 'Not found' }, 404));
  app.all('/api/webhooks/*', (c) => c.json({ error: 'Not found' }, 404));

  app.all('/api/admin/*', async (c) => {
    c.header('Cache-Control', 'no-store');
    const res = await withWorkerDb(c.env, async (db) =>
      executeAppRouterOnHono(c, '/api/admin', createAdminRouter(db))
    );
    return res ?? c.json({ error: 'API endpoint not found' }, 404);
  });

  app.all('/api/*', async (c) => {
    c.header('Cache-Control', 'no-store');
    const res = await withWorkerDb(c.env, async (db) =>
      executeAppRouterOnHono(c, '/api', createPublicAndAuthRouter(db))
    );
    return res ?? c.json({ error: 'API endpoint not found' }, 404);
  });

  // Dedicated Admin SPA mounted at root "/"
  app.all('*', async (c) => {
    if (!c.env?.ASSETS) {
      return c.text('Not found', 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return app;
}

const adminApp = createAdminWorkerApp();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    return adminApp.fetch(request, env, ctx);
  },
};
