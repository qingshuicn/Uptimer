import { Hono } from 'hono';
import { z } from 'zod';

import { getDb, monitors } from '@uptimer/db';

import type { Env } from '../env';
import { AppError } from '../middleware/errors';
import { cachePublic } from '../middleware/cache-public';

export const publicRoutes = new Hono<{ Bindings: Env }>();

// Cache public endpoints at the edge to improve performance on slow networks.
publicRoutes.use('*', cachePublic({ cacheName: 'uptimer-public', maxAgeSeconds: 30 }));

type PublicStatusMonitorRow = {
  id: number;
  name: string;
  type: string;
  interval_sec: number;
  state_status: string | null;
  last_checked_at: number | null;
  last_latency_ms: number | null;
};

type PublicHeartbeatRow = {
  monitor_id: number;
  checked_at: number;
  status: string;
  latency_ms: number | null;
};

type Interval = { start: number; end: number };

const HEARTBEAT_LIMIT = 60;
const HEARTBEAT_LOOKBACK_SEC = 7 * 24 * 60 * 60;

const STATUS_ACTIVE_INCIDENT_LIMIT = 5;
const STATUS_ACTIVE_MAINTENANCE_LIMIT = 3;
const STATUS_UPCOMING_MAINTENANCE_LIMIT = 5;

const latencyRangeSchema = z.enum(['24h']);
const uptimeRangeSchema = z.enum(['24h', '7d', '30d']);
const uptimeOverviewRangeSchema = z.enum(['30d', '90d']);

function toMonitorStatus(value: string | null): 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'paused':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function toCheckStatus(value: string | null): 'up' | 'down' | 'maintenance' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) return [];

  const merged: Interval[] = [{ start: first.start, end: first.end }];

  for (const cur of sorted.slice(1)) {
    if (!cur) continue;

    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ start: cur.start, end: cur.end });
      continue;
    }

    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
      continue;
    }

    merged.push({ start: cur.start, end: cur.end });
  }

  return merged;
}

function sumIntervals(intervals: Interval[]): number {
  return intervals.reduce((acc, it) => acc + Math.max(0, it.end - it.start), 0);
}

function overlapSeconds(a: Interval[], b: Interval[]): number {
  let i = 0;
  let j = 0;
  let acc = 0;

  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (!x || !y) break;

    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) {
      acc += end - start;
    }

    if (x.end <= y.end) {
      i++;
    } else {
      j++;
    }
  }

  return acc;
}

function ensureInterval(interval: Interval): Interval | null {
  if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end)) return null;
  if (interval.end <= interval.start) return null;
  return interval;
}

function pushMergedInterval(intervals: Interval[], next: Interval): void {
  const last = intervals[intervals.length - 1];
  if (last && next.start <= last.end) {
    last.end = Math.max(last.end, next.end);
    return;
  }
  intervals.push({ start: next.start, end: next.end });
}

function buildUnknownIntervals(
  rangeStart: number,
  rangeEnd: number,
  intervalSec: number,
  checks: Array<{ checked_at: number; status: string }>
): Interval[] {
  if (rangeEnd <= rangeStart) return [];
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    return [{ start: rangeStart, end: rangeEnd }];
  }

  let lastCheck: { checked_at: number; status: string } | null = null;
  let cursor = rangeStart;

  const unknown: Interval[] = [];

  function addUnknown(from: number, to: number) {
    const it = ensureInterval({ start: from, end: to });
    if (!it) return;
    pushMergedInterval(unknown, it);
  }

  function processSegment(segStart: number, segEnd: number) {
    if (segEnd <= segStart) return;

    if (!lastCheck) {
      addUnknown(segStart, segEnd);
      return;
    }

    const validUntil = lastCheck.checked_at + intervalSec;

    // Status only applies within [checked_at, checked_at + intervalSec). Beyond that, it's UNKNOWN.
    if (segStart >= validUntil) {
      addUnknown(segStart, segEnd);
      return;
    }

    const coveredEnd = Math.min(segEnd, validUntil);
    if (lastCheck.status === 'unknown') {
      addUnknown(segStart, coveredEnd);
    }

    if (coveredEnd < segEnd) {
      addUnknown(coveredEnd, segEnd);
    }
  }

  for (const check of checks) {
    if (check.checked_at < rangeStart) {
      lastCheck = check;
      continue;
    }
    if (check.checked_at >= rangeEnd) {
      break;
    }

    processSegment(cursor, check.checked_at);
    lastCheck = check;
    cursor = check.checked_at;
  }

  processSegment(cursor, rangeEnd);
  return unknown;
}

