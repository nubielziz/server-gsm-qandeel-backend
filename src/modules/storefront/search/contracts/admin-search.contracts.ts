// Route contracts of the console's search tools (feature 29, decision 038, plan sections 5.1 and 6): synonyms, pinned and hidden results,
// the hidden popular terms, the search report, a preview, and the index status with "Rebuild index". Routes beyond the map
// (`scripts/map-additions/29.mjs`); shapes are the plan's section 6 wire. Every write is audited and writes its outbox event.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../../common/contract';
import { SEARCH_PIN_MATCHES, SEARCH_SYNONYM_KINDS } from '../../db/schema';

const STAFF_ERRORS = ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED'] as const;

/** The most terms of a synonym and the length of each (the table's own checks). */
export const SYNONYM_TERMS = { min: 2, max: 20, length: 60 } as const;
/** The most pinned and hidden services of a pin rule, and the highest pinned position. */
export const PIN_LIMITS = { pinned: 10, hidden: 50, position: 10 } as const;

const Note = z.string().trim().max(300, 'Use at most 300 characters.');

/** A synonym as the console reads it. */
const SynonymRow = z.object({
  id: zId,
  kind: z.enum(SEARCH_SYNONYM_KINDS),
  root: z.string().nullable().describe('The word that expands to `terms` (one-way synonyms only).'),
  terms: z.array(z.string()),
  isEnabled: z.boolean(),
  note: z.string(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});

const SYNONYM_EXAMPLE = {
  id: 1,
  kind: 'multi',
  root: null,
  terms: ['frp', 'google account lock', 'frp lock'],
  isEnabled: true,
  note: '',
  createdAt: '2026-11-16T09:00:00.000Z',
  updatedAt: '2026-11-16T09:00:00.000Z',
} as const;

const SynonymFields = {
  kind: z.enum(SEARCH_SYNONYM_KINDS),
  root: z.string().trim().max(SYNONYM_TERMS.length).nullable().optional(),
  terms: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(SYNONYM_TERMS.length * 2),
    )
    .min(SYNONYM_TERMS.min)
    .max(SYNONYM_TERMS.max),
  isEnabled: z.boolean().optional(),
  note: Note.optional(),
};

/** `GET /admin/search/synonyms`. */
export const listSearchSynonyms = defineRoute({
  key: 'GET /admin/search/synonyms',
  summary: 'List the search synonyms',
  description:
    'The words the shop search treats as the same (`frp` and `google account lock`). `q` searches the terms; `isEnabled` filters; ' +
    'sort by `updatedAt` (default, newest first) or `id`. A change reaches the shop within a minute.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: listQuery({
    sorts: ['updatedAt', 'id'],
    defaultSort: { field: 'updatedAt', order: 'desc' },
    filters: { isEnabled: { type: 'boolean', ops: ['eq'] } },
    search: ['terms'],
  }),
  success: { status: 200, schema: SynonymRow },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED'],
  examples: { response: [SYNONYM_EXAMPLE] },
});

/** `POST /admin/search/synonyms`. */
export const createSearchSynonym = defineRoute({
  key: 'POST /admin/search/synonyms',
  summary: 'Create a search synonym',
  description:
    'Terms are lower-cased and cleaned like a query (`AT&T` becomes `att`), at most 60 characters each, 2 to 20 distinct. A `multi` ' +
    'synonym means every term means the others; a `one_way` synonym needs a `root` that expands to the terms. The write is audited and ' +
    'reaches the shop within a minute.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  body: z.object(SynonymFields),
  success: { status: 201, schema: SynonymRow },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED'],
  examples: {
    request: { kind: 'multi', terms: ['frp', 'google account lock'] },
    response: SYNONYM_EXAMPLE,
  },
});

/** `PATCH /admin/search/synonyms/:id`. */
export const updateSearchSynonym = defineRoute({
  key: 'PATCH /admin/search/synonyms/:id',
  summary: 'Change a search synonym',
  description: 'Only the keys sent change; the rules of the create apply to the result.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    kind: SynonymFields.kind.optional(),
    root: SynonymFields.root,
    terms: SynonymFields.terms.optional(),
    isEnabled: SynonymFields.isEnabled,
    note: SynonymFields.note,
  }),
  success: { status: 200, schema: SynonymRow },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED', 'NOT_FOUND'],
  examples: { request: { isEnabled: false }, response: { ...SYNONYM_EXAMPLE, isEnabled: false } },
});

/** `DELETE /admin/search/synonyms/:id`. */
export const deleteSearchSynonym = defineRoute({
  key: 'DELETE /admin/search/synonyms/:id',
  summary: 'Delete a search synonym',
  description: 'The synonym is gone from the shop search within a minute.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: [...STAFF_ERRORS, 'NOT_FOUND'],
});

