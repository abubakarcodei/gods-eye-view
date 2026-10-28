/**
 * Vercel serverless adapter for God's Eye View.
 *
 * The upstream app serves every `/api/*` route from Vite dev-server
 * middleware plugins (server/providers/*). Those plugins register
 * Connect-style handlers via `server.middlewares.use(path, handler)`.
 *
 * This function rebuilds that route table once per cold start and
 * dispatches each request through it, so the exact upstream handlers
 * (caching, fallbacks, validation) run unchanged on Vercel.
 *
 * Deployment notes (keyless / free tier):
 * - The POWER UP key-setup plugin (`gev-key-setup`) is deliberately NOT
 *   registered: it writes a local .env file and is loopback-only by
 *   design. Keys, if ever wanted, belong in Vercel env vars instead.
 * - Vercel terminates TLS at its edge and adds x-forwarded-* / via
 *   headers to every request. Upstream's same-site gate treats those
 *   headers as "not this machine" and would 403 core keyless routes
 *   (e.g. /api/overpass). For a public deployment the meaningful
 *   protection is the gate's remaining checks (Sec-Fetch-Site +
 *   exact Origin match), so the proxy-signal headers are stripped
 *   here and the request is marked TLS-terminated (socket.encrypted),
 *   which keeps the Origin comparison on https:// correct.
 * - Provider disk caches live under `<cwd>/.gev-cache`; the function
 *   filesystem is read-only except /tmp, so cwd is moved to /tmp
 *   before any provider module loads (they resolve cache paths from
 *   process.cwd() at import time).
 * - OPENSKY_AUTH_MODE defaults to `anon` (documented keyless mode)
 *   unless the deployment sets it explicitly.
 */

export const config = { api: { bodyParser: false } };

import os from 'node:os';

try {
  process.chdir(os.tmpdir());
} catch {
  /* caches degrade to memory-only if /tmp is unavailable */
}
if (!process.env.OPENSKY_AUTH_MODE) process.env.OPENSKY_AUTH_MODE = 'anon';

const PROXY_SIGNAL_HEADERS = [
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
];

let routesPromise = null;

function loadRoutes() {
  if (!routesPromise) {
    routesPromise = (async () => {
      const routes = [];
      const middlewares = {
        use(...args) {
          if (typeof args[0] === 'function') {
            routes.push({ path: null, handler: args[0] });
          } else if (typeof args[0] === 'string' && typeof args[1] === 'function') {
            routes.push({ path: args[0], handler: args[1] });
          }
        },
      };
      const fakeServer = { middlewares, httpServer: null, config: {} };

      const [{ localProviderPlugins }, { standaloneVoiceTools }] =
        await Promise.all([
          import('../server/providers/local.js'),
          import('../server/standalone/voiceTools.js'),
        ]);

      const { googleTokenUnavailablePlugin } = await import(
        '../server/standalone/google-token-unavailable.js'
      );
      const { apiNotFoundPlugin } = await import(
        '../server/standalone/api-not-found.js'
      );

      const tools = standaloneVoiceTools();
      const plugins = localProviderPlugins({
        realtime: { tools },
        gemini: { tools },
      });
      for (const plugin of plugins) {
        if (!plugin || plugin.name === 'gev-key-setup') continue;
        plugin.configureServer?.(fakeServer);
      }
      googleTokenUnavailablePlugin().configureServer?.(fakeServer);
      apiNotFoundPlugin().configureServer?.(fakeServer);
      return routes;
    })();
  }
  return routesPromise;
}

/** Connect-style mount match: returns the remainder URL, or null. */
function matchRemainder(routePath, url) {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q);
  if (path === routePath) return `/${query}`;
  if (path.startsWith(`${routePath}/`)) return path.slice(routePath.length) + query;
  return null;
}

/**
 * CDN cache policy for idempotent GET data routes (seconds). The
 * upstream handlers answer `Cache-Control: no-store` because they run
 * on a localhost dev server; behind Vercel's CDN that forces every
 * poll through a cold function (~3 s). These feeds are public,
 * keyless and slow-changing, so the CDN serves them at the edge and
 * revalidates in the background — the app's polls become instant.
 * Only exact 200 responses are cached; errors are never stored.
 */
