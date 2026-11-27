import type { Context } from 'hono';
import type { AppRouter, Request as AppRequest, Response as AppResponse } from '../server/http/router';

const MAX_JSON_BODY_BYTES = 15 * 1024 * 1024;

export interface ParsedBodyResult {
  ok: boolean;
  status?: number;
  error?: string;
  body: any;
  rawBody: Buffer;
}

export async function parseRequestBody(req: globalThis.Request, method: string): Promise<ParsedBodyResult> {
  if (method === 'GET' || method === 'HEAD') {
    return { ok: true, body: {}, rawBody: Buffer.alloc(0) };
  }

  const arrayBuf = await req.arrayBuffer();
  if (arrayBuf.byteLength > MAX_JSON_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'Request payload exceeds maximum allowed size',
      body: {},
      rawBody: Buffer.alloc(0),
    };
  }

  const rawBody = Buffer.from(arrayBuf);
  if (rawBody.length === 0) {
    return { ok: true, body: {}, rawBody };
  }

  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (!contentType || contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      return { ok: true, body: parsed, rawBody };
    } catch {
      return {
        ok: false,
        status: 400,
        error: 'Invalid JSON request payload',
        body: {},
        rawBody,
      };
    }
  }

  return { ok: true, body: rawBody.toString('utf8'), rawBody };
}

export async function executeAppRouterOnHono(
  c: Context,
  mountPrefix: string,
  router: AppRouter
): Promise<globalThis.Response | null> {
  const method = c.req.method.toUpperCase();
  const parsedBody = await parseRequestBody(c.req.raw, method);
  if (!parsedBody.ok) {
    return c.json({ error: parsedBody.error || 'Bad request' }, (parsedBody.status as 400 | 413) || 400);
  }

  const urlObj = new URL(c.req.url);
  let subPath = urlObj.pathname;
  if (mountPrefix !== '/' && subPath.startsWith(mountPrefix)) {
    subPath = subPath.slice(mountPrefix.length) || '/';
  }
  if (!subPath.startsWith('/')) {
    subPath = `/${subPath}`;
  }

  const headersRecord: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headersRecord[key.toLowerCase()] = value;
  });

  const queryRecord: Record<string, string | string[]> = {};
  urlObj.searchParams.forEach((value, key) => {
    const existing = queryRecord[key];
    if (existing === undefined) {
      queryRecord[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      queryRecord[key] = [existing, value];
    }
  });

  const clientIp =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '127.0.0.1';

  const appReq: AppRequest = {
    body: parsedBody.body,
    rawBody: parsedBody.rawBody,
    params: {},
    query: queryRecord,
    headers: headersRecord,
    header(name: string) {
      return headersRecord[name.toLowerCase()];
    },
    ip: clientIp,
    socket: { remoteAddress: clientIp },
    url: subPath,
    path: subPath,
    method,
  };

  let statusCode = 200;
  const responseHeaders = new Headers();
  let finished = false;
  let responseBody: BodyInit | null = null;

  return new Promise<globalThis.Response | null>((resolve, reject) => {
    const finish = (body: BodyInit | null) => {
      if (finished) return;
      finished = true;
      appRes.headersSent = true;
      responseBody = body;
      resolve(new globalThis.Response(responseBody, { status: statusCode, headers: responseHeaders }));
    };

    const appRes: AppResponse = {
      headersSent: false,
      status(code: number) {
        statusCode = code;
        return appRes;
      },
      setHeader(name: string, value: string | string[]) {
        if (Array.isArray(value)) {
          responseHeaders.delete(name);
          for (const item of value) responseHeaders.append(name, item);
        } else {
          responseHeaders.set(name, String(value));
        }
        return appRes;
      },
      json(data: unknown) {
        if (!responseHeaders.has('Content-Type')) {
          responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
        }
        finish(JSON.stringify(data));
        return appRes;
      },
      send(data?: unknown) {
        if (data === undefined || data === null) {
          finish(null);
          return appRes;
        }
        if (typeof data === 'string') {
          if (!responseHeaders.has('Content-Type')) {
            responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
          }
          finish(data);
          return appRes;
        }
        if (data instanceof Uint8Array) {
          finish(new Uint8Array(data));
          return appRes;
        }
        if (!responseHeaders.has('Content-Type')) {
          responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
        }
        finish(JSON.stringify(data));
        return appRes;
      },
    };

    router(appReq, appRes, (err?: unknown) => {
      if (err !== undefined) {
        reject(err);
        return;
      }
      if (!finished) {
        resolve(null);
      }
    });
  });
}
