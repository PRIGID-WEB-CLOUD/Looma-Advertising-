import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { getDb } from './server/db';
import { seedDatabaseIfEmpty } from './server/seed';
import { createAdDeliveryRouter, getPublisherSdkScript } from './server/routes/adDelivery';
import { createAdvertiserRouter } from './server/routes/advertiser';
import { createPublisherRouter } from './server/routes/publisher';
import { createAdminRouter } from './server/routes/admin';
import { createPublicAndAuthRouter } from './server/routes/publicAndAuth';
import { createLoomaIntegrationRouter } from './server/routes/loomaIntegration';
import { startBackgroundScheduler } from './server/jobs';
import { getFeatureFlags } from './server/modules/featureFlags';

const MEDIA_EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  const db = getDb();
  seedDatabaseIfEmpty(db);
  startBackgroundScheduler(db);

  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(
    express.json({
      limit: '15mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // Serve uploaded ad creative media assets from confined storage directory
  app.get('/api/media/:filename', (req, res) => {
    const rawName = String(req.params.filename || '');
    if (!/^[a-zA-Z0-9._-]+$/.test(rawName)) {
      res.status(400).json({ error: 'Invalid media filename' });
      return;
    }
    const ext = path.extname(rawName).toLowerCase();
    const mimeType = MEDIA_EXT_TO_MIME[ext];
    if (!mimeType) {
      res.status(404).json({ error: 'Unsupported media file' });
      return;
    }
    const uploadDir = path.resolve(process.cwd(), process.env.LOOMA_STORAGE_DIR || 'data/uploads');
    const resolvedPath = path.resolve(uploadDir, rawName);
    if (!resolvedPath.startsWith(uploadDir + path.sep) || !fs.existsSync(resolvedPath)) {
      res.status(404).json({ error: 'Media asset not found' });
      return;
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(resolvedPath);
  });

  // Dedicated Looma first-party publisher adapter & SSO exchange contract
  app.use('/api/v1/looma', cors({ origin: '*' }), createLoomaIntegrationRouter(db));

  // Public ad-serving endpoints (enforces first-party vs third-party feature flags per placement)
  app.use('/api/v1/ad', cors({ origin: '*' }), createAdDeliveryRouter(db));
  app.get('/sdk/looma-ads.js', cors({ origin: '*' }), (_req, res) => {
    const flags = getFeatureFlags(db);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader(
      'X-Looma-SDK-Mode',
      flags.third_party_sdk_distribution_enabled ? 'external-enabled' : 'first-party-only'
    );
    if (!flags.third_party_sdk_distribution_enabled) {
      res.send(
        `/* LOOMA ADS External Publisher SDK distribution is disabled at initial launch (Looma first-party mode active). */\n` +
          getPublisherSdkScript()
      );
      return;
    }
    res.send(getPublisherSdkScript());
  });

  // Allow standalone Admin app origin (e.g. http://localhost:3001 or ADMIN_ORIGIN) to talk to API
  const allowedAdminOrigins = [
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    ...(process.env.ADMIN_ORIGIN ? [process.env.ADMIN_ORIGIN] : []),
  ];
  const adminCors = cors({
    origin: (origin, cb) => {
      if (!origin || allowedAdminOrigins.includes(origin)) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    credentials: true,
  });

  const noStoreMiddleware: express.RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  // Same-origin API routes for advertiser, publisher, admin, auth, and public website
  app.use('/api/advertiser', noStoreMiddleware, createAdvertiserRouter(db));
  app.use('/api/publisher', noStoreMiddleware, createPublisherRouter(db));
  app.use('/api/admin', noStoreMiddleware, adminCors, createAdminRouter(db));
  app.use('/api/auth', noStoreMiddleware);
  app.use('/api', adminCors, createPublicAndAuthRouter(db));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'looma-advertising',
    });
  });

  // Never let unmatched /api/* requests fall through to Vite/SPA HTML fallback
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  // Always return JSON errors for API routes instead of Express HTML error pages
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/sdk')) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.status(500).json({ error: message });
      return;
    }
    next(err);
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.use('/src/assets', express.static(path.resolve(process.cwd(), 'src/assets')));
    app.use((_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build.');
      }
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Looma Advertising server listening on http://localhost:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Looma Advertising server:', err);
  process.exit(1);
});