function rangeToSeconds(range: z.infer<typeof uptimeRangeSchema> | z.infer<typeof latencyRangeSchema>): number {
  switch (range) {
    case '24h':
      return 24 * 60 * 60;
    case '7d':
      return 7 * 24 * 60 * 60;
    case '30d':
      return 30 * 24 * 60 * 60;
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx] ?? null;
}

type IncidentRow = {
  id: number;
  title: string;
  status: string;
  impact: string;
  message: string | null;
  started_at: number;
  resolved_at: number | null;
};

type IncidentUpdateRow = {
  id: number;
  incident_id: number;
  status: string | null;
  message: string;
  created_at: number;
};

type IncidentMonitorLinkRow = {
  incident_id: number;
  monitor_id: number;
};

function toIncidentStatus(value: string | null): 'investigating' | 'identified' | 'monitoring' | 'resolved' {
  switch (value) {
    case 'investigating':
    case 'identified':
    case 'monitoring':
    case 'resolved':
      return value;
    default:
      return 'investigating';
  }
}

function toIncidentImpact(value: string | null): 'none' | 'minor' | 'major' | 'critical' {
  switch (value) {
    case 'none':
    case 'minor':
    case 'major':
    case 'critical':
      return value;
    default:
      return 'minor';
  }
}

function incidentUpdateRowToApi(row: IncidentUpdateRow) {
  return {
    id: row.id,
    incident_id: row.incident_id,
    status: row.status === null ? null : toIncidentStatus(row.status),
    message: row.message,
    created_at: row.created_at,
  };
}

function incidentRowToApi(row: IncidentRow, updates: IncidentUpdateRow[] = [], monitorIds: number[] = []) {
  return {
    id: row.id,
    title: row.title,
    status: toIncidentStatus(row.status),
    impact: toIncidentImpact(row.impact),
    message: row.message,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    monitor_ids: monitorIds,
    updates: updates.map(incidentUpdateRowToApi),
  };
}

async function listIncidentUpdatesByIncidentId(
  db: D1Database,
  incidentIds: number[]
): Promise<Map<number, IncidentUpdateRow[]>> {
  const byIncident = new Map<number, IncidentUpdateRow[]>();
  if (incidentIds.length === 0) return byIncident;

  const placeholders = incidentIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const sql = `
    SELECT id, incident_id, status, message, created_at
    FROM incident_updates
    WHERE incident_id IN (${placeholders})
    ORDER BY incident_id, created_at, id
  `;

  const { results } = await db.prepare(sql).bind(...incidentIds).all<IncidentUpdateRow>();
  for (const r of results ?? []) {
    const existing = byIncident.get(r.incident_id) ?? [];
    existing.push(r);
    byIncident.set(r.incident_id, existing);
  }

  return byIncident;
}

type MaintenanceWindowRow = {
  id: number;
  title: string;
  message: string | null;
  starts_at: number;
  ends_at: number;
  created_at: number;
};

type MaintenanceWindowMonitorLinkRow = {
  maintenance_window_id: number;
  monitor_id: number;
};

function maintenanceWindowRowToApi(row: MaintenanceWindowRow, monitorIds: number[] = []) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    monitor_ids: monitorIds,
  };
}