/** A pinned service of a rule, with its title for display. */
const PinnedRow = z.object({
  serviceId: zId,
  position: z.number().int().min(1).max(PIN_LIMITS.position),
  title: z.string(),
});

/** A pin rule as the console reads it. */
const PinRow = z.object({
  id: zId,
  query: z.string(),
  match: z.enum(SEARCH_PIN_MATCHES),
  pinned: z.array(PinnedRow),
  hidden: z.array(z.object({ serviceId: zId, title: z.string() })),
  startsAt: zIsoDateTime.nullable(),
  endsAt: zIsoDateTime.nullable(),
  isEnabled: z.boolean(),
  note: z.string(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});

const PIN_EXAMPLE = {
  id: 1,
  query: 'unlock',
  match: 'exact',
  pinned: [{ serviceId: 7, position: 1, title: 'iPhone 15 Pro Max Unlock' }],
  hidden: [],
  startsAt: null,
  endsAt: null,
  isEnabled: true,
  note: '',
  createdAt: '2026-11-16T09:00:00.000Z',
  updatedAt: '2026-11-16T09:00:00.000Z',
} as const;

const PinFields = {
  query: z.string().trim().min(1).max(200),
  match: z.enum(SEARCH_PIN_MATCHES),
  pinned: z
    .array(z.object({ serviceId: zId, position: z.number().int().min(1).max(PIN_LIMITS.position) }))
    .max(PIN_LIMITS.pinned),
  hidden: z.array(zId).max(PIN_LIMITS.hidden),
  startsAt: zIsoDateTime.nullable().optional(),
  endsAt: zIsoDateTime.nullable().optional(),
  isEnabled: z.boolean().optional(),
  note: Note.optional(),
};

/** `GET /admin/search/pins`. */
export const listSearchPins = defineRoute({
  key: 'GET /admin/search/pins',
  summary: 'List the pinned search results',
  description:
    'Rules that put chosen services first (or hide some) for a query. `q` searches the rule query; `isEnabled` filters; sort by ' +
    '`updatedAt` (default, newest first) or `query`.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: listQuery({
    sorts: ['updatedAt', 'query'],
    defaultSort: { field: 'updatedAt', order: 'desc' },
    filters: { isEnabled: { type: 'boolean', ops: ['eq'] } },
    search: ['query'],
  }),
  success: { status: 200, schema: PinRow },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED'],
  examples: { response: [PIN_EXAMPLE] },
});

/** `POST /admin/search/pins`. */
export const createSearchPin = defineRoute({
  key: 'POST /admin/search/pins',
  summary: 'Create a pinned search result',
  description:
    'The query is cleaned like a search (at most 100 characters). `exact` matches the whole query, `contains` any query that holds it. ' +
    'Up to 10 pinned services (positions 1-10, distinct) and 50 hidden ones; each must have a switched-on English page (`422` on ' +
    '`pinned.N.serviceId` or `hidden.N` otherwise). A query and match type exist once (`409 CONFLICT`). The optional window sets when ' +
    'the rule applies.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  body: z.object(PinFields),
  success: { status: 201, schema: PinRow },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED', 'CONFLICT'],
  examples: {
    request: { query: 'unlock', match: 'exact', pinned: [{ serviceId: 7, position: 1 }], hidden: [] },
    response: PIN_EXAMPLE,
  },
});

/** `PATCH /admin/search/pins/:id`. */
export const updateSearchPin = defineRoute({
  key: 'PATCH /admin/search/pins/:id',
  summary: 'Change a pinned search result',
  description: 'Only the keys sent change; the rules of the create apply to the result.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    query: PinFields.query.optional(),
    match: PinFields.match.optional(),
    pinned: PinFields.pinned.optional(),
    hidden: PinFields.hidden.optional(),
    startsAt: PinFields.startsAt,
    endsAt: PinFields.endsAt,
    isEnabled: PinFields.isEnabled,
    note: PinFields.note,
  }),
  success: { status: 200, schema: PinRow },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT'],
  examples: { request: { isEnabled: false }, response: { ...PIN_EXAMPLE, isEnabled: false } },
});

/** `DELETE /admin/search/pins/:id`. */
export const deleteSearchPin = defineRoute({
  key: 'DELETE /admin/search/pins/:id',
  summary: 'Delete a pinned search result',
  description: 'The rule is gone from the shop search within a minute.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: [...STAFF_ERRORS, 'NOT_FOUND'],
});

/** A term kept out of the popular searches. */
const HiddenTermRow = z.object({ id: zId, term: z.string(), note: z.string(), createdAt: zIsoDateTime });

