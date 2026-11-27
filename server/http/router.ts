export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Request {
  body?: any;
  params: Record<string, string>;
  query: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
  header(name: string): string | undefined;
  ip?: string;
  socket?: { remoteAddress?: string };
  url?: string;
  path?: string;
  method?: string;
  rawBody?: Buffer;
}

export interface Response {
  headersSent?: boolean;
  status(code: number): Response;
  json(data: unknown): Response | void;
  send(data?: unknown): Response | void;
  setHeader(name: string, value: string | string[]): Response | void;
}

export type NextFunction = (err?: unknown) => void;

export type RouteHandler = (req: any, res: any, next: NextFunction) => unknown | Promise<unknown>;

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handlers: RouteHandler[];
}

export interface AppRouter {
  (req: Request, res: Response, next: NextFunction): void;
  middlewares: RouteHandler[];
  routes: RouteDefinition[];
  use(...handlers: RouteHandler[]): AppRouter;
  get(path: string, ...handlers: RouteHandler[]): AppRouter;
  post(path: string, ...handlers: RouteHandler[]): AppRouter;
  put(path: string, ...handlers: RouteHandler[]): AppRouter;
  patch(path: string, ...handlers: RouteHandler[]): AppRouter;
  delete(path: string, ...handlers: RouteHandler[]): AppRouter;
}

function normalizePath(rawUrlOrPath: string | undefined): string {
  const raw = String(rawUrlOrPath || '/').split('?')[0] || '/';
  if (raw.length > 1 && raw.endsWith('/')) {
    return raw.slice(0, -1);
  }
  return raw;
}

export function matchRoutePattern(pattern: string, actualPath: string): Record<string, string> | null {
  const normPattern = normalizePath(pattern);
  const normActual = normalizePath(actualPath);

  if (normPattern === normActual) return {};

  const patternParts = normPattern === '/' ? [] : normPattern.slice(1).split('/');
  const actualParts = normActual === '/' ? [] : normActual.slice(1).split('/');
  if (patternParts.length !== actualParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i];
    const a = actualParts[i];
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(a);
      } catch {
        params[p.slice(1)] = a;
      }
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

async function runHandlerChain(
  handlers: RouteHandler[],
  req: Request,
  res: Response,
  finalNext: NextFunction
): Promise<void> {
  let index = 0;

  const step = async (err?: unknown): Promise<void> => {
    if (err !== undefined) {
      finalNext(err);
      return;
    }
    if (res.headersSent) return;
    if (index >= handlers.length) {
      finalNext();
      return;
    }

    const fn = handlers[index];
    index += 1;
    let nextCalled = false;

    try {
      await fn(req, res, (nextErr?: unknown) => {
        if (nextCalled) return;
        nextCalled = true;
        void step(nextErr);
      });
    } catch (caught) {
      finalNext(caught);
    }
  };

  await step();
}

export function createAppRouter(): AppRouter {
  const middlewares: RouteHandler[] = [];
  const routes: RouteDefinition[] = [];

  const dispatch = ((req: Request, res: Response, next: NextFunction) => {
    const method = String(req.method || 'GET').toUpperCase() as HttpMethod;
    const reqPath = normalizePath(req.url ?? req.path ?? '/');

    let matchedRoute: RouteDefinition | null = null;
    let matchedParams: Record<string, string> = {};

    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchRoutePattern(r.path, reqPath);
      if (params !== null) {
        matchedRoute = r;
        matchedParams = params;
        break;
      }
    }

    if (!matchedRoute) {
      next();
      return;
    }

    req.params = { ...(req.params || {}), ...matchedParams };
    const chain = [...middlewares, ...matchedRoute.handlers];
    void runHandlerChain(chain, req, res, next);
  }) as AppRouter;

  dispatch.middlewares = middlewares;
  dispatch.routes = routes;

  dispatch.use = (...handlers: RouteHandler[]) => {
    middlewares.push(...handlers);
    return dispatch;
  };

  const register = (method: HttpMethod) => (path: string, ...handlers: RouteHandler[]) => {
    routes.push({ method, path, handlers });
    return dispatch;
  };

  dispatch.get = register('GET');
  dispatch.post = register('POST');
  dispatch.put = register('PUT');
  dispatch.patch = register('PATCH');
  dispatch.delete = register('DELETE');

  return dispatch;
}
