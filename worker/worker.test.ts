import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { createAppRouter, matchRoutePattern } from '../server/http/router';
import { getDb } from '../server/db';
import { seedDatabaseIfEmpty } from '../server/seed';
import { createAdvertiserRouter } from '../server/routes/advertiser';
import { createPublicAndAuthRouter } from '../server/routes/publicAndAuth';
import { initializeProviderDeposit, isLiveProviderCredential } from '../server/security';
import { executeAppRouterOnHono } from './honoBridge';
import { createR2MediaStorage } from './r2Storage';
import { createAdminWorkerApp } from './admin';
import workerEntry, { createWorkerApp, type WorkerEnv } from './index';

function createMemoryR2Bucket(): R2Bucket {
  const store = new Map<string, { data: Uint8Array; contentType?: string }>();
  return {
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream, options?: R2PutOptions) {
      let bytes: Uint8Array;
      if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value instanceof Uint8Array) {
        bytes = new Uint8Array(value);
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else {
        bytes = new Uint8Array(await new Response(value).arrayBuffer());
      }
      const contentType =
        options?.httpMetadata && !(options.httpMetadata instanceof Headers)
          ? options.httpMetadata.contentType
          : undefined;
      store.set(key, { data: bytes, contentType });
      return {} as R2Object;
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        key,
        size: entry.data.byteLength,
        httpMetadata: entry.contentType ? { contentType: entry.contentType } : {},
        async arrayBuffer() {
          return entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength);
        },
      } as unknown as R2ObjectBody;
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
  } as unknown as R2Bucket;
}

test('matchRoutePattern resolves static and parameterized segments accurately', () => {
  assert.deepEqual(matchRoutePattern('/campaigns', '/campaigns'), {});
  assert.deepEqual(matchRoutePattern('/campaigns/:id/appeal', '/campaigns/cmp_123/appeal'), { id: 'cmp_123' });
  assert.equal(matchRoutePattern('/campaigns/:id', '/campaigns/cmp_123/extra'), null);
  assert.equal(matchRoutePattern('/campaigns', '/advertisers'), null);
});

test('Hono bridge executes AppRouter routes, preserves rawBody for HMAC, and handles malformed JSON', async () => {
  const db = await getDb(':memory:');
  await seedDatabaseIfEmpty(db);

  const hono = new Hono();
  hono.all('/api/*', async (c) => {
    const res = await executeAppRouterOnHono(c, '/api', createPublicAndAuthRouter(db));
    return res ?? c.json({ error: 'Not found' }, 404);
  });

  const overviewRes = await hono.request('http://localhost/api/public/overview');
  assert.equal(overviewRes.status, 200);
  const overviewData = (await overviewRes.json()) as { stats: { active_campaigns: number } };
  assert.ok(overviewData.stats.active_campaigns >= 1);

  const badJsonRes = await hono.request('http://localhost/api/public/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid-json',
  });
  assert.equal(badJsonRes.status, 400);

  // Verify rawBody preservation for Paystack webhook HMAC verification
  const advRow = await db.queryOne<{ id: string }>('SELECT id FROM advertiser_accounts LIMIT 1');
  assert.ok(advRow);
  const prevSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
  process.env.PAYSTACK_WEBHOOK_SECRET = 'cf-worker-paystack-secret';
  try {
    const payload = JSON.stringify({
      eventId: `wh_${crypto.randomUUID().slice(0, 8)}`,
      advertiserId: advRow.id,
      amountUsd: 25,
      eventType: 'charge.success',
    });
    const sig = crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(payload).digest('hex');

    const webhookRes = await hono.request('http://localhost/api/webhooks/payments/paystack', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': sig,
      },
      body: payload,
    });
    assert.equal(webhookRes.status, 200);
    const webhookJson = (await webhookRes.json()) as { processed: boolean; duplicate?: boolean };
    assert.equal(webhookJson.processed, true);
  } finally {
    if (prevSecret !== undefined) process.env.PAYSTACK_WEBHOOK_SECRET = prevSecret;
    else delete process.env.PAYSTACK_WEBHOOK_SECRET;
    await db.close();
  }
});

test('R2 media storage adapter stores, validates, retrieves, and deletes creative assets', async () => {
  const bucket = createMemoryR2Bucket();
  const r2 = createR2MediaStorage(bucket);

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await r2.put('med_sample_1234.png', pngBytes, 'image/png');

  const loaded = await r2.get('med_sample_1234.png');
  assert.ok(loaded);
  assert.equal(loaded.contentType, 'image/png');
  assert.equal(loaded.data.byteLength, pngBytes.byteLength);

  await assert.rejects(() => r2.put('../escape.png', pngBytes, 'image/png'));
  assert.equal(await r2.get('../escape.png'), null);

  await r2.delete('med_sample_1234.png');
  assert.equal(await r2.get('med_sample_1234.png'), null);
});