/** `GET /admin/search/hidden-terms`. */
export const listHiddenSearchTerms = defineRoute({
  key: 'GET /admin/search/hidden-terms',
  summary: 'List the hidden popular searches',
  description:
    'Terms staff keep out of the popular searches. `q` searches the term; sort by `createdAt` (default, newest first) or `term`.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: listQuery({
    sorts: ['createdAt', 'term'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    search: ['term'],
  }),
  success: { status: 200, schema: HiddenTermRow },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED'],
  examples: { response: [{ id: 1, term: 'cheap phones', note: '', createdAt: '2026-11-16T09:00:00.000Z' }] },
});

/** `POST /admin/search/hidden-terms`. */
export const createHiddenSearchTerm = defineRoute({
  key: 'POST /admin/search/hidden-terms',
  summary: 'Hide a term from the popular searches',
  description:
    'The term is cleaned like a search. It leaves the popular searches within a minute. A term hidden twice is `409 CONFLICT`.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  body: z.object({ term: z.string().trim().min(1).max(64), note: Note.optional() }),
  success: { status: 201, schema: HiddenTermRow },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED', 'CONFLICT'],
  examples: {
    request: { term: 'cheap phones' },
    response: { id: 1, term: 'cheap phones', note: '', createdAt: '2026-11-16T09:00:00.000Z' },
  },
});

/** `DELETE /admin/search/hidden-terms/:id`. */
export const deleteHiddenSearchTerm = defineRoute({
  key: 'DELETE /admin/search/hidden-terms/:id',
  summary: 'Show a hidden term again',
  description: 'The term may become a popular search again.',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: [...STAFF_ERRORS, 'NOT_FOUND'],
});

/** `GET /admin/search/report`. */
export const getSearchReport = defineRoute({
  key: 'GET /admin/search/report',
  summary: 'The search report',
  description:
    'What visitors searched for in the last 7, 30 or 90 days: the totals, the 50 most searched terms and the 50 terms that most often ' +
    'found nothing. Counts are per day and term with an estimate of distinct visitors per day (no address, user or session is kept; an ' +
    "IMEI, phone number, email or link is never counted). `visitors` adds the days' distinct visitors.",
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: z
    .object({
      days: z
        .enum(['7', '30', '90'])
        .default('30')
        .transform((value) => Number(value)),
    })
    .strict(),
  success: {
    status: 200,
    schema: z.object({
      days: z.number().int(),
      totals: z.object({
        searches: z.number().int().min(0),
        zeroResults: z.number().int().min(0),
        terms: z.number().int().min(0),
      }),
      topTerms: z.array(
        z.object({
          term: z.string(),
          searches: z.number().int().min(0),
          visitors: z.number().int().min(0),
          zeroResults: z.number().int().min(0),
        }),
      ),
      zeroResultTerms: z.array(
        z.object({ term: z.string(), searches: z.number().int().min(0), lastSeen: zIsoDateTime }),
      ),
    }),
  },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED'],
  examples: {
    response: {
      days: 30,
      totals: { searches: 120, zeroResults: 9, terms: 12 },
      topTerms: [{ term: 'samsung frp', searches: 40, visitors: 31, zeroResults: 0 }],
      zeroResultTerms: [{ term: 'blackberry', searches: 4, lastSeen: '2026-11-15T00:00:00.000Z' }],
    },
  },
});

/** `GET /admin/search/preview`. */
export const previewSearch = defineRoute({
  key: 'GET /admin/search/preview',
  summary: 'Preview a search',
  description:
    'The first 10 services the shop search returns for a query, with the rules applied: `pinned` marks a hit a pin put there and ' +
    '`hiddenIds` lists the services a rule keeps out of this query. Staff test a rule before leaving it. `503 UNAVAILABLE` when the ' +
    'search engine does not answer (a preview has no fallback).',
  tags: ['search'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: z.object({ q: z.string().trim().min(1).max(200) }).strict(),
  success: {
    status: 200,
    schema: z.object({
      engine: z.literal('typesense'),
      hits: z.array(
        z.object({ serviceId: zId, title: z.string(), position: z.number().int().min(1), pinned: z.boolean() }),
      ),
      hiddenIds: z.array(zId),
    }),
  },
  errors: [...STAFF_ERRORS, 'VALIDATION_FAILED', 'UNAVAILABLE'],
  examples: {
    response: {
      engine: 'typesense',
      hits: [{ serviceId: 7, title: 'iPhone 15 Pro Max Unlock', position: 1, pinned: true }],
      hiddenIds: [12],
    },
  },
});

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
      schemaVersion: 1,
      collection: 'gsm_production_services_v1_20261116030000',
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