const CDN_CACHE_RULES = [
  ['/api/celestrak/', 'public, s-maxage=3600, stale-while-revalidate=86400'],
  ['/api/terrain/heights', 'public, s-maxage=3600, stale-while-revalidate=86400'],
  ['/api/route', 'public, s-maxage=3600, stale-while-revalidate=86400'],
  ['/api/adsbdb/', 'public, s-maxage=3600, stale-while-revalidate=86400'],
  ['/api/geocode', 'public, s-maxage=86400, stale-while-revalidate=604800'],
  ['/api/transit/feeds', 'public, s-maxage=86400, stale-while-revalidate=604800'],
  ['/api/transit/vehicles/', 'public, s-maxage=5, stale-while-revalidate=15'],
  ['/api/cctv/sources', 'public, s-maxage=600, stale-while-revalidate=3600'],
  ['/api/cctv/health', 'public, s-maxage=60, stale-while-revalidate=300'],
  ['/api/weather/manifest', 'public, s-maxage=300, stale-while-revalidate=1800'],
  ['/api/weather/', 'public, s-maxage=120, stale-while-revalidate=600'],
  ['/api/wind/manifest', 'public, s-maxage=600, stale-while-revalidate=3600'],
  ['/api/fire-perimeters', 'public, s-maxage=300, stale-while-revalidate=1800'],
  ['/api/cyclones', 'public, s-maxage=600, stale-while-revalidate=3600'],
  ['/api/launches', 'public, s-maxage=300, stale-while-revalidate=3600'],
  ['/api/gnss-integrity', 'public, s-maxage=20, stale-while-revalidate=40'],
  ['/api/flights', 'public, s-maxage=10, stale-while-revalidate=20'],
  ['/api/military', 'public, s-maxage=10, stale-while-revalidate=20'],
  ['/api/vessels', 'public, s-maxage=5, stale-while-revalidate=10'],
  ['/api/radio/', 'public, s-maxage=120, stale-while-revalidate=600'],
  ['/api/ghostmaps/catalog', 'public, s-maxage=120, stale-while-revalidate=600'],
  ['/api/tomtom/status', 'public, s-maxage=60, stale-while-revalidate=300'],
  ['/api/overpass/status', 'public, s-maxage=300, stale-while-revalidate=3600'],
  ['/api/mapillary/status', 'public, s-maxage=300, stale-while-revalidate=3600'],
];

function cdnCacheSpecFor(url) {
  for (const [prefix, spec] of CDN_CACHE_RULES) {
    if (url === prefix || url.startsWith(prefix)) return spec;
  }
  return null;
}

export default async function handler(req, res) {
  // Vercel does not route [...path] catch-alls outside Next.js, so
  // vercel.json rewrites /api/:path* to /api/gev?__gev=:path* — put the
  // original URL back together before dispatching.
  // Vercel may deliver this function's URL in either shape — the
  // destination URL (/api/gev?__gev=...) or the original request URL
  // with the destination query merged in (/api/weather/...?__gev=...).
  // Key off the __gev param itself, wherever the URL arrived.
  if (req.url && req.url.includes('__gev=')) {
    try {
      const u = new URL(req.url, 'http://internal');
      if (u.searchParams.has('__gev')) {
        const originalPath = u.searchParams.get('__gev');
        u.searchParams.delete('__gev');
        // Vercel also passes the rewrite's matched :path* segment to the
        // destination as a `path` query param. No upstream endpoint uses
        // a `path` param, and strict handlers (e.g. /api/weather) reject
        // unknown keys — drop it so handlers see the original query only.
        u.searchParams.delete('path');
        const qs = u.searchParams.toString();
        req.url = `/api/${originalPath}${qs ? `?${qs}` : ''}`;
      }
    } catch {
      /* keep the URL as delivered */
    }
  }

  // API responses carry the same hardening headers as the dev server.
  if (!res.headersSent) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  // Normalize the edge-proxied request into the local shape the
  // upstream gates expect (see header comment).
  if (req.headers) {
    for (const name of PROXY_SIGNAL_HEADERS) delete req.headers[name];
  }
  try {
    if (req.socket) req.socket.encrypted = true;
  } catch {
    /* socket may be frozen in some runtimes; Origin check falls back */
  }

  // CDN caching for public GET data (see CDN_CACHE_RULES). Applied by
  // replacing the handler's Cache-Control at writeHead time, and only
  // for 200 responses, so errors and POST flows are never stored.
  if (req.method === 'GET') {
    const spec = cdnCacheSpecFor((req.url || '').split('?')[0]);
    if (spec) {
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = (status, ...rest) => {
        if (status === 200) {
          res.setHeader('Cache-Control', spec);
          const headersArg = rest.find(
            (a) => a && typeof a === 'object' && !Array.isArray(a),
          );
          if (headersArg) {
            for (const key of Object.keys(headersArg)) {
              if (key.toLowerCase() === 'cache-control') delete headersArg[key];
            }
          }
        }
        return originalWriteHead(status, ...rest);
      };
    }
  }

  let routes;
  try {
    routes = await loadRoutes();
  } catch (err) {
    console.error('[gev-vercel] route table failed to load', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'Server init failed' }));
    return;
  }

  const originalUrl = req.url || '/';

  for (const route of routes) {
    if (res.writableEnded) return;
    let remainder = originalUrl;
    if (route.path !== null) {
      remainder = matchRemainder(route.path, originalUrl);
      if (remainder === null) continue;
    }

    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    req.url = remainder;
    try {
      const result = route.handler(req, res, next);
      if (result && typeof result.then === 'function') {
        // Await the handler, but never hold the response hostage past
        // the function budget if it turned into a stream (SSE/media).
        let timer;
        await Promise.race([
          result,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 55_000);
          }),
        ]).finally(() => clearTimeout(timer));
      }
    } catch (err) {
      console.error('[gev-vercel] handler error', route.path, err);
      req.url = originalUrl;
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error' }));
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    req.url = originalUrl;
    // Let any synchronous-but-deferred res.end() land before deciding.
    await new Promise((resolve) => setImmediate(resolve));
    if (res.writableEnded) return;
    if (res.headersSent && !nextCalled) return; // streaming response in progress
    // Otherwise fall through to the next matching mount (Connect semantics).
  }

  if (!res.headersSent && !res.writableEnded) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown API route' }));
  }
}