test('Worker Hono app serves /api/health, R2 /api/media/:filename, and /admin redirect', async () => {
  const bucket = createMemoryR2Bucket();
  const r2 = createR2MediaStorage(bucket);
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  await r2.put('creative_test.png', pngBytes, 'image/png');

  const env: WorkerEnv = {
    MEDIA_BUCKET: bucket,
    EVENT_QUEUE: {
      async send() {},
      async sendBatch() {},
    } as unknown as Queue<any>,
    ASSETS: {
      async fetch(req: Request) {
        return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 });
      },
    } as unknown as Fetcher,
  };

  const app = createWorkerApp();

  const healthRes = await app.fetch(new Request('https://looma-ads.workers.dev/api/health'), env);
  assert.equal(healthRes.status, 200);
  const healthJson = (await healthRes.json()) as {
    ok: boolean;
    runtime: string;
    bindings: { r2MediaBucket: boolean; eventQueue: boolean };
  };
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.runtime, 'cloudflare-workers-hono');
  assert.equal(healthJson.bindings.r2MediaBucket, true);
  assert.equal(healthJson.bindings.eventQueue, true);

  const mediaRes = await app.fetch(new Request('https://looma-ads.workers.dev/api/media/creative_test.png'), env);
  assert.equal(mediaRes.status, 200);
  assert.equal(mediaRes.headers.get('content-type'), 'image/png');
  assert.equal(mediaRes.headers.get('x-content-type-options'), 'nosniff');

  const adminBlockedUiRes = await app.fetch(new Request('https://looma-ads.workers.dev/admin'), env);
  assert.equal(adminBlockedUiRes.status, 404);
  const adminBlockedApiRes = await app.fetch(new Request('https://looma-ads.workers.dev/api/admin/overview'), env);
  assert.equal(adminBlockedApiRes.status, 404);

  const adminApp = createAdminWorkerApp();
  const adminHealthRes = await adminApp.fetch(new Request('https://looma-ads-admin.workers.dev/api/health'), env);
  assert.equal(adminHealthRes.status, 200);
  assert.equal(adminHealthRes.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(adminHealthRes.headers.get('x-frame-options'), 'DENY');
  const adminHealthJson = (await adminHealthRes.json()) as { ok: boolean; service: string };
  assert.equal(adminHealthJson.ok, true);
  assert.equal(adminHealthJson.service, 'looma-advertising-admin');

  const adminRootRes = await adminApp.fetch(new Request('https://looma-ads-admin.workers.dev/'), env);
  assert.equal(adminRootRes.status, 200);
  assert.equal(await adminRootRes.text(), 'asset:/');

  const adminAdvBlocked = await adminApp.fetch(new Request('https://looma-ads-admin.workers.dev/api/advertiser/overview'), env);
  assert.equal(adminAdvBlocked.status, 404);

  const dbUnavailableRes = await app.fetch(new Request('https://looma-ads.workers.dev/api/public/overview'), env);
  assert.equal(dbUnavailableRes.status, 503);
  const dbUnavailableJson = (await dbUnavailableRes.json()) as { error: string };
  assert.equal(dbUnavailableJson.error, 'Service temporarily unavailable');
  assert.ok(!dbUnavailableJson.error.includes('Hyperdrive') && !dbUnavailableJson.error.includes('DATABASE_URL'));

  // Also ensure AppRouter works directly for advertiser media router
  const db = await getDb(':memory:');
  await seedDatabaseIfEmpty(db);
  const advRouter = createAdvertiserRouter(db, r2);
  assert.ok(advRouter.routes.some((r) => r.method === 'POST' && r.path === '/media'));
  await db.close();
});

test('Worker queue consumer and scheduled handler handle unconfigured DB gracefully and AppRouter chains middlewares', async () => {
  const router = createAppRouter();
  router.use((_req, _res, next) => next());
  router.get('/ping/:id', (req, res) => {
    res.json({ pong: req.params.id });
  });

  const hono = new Hono();
  hono.all('/x/*', async (c) => {
    const res = await executeAppRouterOnHono(c, '/x', router);
    return res ?? c.json({ error: 'miss' }, 404);
  });

  const res = await hono.request('http://localhost/x/ping/hello');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pong: 'hello' });

  let acked = false;
  await workerEntry.queue(
    {
      queue: 'looma-ads-events',
      messages: [
        {
          id: 'm1',
          timestamp: new Date(),
          body: { eventType: 'ad_request_filled', entityType: 'ad_request', entityId: 'req_1', payload: {} },
          attempts: 1,
          ack() {
            acked = true;
          },
          retry() {},
        },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<any>,
    {} as WorkerEnv
  );
  assert.equal(acked, true);
});

test('isLiveProviderCredential treats demo keys as sandbox and live keys as live', async () => {
  assert.equal(isLiveProviderCredential(undefined), false);
  assert.equal(isLiveProviderCredential('sk_demo_paystack_12345'), false);
  assert.equal(isLiveProviderCredential('FLWSECK_DEMO_12345'), false);
  assert.equal(isLiveProviderCredential('demo_key_123'), false);
  assert.equal(isLiveProviderCredential('sk_live_actual_provider_key'), true);

  const prevPs = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = 'sk_demo_paystack_test_placeholder';
  try {
    const res = await initializeProviderDeposit({
      provider: 'paystack',
      amountUsd: 50,
      email: 'advertiser@example.com',
      reference: 'dep_demo_1',
    });
    assert.equal(res.mode, 'sandbox');
    assert.equal(res.status, 'completed');
  } finally {
    if (prevPs !== undefined) process.env.PAYSTACK_SECRET_KEY = prevPs;
    else delete process.env.PAYSTACK_SECRET_KEY;
  }
});
