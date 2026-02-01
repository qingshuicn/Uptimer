import type { MiddlewareHandler } from 'hono';

// Cache public (unauthenticated) GET responses at the edge.
// This reduces D1 read pressure and greatly improves TTFB on slow networks.
export function cachePublic(opts: {
  cacheName: string;
  maxAgeSeconds: number;
}): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'GET') {
      await next();
      return;
    }

    // Only cache successful JSON responses.
    const cache = await caches.open(opts.cacheName);
    const cacheKey = new Request(c.req.url, { method: 'GET' });

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    await next();

    if (c.res.status !== 200) return;

    // Respect explicit no-store/no-cache/private responses.
    const cacheControl = c.res.headers.get('Cache-Control');
    if (cacheControl && /(?:^|,\s*)(?:private|no-(?:store|cache))(?:\s*(?:=|,|$))/i.test(cacheControl)) {
      return;
    }

    // Set caching headers for downstream caches (browser/CDN).
    c.res.headers.set('Cache-Control', `public, max-age=${opts.maxAgeSeconds}`);

    // Put into Cloudflare's cache without blocking the response.
    c.executionCtx.waitUntil(cache.put(cacheKey, c.res.clone()));
  };
}