async function listIncidentMonitorIdsByIncidentId(
  db: D1Database,
  incidentIds: number[]
): Promise<Map<number, number[]>> {
  const byIncident = new Map<number, number[]>();
  if (incidentIds.length === 0) return byIncident;

  const placeholders = incidentIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const sql = `
    SELECT incident_id, monitor_id
    FROM incident_monitors
    WHERE incident_id IN (${placeholders})
    ORDER BY incident_id, monitor_id
  `;

  const { results } = await db.prepare(sql).bind(...incidentIds).all<IncidentMonitorLinkRow>();
  for (const r of results ?? []) {
    const existing = byIncident.get(r.incident_id) ?? [];
    existing.push(r.monitor_id);
    byIncident.set(r.incident_id, existing);
  }

  return byIncident;
}

async function listMaintenanceWindowMonitorIdsByWindowId(
  db: D1Database,
  windowIds: number[]
): Promise<Map<number, number[]>> {
  const byWindow = new Map<number, number[]>();
  if (windowIds.length === 0) return byWindow;

  const placeholders = windowIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const sql = `
    SELECT maintenance_window_id, monitor_id
    FROM maintenance_window_monitors
    WHERE maintenance_window_id IN (${placeholders})
    ORDER BY maintenance_window_id, monitor_id
  `;

  const { results } = await db.prepare(sql).bind(...windowIds).all<MaintenanceWindowMonitorLinkRow>();
  for (const r of results ?? []) {
    const existing = byWindow.get(r.maintenance_window_id) ?? [];
    existing.push(r.monitor_id);
    byWindow.set(r.maintenance_window_id, existing);
  }

  return byWindow;
}

async function listActiveMaintenanceMonitorIds(
  db: D1Database,
  at: number,
  monitorIds: number[]
): Promise<Set<number>> {
  const ids = [...new Set(monitorIds)];
  if (ids.length === 0) return new Set();

  const placeholders = ids.map((_, idx) => `?${idx + 2}`).join(', ');
  const sql = `
    SELECT DISTINCT mwm.monitor_id
    FROM maintenance_window_monitors mwm
    JOIN maintenance_windows mw ON mw.id = mwm.maintenance_window_id
    WHERE mw.starts_at <= ?1 AND mw.ends_at > ?1
      AND mwm.monitor_id IN (${placeholders})
  `;

  const { results } = await db.prepare(sql).bind(at, ...ids).all<{ monitor_id: number }>();
  return new Set((results ?? []).map((r) => r.monitor_id));
}

