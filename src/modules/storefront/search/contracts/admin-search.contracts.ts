// Route contracts of the console's search index tools (feature 29, decision 038, plan sections 5.1 and 6): the index status and
// "Rebuild index". Routes beyond the map (`scripts/map-additions/29.mjs`); shapes are the plan's section 6 wire. The rebuild is audited and
// writes its outbox event. Decision 068 retired the synonym, pin, hidden-term, report and preview routes.
import { z } from 'zod';
import { defineRoute, zIsoDateTime } from '../../../../common/contract';

const STAFF_ERRORS = ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED'] as const;

/** `GET /admin/search/index`. */
export const getSearchIndex = defineRoute({
  key: 'GET /admin/search/index',
  summary: 'The search index status',
  description:
    "The engine's state (`ok`, `down`, `not_ready` while the first index is being built, `disabled`), the documents it holds against the " +
    'services the shop may sell (`expectedDocuments`, counted for up to 20 000 services), when it last synced, reconciled and rebuilt, the ' +
    'jobs waiting and failed, whether a rebuild is running and the last error the worker recorded. The version, memory and counts are ' +
    'what the worker last wrote (every reconcile).',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  success: {
    status: 200,
    schema: z.object({
      engine: z.object({
        status: z.enum(['ok', 'down', 'not_ready', 'disabled']),
        version: z.string().nullable(),
        memoryBytes: z.number().int().nullable(),
      }),
      schemaVersion: z.number().int(),
      collection: z.string().nullable(),
      documents: z.number().int().min(0),
      expectedDocuments: z.number().int().min(0),
      lastSyncAt: zIsoDateTime.nullable(),
      lastReconcileAt: zIsoDateTime.nullable(),
      lastRebuildAt: zIsoDateTime.nullable(),
      lastTermsBuildAt: zIsoDateTime.nullable(),
      queued: z.number().int().min(0),
      failed: z.number().int().min(0),
      rebuild: z.object({ running: z.boolean(), startedAt: zIsoDateTime.nullable() }),
      lastError: z.string().nullable(),
    }),
  },
  errors: [...STAFF_ERRORS],
  examples: {
    response: {
      engine: { status: 'ok', version: '30.2', memoryBytes: 104857600 },
      schemaVersion: 2,
      collection: 'gsm_production_services_v2_20261116030000',
      documents: 14,
      expectedDocuments: 14,
      lastSyncAt: '2026-11-16T09:00:00.000Z',
      lastReconcileAt: '2026-11-16T09:00:00.000Z',
      lastRebuildAt: '2026-11-16T03:40:00.000Z',
      lastTermsBuildAt: '2026-11-16T09:20:00.000Z',
      queued: 0,
      failed: 0,
      rebuild: { running: false, startedAt: null },
      lastError: null,
    },
  },
});

/** `POST /admin/search/index/rebuild`. */
export const rebuildSearchIndex = defineRoute({
  key: 'POST /admin/search/index/rebuild',
  summary: 'Rebuild the search index',
  description:
    'Starts a full rebuild of the index into a new collection and swaps it in (the shop search keeps answering meanwhile). `202` with the ' +
    'run; `409 JOB_ALREADY_RUNNING` while one runs; `503 UNAVAILABLE` when search is switched off. Needs `storefront:publish`.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:publish',
  success: { status: 202, schema: z.object({ running: z.boolean(), startedAt: zIsoDateTime }) },
  errors: [...STAFF_ERRORS, 'JOB_ALREADY_RUNNING', 'UNAVAILABLE'],
  examples: { response: { running: true, startedAt: '2026-11-16T09:00:00.000Z' } },
});
