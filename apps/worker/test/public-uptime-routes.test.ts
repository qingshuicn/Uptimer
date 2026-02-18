import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
import { publicRoutes } from '../src/routes/public';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

type CacheStore = Map<string, Response>;

function installCacheMock(store: CacheStore) {
  const open = vi.fn(async () => ({
    async match(request: Request) {
      const cached = store.get(request.url);
      return cached ? cached.clone() : undefined;
    },
    async put(request: Request, response: Response) {
      store.set(request.url, response.clone());
    },
  }));

  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { open },
  });

  return open;
}

async function requestPublic(path: string, handlers: FakeD1QueryHandler[]) {
  const env = { DB: createFakeD1Database(handlers) } as unknown as Env;
  const res = await publicRoutes.fetch(
    new Request(`https://status.example.com${path}`),
    env,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

describe('public routes uptime regression', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches;

  beforeEach(() => {
    installCacheMock(new Map());
  });

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: originalCaches,
      });
    }
    vi.restoreAllMocks();
  });

  it('keeps monitor uptime window start for existing monitors instead of snapping to first in-range probe', async () => {
    const rangeEnd = 1_728_000_000;
    const rangeStart = rangeEnd - 86_400;
    const firstInRangeCheckAt = rangeStart + 80_000;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 15_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        first: () => ({
          id: 12,
          name: 'Legacy Monitor',
          interval_sec: 60,
          created_at: rangeStart - 5 * 86_400,
          last_checked_at: rangeEnd - 30,
        }),
      },
      {
        match: 'from check_results',
        all: () => [
          { checked_at: rangeStart - 60, status: 'up' },
          { checked_at: firstInRangeCheckAt, status: 'up' },
        ],
      },
      {
        match: 'from outages',
        all: () => [
          {
            started_at: rangeStart + 600,
            ended_at: rangeStart + 900,
          },
        ],
      },
    ];

    const { res, body } = await requestPublic('/monitors/12/uptime?range=24h', handlers);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      range_start_at: rangeStart,
      range_end_at: rangeEnd,
      total_sec: 86_400,
      downtime_sec: 300,
    });
  });

  it('keeps partial-day totals for existing monitors in public uptime overview', async () => {
    const dayStart = 1_728_000_000;
    const rangeEnd = dayStart + 3_600;
    const firstInRangeCheckAt = dayStart + 1_800;

    vi.spyOn(Date, 'now').mockReturnValue(rangeEnd * 1000 + 10_000);

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from monitors m',
        all: () => [
          {
            id: 21,
            name: 'Core API',
            type: 'http',
            interval_sec: 60,
            created_at: dayStart - 10 * 86_400,
            last_checked_at: rangeEnd - 30,
          },
        ],
      },
      {
        match: 'from monitor_daily_rollups',
        all: () => [],
      },
      {
        match: 'from check_results',
        all: () => [
          { checked_at: dayStart - 60, status: 'up' },
          { checked_at: firstInRangeCheckAt, status: 'up' },
        ],
      },
      {
        match: 'from outages',
        all: () => [
          {
            started_at: dayStart + 300,
            ended_at: dayStart + 600,
          },
        ],
      },
    ];

    const { res, body } = await requestPublic('/analytics/uptime?range=30d', handlers);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      range_end_at: rangeEnd,
      overall: {
        total_sec: 3_600,
        downtime_sec: 300,
      },
      monitors: [
        {
          id: 21,
          total_sec: 3_600,
          downtime_sec: 300,
        },
      ],
    });
  });
});
