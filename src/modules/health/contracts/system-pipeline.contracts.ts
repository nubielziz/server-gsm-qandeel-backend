// Route contracts of the pipeline and data store pages: `GET /admin/system/orders-health`, `/suppliers`, `/database` and `/cache`
// (docs/contract/endpoints/health.md; resolutions orders-suppliers-1, -5, health-commissions-8, -10, -17).
import { z } from 'zod';
import { defineRoute, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { METRIC_STATES, zCheckStatus, zMeasure, zSeriesPoint, zServiceType } from './system-common';

/** `GET /admin/system/orders-health`: orders past their SLA, dispatch time, outcomes per service type and held orders. */
export const getOrdersHealth = defineRoute({
  key: 'GET /admin/system/orders-health',
  summary: 'Order pipeline health',
  description:
    "`stuck.total` counts open orders older than their service's SLA (the one age-only past-SLA rule shared with `GET /admin/orders?pastSla=true`, warn 5, crit 20); `heldAmount` is the money held for them. `byStatus` has one row per status bucket that has orders: " +
    '`pending`, `processing` or `needs_attention` (an order in the needs-attention queue is counted there only). `trend` is 96 points of 15 minutes of the past-SLA count over 24 hours. `needsAttention` counts every order in that queue. ' +
    '`dispatchP95` is the 95th percentile of seconds from placement to the supplier call over 24 hours. `byServiceType` has one row per type (finished orders of the last 24 hours with success and failure percentages). ' +
    '`heldByRisk` is the paid storefront orders the risk rules hold.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  success: {
    status: 200,
    schema: z.object({
      checkedAt: zIsoDateTime,
      stuck: z.object({
        total: zMeasure,
        heldAmount: zMoney,
        byStatus: z.array(
          z.object({
            status: z.string(),
            label: z.string(),
            count: z.number().int(),
            oldestAgeSeconds: z.number().int().nullable(),
            heldAmount: zMoney,
          }),
        ),
        trend: z.array(zSeriesPoint),
      }),
      needsAttention: z.number().int(),
      dispatchP95: zMeasure,
      byServiceType: z.array(
        z.object({ type: zServiceType, total: z.number().int(), success: zMeasure, failure: zMeasure }),
      ),
      heldByRisk: z.object({ count: z.number().int(), amount: zMoney, oldestAt: zIsoDateTime.nullable() }),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'DATABASE_UNAVAILABLE'],
});

/** `GET /admin/system/suppliers`: the health of each supplier. */
export const getSuppliersHealth = defineRoute({
  key: 'GET /admin/system/suppliers',
  summary: 'Supplier health',
  description:
    'One row per supplier, whatever its status. `status` is the switch (`active`, `disabled`, `paused`); `health` is the latest check of `supplier:<id>` (a disabled supplier is `unknown`, a paused one keeps its checks). ' +
    '`errorRate` and `timeoutRate` are the shares of the last 15 minutes of calls with outcome `error` and `timeout` (separate: a timeout is not also an error; `{value null, state unknown}` without calls). `lastSuccessAt` is the latest call that worked. ' +
    '`circuit` is `closed` (the outbound client has no circuit breaker yet). `lastSyncAt` is the later of the balance check and the price sync. `balance.state` is the low-balance verdict of the suppliers page.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  success: {
    status: 200,
    schema: z.object({
      checkedAt: zIsoDateTime,
      suppliers: z.array(
        z.object({
          id: zId,
          name: z.string(),
          status: z.enum(['active', 'disabled', 'paused']),
          health: zCheckStatus,
          since: zIsoDateTime.nullable(),
          lastSuccessAt: zIsoDateTime.nullable(),
          latency: zMeasure,
          errorRate: zMeasure,
          timeoutRate: zMeasure,
          circuit: z.enum(['closed', 'open', 'half_open']),
          lastSyncAt: zIsoDateTime.nullable(),
          balance: z.object({
            amount: zMoney,
            currency: z.string(),
            state: z.enum(METRIC_STATES),
            checkedAt: zIsoDateTime.nullable(),
          }),
        }),
      ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'DATABASE_UNAVAILABLE'],
});

/** `GET /admin/system/database`: Postgres connections, locks, size, migrations, slow queries and long transactions. */
export const getDatabaseHealth = defineRoute({
  key: 'GET /admin/system/database',
  summary: 'Postgres health',
  description:
    "`connections.usage` is sessions over `max_connections` (warn 70, crit 90); `waitingClients` is the application pool's waiting count; `poolWait` is `{value null, state unknown}` until the pool wait is measured. `locks` counts ungranted locks and the longest wait. " +
    '`replicaLag` is `null` without a replica. `size.growthPerDayBytes` comes from a daily size sample (`null` until two samples exist). `pendingMigrations` lists bundled migrations not applied. `slowQueries` is the top 10 of `pg_stat_statements` ' +
    'by mean time (empty when the extension is not installed; `id` is the query id as a string) and `longTransactions` the sessions whose transaction is older than 60 seconds. No hostnames or credentials are sent. When Postgres cannot be read the route answers `200` with status `down`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  success: {
    status: 200,
    schema: z.object({
      status: zCheckStatus,
      connections: z.object({
        used: z.number().int(),
        max: z.number().int(),
        usage: zMeasure,
        poolWait: zMeasure,
        waitingClients: z.number().int(),
      }),
      locks: z.object({ waiting: z.number().int(), longestWait: zMeasure }),
      replicaLag: zMeasure.nullable(),
      size: z.object({ bytes: z.number(), growthPerDayBytes: z.number().nullable() }),
      pendingMigrations: z.array(z.string()),
      slowQueries: z.array(
        z.object({ id: z.string(), query: z.string(), calls: z.number(), meanMs: z.number(), totalMs: z.number() }),
      ),
      longTransactions: z.array(
        z.object({ pid: z.number().int(), durationSeconds: z.number(), state: z.string(), query: z.string() }),
      ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
});

/** `GET /admin/system/cache`: the cache Redis. */
export const getCacheHealth = defineRoute({
  key: 'GET /admin/system/cache',
  summary: 'Cache Redis health',
  description:
    'The cache Redis (the queue Redis is the `redis_queue` component): `memory.usage` is `used_memory` over `maxmemory` (`maxBytes` null and `usage.value` null without a limit), `evictionsPerMin` and `hitRate` are worked out from the counters ' +
    'the checker stores each minute (not since restart), `clients` is `connected_clients` and `latency` a `PING` round trip. When Redis is down the status is `down`, every measure is `{value null, state unknown}` and `usedBytes` is 0.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  success: {
    status: 200,
    schema: z.object({
      status: zCheckStatus,
      memory: z.object({ usedBytes: z.number(), maxBytes: z.number().nullable(), usage: zMeasure }),
      evictionsPerMin: zMeasure,
      hitRate: zMeasure,
      clients: zMeasure,
      latency: zMeasure,
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
});