publicRoutes.get('/status', async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const lookbackStart = rangeEnd - HEARTBEAT_LOOKBACK_SEC;

  const { results } = await c.env.DB.prepare(
    `
      SELECT
        m.id,
        m.name,
        m.type,
        m.interval_sec,
        s.status AS state_status,
        s.last_checked_at,
        s.last_latency_ms
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
      ORDER BY m.id
    `
  ).all<PublicStatusMonitorRow>();

  const rawMonitors = results ?? [];
  const rawIds = rawMonitors.map((m) => m.id);
  const maintenanceMonitorIds = await listActiveMaintenanceMonitorIds(c.env.DB, now, rawIds);

  const monitorsList = rawMonitors.map((r) => {
    const isInMaintenance = maintenanceMonitorIds.has(r.id);
    const stateStatus = toMonitorStatus(r.state_status);

    // Paused/maintenance are operator-enforced; they should not degrade to "stale/unknown"
    // just because the scheduler isn't (or shouldn't be) running checks.
    const isStale =
      isInMaintenance || stateStatus === 'paused' || stateStatus === 'maintenance'
        ? false
        : r.last_checked_at === null
          ? true
          : now - r.last_checked_at > r.interval_sec * 2;

    const status = isInMaintenance ? 'maintenance' : isStale ? 'unknown' : stateStatus;

    return {
      id: r.id,
      name: r.name,
      type: r.type,
      status,
      is_stale: isStale,
      last_checked_at: r.last_checked_at,
      last_latency_ms: isStale ? null : r.last_latency_ms,
      heartbeats: [] as Array<{ checked_at: number; status: ReturnType<typeof toCheckStatus>; latency_ms: number | null }>,
    };
  });

  const counts = { up: 0, down: 0, maintenance: 0, paused: 0, unknown: 0 };
  for (const m of monitorsList) {
    counts[m.status]++;
  }

  const overall_status: keyof typeof counts =
    counts.down > 0
      ? 'down'
      : counts.unknown > 0
        ? 'unknown'
        : counts.maintenance > 0
          ? 'maintenance'
          : counts.up > 0
            ? 'up'
            : counts.paused > 0
              ? 'paused'
              : 'unknown';

  const ids = monitorsList.map((m) => m.id);
  if (ids.length > 0) {
    const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(', ');
    const rangeStartPlaceholder = `?${ids.length + 1}`;
    const limitPlaceholder = `?${ids.length + 2}`;

    const sql = `
      SELECT monitor_id, checked_at, status, latency_ms
      FROM (
        SELECT
          monitor_id,
          checked_at,
          status,
          latency_ms,
          ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY checked_at DESC) AS rn
        FROM check_results
        WHERE monitor_id IN (${placeholders})
          AND checked_at >= ${rangeStartPlaceholder}
      ) t
      WHERE rn <= ${limitPlaceholder}
      ORDER BY monitor_id, checked_at DESC
    `;

    const { results: heartbeatRows } = await c.env.DB.prepare(sql)
      .bind(...ids, lookbackStart, HEARTBEAT_LIMIT)
      .all<PublicHeartbeatRow>();

    const byMonitor = new Map<number, Array<{ checked_at: number; status: ReturnType<typeof toCheckStatus>; latency_ms: number | null }>>();
    for (const r of heartbeatRows ?? []) {
      const existing = byMonitor.get(r.monitor_id) ?? [];
      existing.push({ checked_at: r.checked_at, status: toCheckStatus(r.status), latency_ms: r.latency_ms });
      byMonitor.set(r.monitor_id, existing);
    }

    for (const m of monitorsList) {
      const rows = byMonitor.get(m.id) ?? [];
      // Return chronological order for easier rendering on the client.
      m.heartbeats = rows.reverse();
    }
  }

  const { results: activeIncidents } = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE status != 'resolved'
      ORDER BY started_at DESC, id DESC
      LIMIT ?1
    `
  )
    .bind(STATUS_ACTIVE_INCIDENT_LIMIT)
    .all<IncidentRow>();

  const activeIncidentRows = activeIncidents ?? [];
  const incidentMonitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(
    c.env.DB,
    activeIncidentRows.map((r) => r.id)
  );

  const { results: activeMaintenanceWindows } = await c.env.DB.prepare(
    `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      WHERE starts_at <= ?1 AND ends_at > ?1
      ORDER BY starts_at ASC, id ASC
      LIMIT ?2
    `
  )
    .bind(now, STATUS_ACTIVE_MAINTENANCE_LIMIT)
    .all<MaintenanceWindowRow>();

  const activeWindowRows = activeMaintenanceWindows ?? [];
  const activeWindowMonitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
    c.env.DB,
    activeWindowRows.map((w) => w.id)
  );

  const { results: upcomingMaintenanceWindows } = await c.env.DB.prepare(
    `
      SELECT id, title, message, starts_at, ends_at, created_at
      FROM maintenance_windows
      WHERE starts_at > ?1
      ORDER BY starts_at ASC, id ASC
      LIMIT ?2
    `
  )
    .bind(now, STATUS_UPCOMING_MAINTENANCE_LIMIT)
    .all<MaintenanceWindowRow>();

  const upcomingWindowRows = upcomingMaintenanceWindows ?? [];
  const upcomingWindowMonitorIdsByWindowId = await listMaintenanceWindowMonitorIdsByWindowId(
    c.env.DB,
    upcomingWindowRows.map((w) => w.id)
  );

  // Status page banner rule (Application.md 11): incidents (manual) > monitor aggregation (DOWN wins) > maintenance.
  const banner = (() => {
    const incidents = activeIncidentRows;
    if (incidents.length > 0) {
      const impactRank = (impact: ReturnType<typeof toIncidentImpact>) => {
        switch (impact) {
          case 'critical':
            return 3;
          case 'major':
            return 2;
          case 'minor':
            return 1;
          case 'none':
          default:
            return 0;
        }
      };

      const maxImpact = incidents
        .map((it) => toIncidentImpact(it.impact))
        .reduce((acc, it) => (impactRank(it) > impactRank(acc) ? it : acc), 'none' as const);

      const status =
        maxImpact === 'critical' || maxImpact === 'major'
          ? 'major_outage'
          : maxImpact === 'minor'
            ? 'partial_outage'
            : 'operational';

      const title = status === 'major_outage' ? 'Major Outage' : status === 'partial_outage' ? 'Partial Outage' : 'Incident';

      const top = incidents[0];
      return {
        source: 'incident',
        status,
        title,
        incident: top ? { id: top.id, title: top.title, status: toIncidentStatus(top.status), impact: toIncidentImpact(top.impact) } : null,
      };
    }

    const total = monitorsList.length;
    const downRatio = total === 0 ? 0 : counts.down / total;

    if (counts.down > 0) {
      const status = downRatio >= 0.3 ? 'major_outage' : 'partial_outage';
      return {
        source: 'monitors',
        status,
        title: status === 'major_outage' ? 'Major Outage' : 'Partial Outage',
        down_ratio: downRatio,
      };
    }

    if (counts.unknown > 0) {
      return { source: 'monitors', status: 'unknown', title: 'Status Unknown' };
    }

    const maint = activeWindowRows;
    const hasMaintenance = maint.length > 0 || counts.maintenance > 0;
    if (hasMaintenance) {
      const top = maint[0];
      return top
        ? {
            source: 'maintenance',
            status: 'maintenance',
            title: 'Maintenance',
            maintenance_window: { id: top.id, title: top.title, starts_at: top.starts_at, ends_at: top.ends_at },
          }
        : { source: 'monitors', status: 'maintenance', title: 'Maintenance' };
    }

    return { source: 'monitors', status: 'operational', title: 'All Systems Operational' };
  })();

  return c.json({
    generated_at: now,
    overall_status,
    banner,
    summary: counts,
    monitors: monitorsList,
    active_incidents: activeIncidentRows.map((r) => incidentRowToApi(r, [], incidentMonitorIdsByIncidentId.get(r.id) ?? [])),
    maintenance_windows: {
      active: activeWindowRows.map((w) =>
        maintenanceWindowRowToApi(w, activeWindowMonitorIdsByWindowId.get(w.id) ?? [])
      ),
      upcoming: upcomingWindowRows.map((w) =>
        maintenanceWindowRowToApi(w, upcomingWindowMonitorIdsByWindowId.get(w.id) ?? [])
      ),
    },
  });
});

publicRoutes.get('/incidents', async (c) => {
  const limit = z.coerce.number().int().min(1).max(200).optional().default(20).parse(c.req.query('limit'));
  const cursor = z.coerce.number().int().positive().optional().parse(c.req.query('cursor'));

  const { results: activeRows } = await c.env.DB.prepare(
    `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE status != 'resolved'
      ORDER BY started_at DESC, id DESC
      LIMIT ?1
    `
  )
    .bind(limit)
    .all<IncidentRow>();

  const active = activeRows ?? [];
  const remaining = Math.max(0, limit - active.length);

  let resolved: IncidentRow[] = [];
  let next_cursor: number | null = null;

  if (remaining > 0) {
    const resolvedLimitPlusOne = remaining + 1;

    const baseSql = `
      SELECT id, title, status, impact, message, started_at, resolved_at
      FROM incidents
      WHERE status = 'resolved'
    `;

    const { results: resolvedRows } = cursor
      ? await c.env.DB.prepare(
          `
            ${baseSql}
              AND id < ?2
            ORDER BY id DESC
            LIMIT ?1
          `
        )
          .bind(resolvedLimitPlusOne, cursor)
          .all<IncidentRow>()
      : await c.env.DB.prepare(
          `
            ${baseSql}
            ORDER BY id DESC
            LIMIT ?1
          `
        )
          .bind(resolvedLimitPlusOne)
          .all<IncidentRow>();

    const allResolved = resolvedRows ?? [];
    resolved = allResolved.slice(0, remaining);

    if (allResolved.length > remaining) {
      const last = resolved[resolved.length - 1];
      next_cursor = last ? last.id : null;
    }
  }

  const combined = [...active, ...resolved];
  const updatesByIncidentId = await listIncidentUpdatesByIncidentId(
    c.env.DB,
    combined.map((r) => r.id)
  );
  const monitorIdsByIncidentId = await listIncidentMonitorIdsByIncidentId(
    c.env.DB,
    combined.map((r) => r.id)
  );

  return c.json({
    incidents: combined.map((r) =>
      incidentRowToApi(r, updatesByIncidentId.get(r.id) ?? [], monitorIdsByIncidentId.get(r.id) ?? [])
    ),
    next_cursor,
  });
});

publicRoutes.get('/monitors/:id/latency', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = latencyRangeSchema.optional().default('24h').parse(c.req.query('range'));

  const monitor = await c.env.DB.prepare(
    `
      SELECT id, name
      FROM monitors
      WHERE id = ?1 AND is_active = 1
    `
  )
    .bind(id)
    .first<{ id: number; name: string }>();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeStart = rangeEnd - rangeToSeconds(range);

  const { results } = await c.env.DB.prepare(
    `
      SELECT checked_at, status, latency_ms
      FROM check_results
      WHERE monitor_id = ?1
        AND checked_at >= ?2
        AND checked_at <= ?3
      ORDER BY checked_at
    `
  )
    .bind(id, rangeStart, rangeEnd)
    .all<{ checked_at: number; status: string; latency_ms: number | null }>();

  const points = (results ?? []).map((r) => ({
    checked_at: r.checked_at,
    status: toCheckStatus(r.status),
    latency_ms: r.latency_ms,
  }));

  const upLatencies = points
    .filter((p) => p.status === 'up' && typeof p.latency_ms === 'number')
    .map((p) => p.latency_ms as number);

  const avg_latency_ms =
    upLatencies.length === 0 ? null : Math.round(upLatencies.reduce((acc, v) => acc + v, 0) / upLatencies.length);

  return c.json({
    monitor: { id: monitor.id, name: monitor.name },
    range,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    avg_latency_ms,
    p95_latency_ms: p95(upLatencies),
    points,
  });
});

type OutageRow = { started_at: number; ended_at: number | null };

publicRoutes.get('/monitors/:id/uptime', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = uptimeRangeSchema.optional().default('24h').parse(c.req.query('range'));

  const monitor = await c.env.DB.prepare(
    `
      SELECT id, name, interval_sec, created_at
      FROM monitors
      WHERE id = ?1 AND is_active = 1
    `
  )
    .bind(id)
    .first<{ id: number; name: string; interval_sec: number; created_at: number }>();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const requestedRangeStart = rangeEnd - rangeToSeconds(range);
  const rangeStart = Math.max(requestedRangeStart, monitor.created_at);

  const total_sec = Math.max(0, rangeEnd - rangeStart);

  const { results: outageRows } = await c.env.DB.prepare(
    `
      SELECT started_at, ended_at
      FROM outages
      WHERE monitor_id = ?1
        AND started_at < ?2
        AND (ended_at IS NULL OR ended_at > ?3)
      ORDER BY started_at
    `
  )
    .bind(id, rangeEnd, rangeStart)
    .all<OutageRow>();

  const downtimeIntervals = mergeIntervals(
    (outageRows ?? [])
      .map((r) => {
        const start = Math.max(r.started_at, rangeStart);
        const end = Math.min(r.ended_at ?? rangeEnd, rangeEnd);
        return { start, end };
      })
      .filter((it) => it.end > it.start)
  );
  const downtime_sec = sumIntervals(downtimeIntervals);

  const checksStart = rangeStart - monitor.interval_sec;
  const { results: checkRows } = await c.env.DB.prepare(
    `
      SELECT checked_at, status
      FROM check_results
      WHERE monitor_id = ?1
        AND checked_at >= ?2
        AND checked_at < ?3
      ORDER BY checked_at
    `
  )
    .bind(id, checksStart, rangeEnd)
    .all<{ checked_at: number; status: string }>();

  const unknownIntervals = buildUnknownIntervals(
    rangeStart,
    rangeEnd,
    monitor.interval_sec,
    (checkRows ?? []).map((r) => ({ checked_at: r.checked_at, status: toCheckStatus(r.status) }))
  );

  // Unknown time is treated as "unavailable" per Application.md; exclude overlap with downtime to avoid double counting.
  const unknown_sec = Math.max(0, sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals));

  const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
  const uptime_sec = Math.max(0, total_sec - unavailable_sec);
  const uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;

  return c.json({
    monitor: { id: monitor.id, name: monitor.name },
    range,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    total_sec,
    downtime_sec,
    unknown_sec,
    uptime_sec,
    uptime_pct,
  });
});

publicRoutes.get('/analytics/uptime', async (c) => {
  const range = uptimeOverviewRangeSchema.optional().default('30d').parse(c.req.query('range'));

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 86400) * 86400; // full days only (UTC)
  const rangeStart = rangeEnd - (range === '30d' ? 30 * 86400 : 90 * 86400);

  const { results: monitorRows } = await c.env.DB.prepare(
    `
      SELECT id, name, type
      FROM monitors
      WHERE is_active = 1
      ORDER BY id
    `
  ).all<{ id: number; name: string; type: string }>();

  const monitors = monitorRows ?? [];

  const { results: sumRows } = await c.env.DB.prepare(
    `
      SELECT
        monitor_id,
        SUM(total_sec) AS total_sec,
        SUM(downtime_sec) AS downtime_sec,
        SUM(unknown_sec) AS unknown_sec,
        SUM(uptime_sec) AS uptime_sec
      FROM monitor_daily_rollups
      WHERE day_start_at >= ?1 AND day_start_at < ?2
      GROUP BY monitor_id
    `
  )
    .bind(rangeStart, rangeEnd)
    .all<{
      monitor_id: number;
      total_sec: number;
      downtime_sec: number;
      unknown_sec: number;
      uptime_sec: number;
    }>();

  const byMonitorId = new Map<number, { total_sec: number; downtime_sec: number; unknown_sec: number; uptime_sec: number }>();
  for (const r of sumRows ?? []) {
    byMonitorId.set(r.monitor_id, {
      total_sec: r.total_sec ?? 0,
      downtime_sec: r.downtime_sec ?? 0,
      unknown_sec: r.unknown_sec ?? 0,
      uptime_sec: r.uptime_sec ?? 0,
    });
  }

  let total_sec = 0;
  let downtime_sec = 0;
  let unknown_sec = 0;
  let uptime_sec = 0;

  const out = monitors.map((m) => {
    const totals = byMonitorId.get(m.id) ?? { total_sec: 0, downtime_sec: 0, unknown_sec: 0, uptime_sec: 0 };
    total_sec += totals.total_sec;
    downtime_sec += totals.downtime_sec;
    unknown_sec += totals.unknown_sec;
    uptime_sec += totals.uptime_sec;
    const uptime_pct = totals.total_sec === 0 ? 0 : (totals.uptime_sec / totals.total_sec) * 100;
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      total_sec: totals.total_sec,
      downtime_sec: totals.downtime_sec,
      unknown_sec: totals.unknown_sec,
      uptime_sec: totals.uptime_sec,
      uptime_pct,
    };
  });

  const overall_uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;

  return c.json({
    generated_at: now,
    range,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    overall: { total_sec, downtime_sec, unknown_sec, uptime_sec, uptime_pct: overall_uptime_pct },
    monitors: out,
  });
});

publicRoutes.get('/health', async (c) => {
  // Minimal DB touch to verify the Worker can connect to D1.
  const db = getDb(c.env);
  await db.select({ id: monitors.id }).from(monitors).limit(1).all();
  return c.json({ ok: true });
});
