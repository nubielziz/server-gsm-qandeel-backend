// What the fixture harvest sends (ALIGNMENT § 8): the name of a fixture file, how a path gets its ids, how a request
// body or query is built from the frontend's own types, and the per-route overrides where the mock layer needs
// something specific. Plain data and pure functions: the Vitest driver (harvest.vitest.mjs) does the calling.

/** `GET /admin/staff/:id` -> `GET_admin_staff_id.json` (the tests find a route's fixture by the same rule). */
export function fixtureFileName(key) {
  const [method = '', path = ''] = key.split(' ');
  const slug = path
    .replaceAll(':', '')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  return `${method}_${slug}.json`;
}

/** The collection (list route) that holds the records a `…Id` field points at. */
const COLLECTION_OF = {
  role: '/admin/roles',
  staff: '/admin/staff',
  client: '/admin/clients',
  merchant: '/admin/clients',
  group: '/admin/client-groups',
  service: '/admin/services',
  supplier: '/admin/suppliers',
  category: '/admin/service-categories',
  order: '/admin/orders',
  plan: '/admin/commission-plans',
  gateway: '/admin/payment-gateways',
  invoice: '/admin/invoices',
  payment: '/admin/payments',
  customer: '/admin/customers',
  currency: '/admin/currencies',
  ticket: '/admin/support-tickets',
  dispute: '/admin/disputes',
  refund: '/admin/refunds',
  template: '/admin/reply-templates',
  agent: '/admin/clients',
  listing: '/admin/service-listings',
  accrual: '/admin/commission-accruals',
  assignment: '/admin/commission-assignments',
  file: '/admin/files',
};

/**
 * Picks a representative id for a field called `roleId`, `clientId`, `id`, ...
 *
 * @param {string} name field or path parameter name
 * @param {string} collection the collection the route belongs to (`/admin/staff`), for a plain `id`
 * @param {Record<string, number | string>} ids first id of each collection seen so far
 */
export function idFor(name, collection, ids) {
  const stem = name.replace(/Id$/, '');
  const own = name === 'id' ? collection : COLLECTION_OF[stem];
  return (own && ids[own]) ?? 1;
}

/** Text for a string field, by name. The mock layer validates little; plausible text keeps its checks happy. */
function textFor(name) {
  if (/email/i.test(name)) return 'harvest.sample@example.com';
  if (/url|endpoint/i.test(name)) return 'https://example.com/hook';
  if (/password/i.test(name)) return 'demo-password-1';
  if (/code|key|slug/i.test(name)) return 'HARVEST-1';
  if (/cidr|ip/i.test(name)) return '203.0.113.7';
  if (/name|title|label/i.test(name)) return 'Harvest sample';
  if (/date|from|to|at$/i.test(name)) return '2026-10-01';
  return 'Harvest sample text.';
}

/**
 * Builds a representative value for a frontend shape: required fields only, the first enum value, ids taken from the
 * records the harvest has seen.
 *
 * @param {object} shape a shape from frontend-endpoints.json
 * @param {string} name the field name, for text and id heuristics
 * @param {{ collection: string, ids: Record<string, number | string> }} ctx
 */
export function valueFor(shape, name, ctx) {
  if (shape.anyOf) return valueFor(shape.anyOf[0], name, ctx);
  if (shape.const !== undefined) return shape.const;
  if (shape.enum) return shape.enum[0];
  if (shape.array) return [valueFor(shape.array, name.replace(/s$/, ''), ctx)];
  if (shape.tuple) return shape.tuple.map((item) => valueFor(item, name, ctx));
  if (shape.object || shape.record) {
    const out = {};
    for (const [key, child] of Object.entries(shape.object ?? {})) {
      if (!child.optional && !child.undefinable) out[key] = valueFor(child, key, ctx);
    }
    return out;
  }
  switch (shape.type) {
    case 'string':
      if (shape.alias === 'Money') return '10.0000';
      if (shape.alias === 'Decimal') return '1.0000';
      if (shape.alias === 'IsoDateTime') return '2026-11-01T00:00:00.000Z';
      return textFor(name);
    case 'number':
      return shape.alias === 'Id' ? idFor(name, ctx.collection, ctx.ids) : 10;
    case 'boolean':
      return false;
    case 'json':
      return {};
    default:
      return null;
  }
}

/**
 * Per-route overrides, where the generated call is not enough. Keys are manifest keys; a value is an object, or a
 * function of what the harvest has read so far (`world`: `ids` first id per collection, `rows` first page of each list,
 * `docs` body of each GET by manifest key). Fields:
 * - `path`: values for path parameters (`{ name: 'orders.dispatch' }`); without it a mutation tries the records of the
 *   collection one after the other until the mock accepts one (a payment that is still pending, an open incident).
 * - `candidates`: `{ list, query }`, a list to read for the records to try (default: the first page of the collection).
 * - `scenario`: a mock scenario to switch on for this route (`degraded` has an open alert and an open incident).
 * - `query`: the query string (default for a list: the first 25 rows).
 * - `body`: merged into the body generated from the frontend type (required fields only).
 * - `bodies`: bodies to try in order, for routes that refuse a record that already exists.
 */
export const OVERRIDES = {
  'GET /admin/dashboard': { query: { scope: 'all', days: 7 } },
  'GET /admin/reports/profit': { query: { groupBy: 'client', from: '2026-10-01', to: '2026-10-31' } },
  'GET /admin/reports/vat': { query: { from: '2026-10-01', to: '2026-10-31' } },
  'GET /admin/reports/top-clients': { query: { days: 7, limit: 5 } },
  'GET /admin/reports/suppliers': { query: { days: 7 } },
  'GET /admin/reports/funnel': { query: { days: 7 } },
  'GET /admin/pricing/resolve': { query: { serviceId: 1, clientId: 1 } },
  'GET /admin/system/queues/:name/failed': (w) => ({ path: { name: queueName(w, true) } }),

  'POST /admin/system/queues/:name/pause': (w) => ({
    path: { name: queueName(w) },
    body: { paused: true, reason: 'Harvest check' },
  }),
  'POST /admin/system/queues/:name/retry': (w) => ({ path: { name: queueName(w, true) }, body: { all: true } }),
  'POST /admin/system/jobs/:name/run': (w) => ({
    path: { name: w.docs['GET /admin/system/jobs']?.[0]?.name ?? 'price_sync' },
  }),
  'POST /admin/payments/:id/approve': { candidates: { list: '/admin/payments', query: { status: 'pending' } } },
  'POST /admin/payments/:id/reject': { candidates: { list: '/admin/payments', query: { status: 'pending' } } },
  'POST /admin/alerts/:id/ack': {
    scenario: 'degraded',
    candidates: { list: '/admin/alerts', query: { status: 'firing' } },
  },
  'PATCH /admin/incidents/:id': {
    scenario: 'degraded',
    candidates: { list: '/admin/incidents', query: { open: true } },
  },
  'POST /admin/disputes/:id/evidence': (w) => ({
    candidates: { list: '/admin/disputes', query: { status: 'needs_response' } },
    // The mock only accepts the keys of the evidence pack the dispute carries.
    body: { items: (w.docs['GET /admin/disputes/:id']?.evidence ?? []).slice(0, 2).map((item) => item.key) },
  }),
  'PUT /admin/risk/rules': (w) => ({ body: { rules: w.docs['GET /admin/risk/rules']?.rules ?? [] } }),

  'POST /admin/alert-rules': {
    body: { key: 'harvest_rule', name: 'Harvest rule', metric: 'api.rate5xx', windowSeconds: 300 },
  },
  'POST /admin/clients': { body: { country: 'GB' } },
  'POST /admin/content-pages': { body: { locale: 'en' } },
  'POST /admin/currencies': { body: { code: 'XTS', decimals: 2 } },
  'POST /admin/customers': { body: { country: 'GB', locale: 'en' } },
  'POST /admin/help-articles': { body: { locale: 'en' } },
  'POST /admin/incidents': (w) => ({
    body: { components: [w.docs['GET /admin/system/health']?.components?.[0]?.key ?? 'api'] },
  }),
  'POST /admin/legal-documents': { body: { type: 'terms', locale: 'en', version: '9.9' } },
  'POST /admin/notification-templates': { body: { event: 'order.completed', locale: 'en' } },
  'POST /admin/payment-gateways': { body: { feePercent: '2.5000' } },
  'POST /admin/reply-templates': { body: { shortcut: '/harvest', locale: 'en' } },
  'POST /admin/service-listings': (w) => ({
    bodies: (w.rows['/admin/services'] ?? []).map((service) => ({
      serviceId: service.id,
      locale: 'en',
      publicTitle: 'Harvest listing',
    })),
  }),
  'POST /admin/services/bulk-price/preview': (w) => ({ body: { serviceIds: [w.ids['/admin/services'] ?? 1] } }),
  'POST /admin/services/bulk-price/apply': (w) => ({ body: { serviceIds: [w.ids['/admin/services'] ?? 1] } }),
  'POST /admin/suppliers/:id/import': (w) => ({
    body: { supplierServiceIds: (w.docs['GET /admin/suppliers/:id/services'] ?? []).slice(0, 2).map((row) => row.id) },
  }),
  'POST /admin/suppliers/:id/import/preview': (w) => ({
    body: { supplierServiceIds: (w.docs['GET /admin/suppliers/:id/services'] ?? []).slice(0, 2).map((row) => row.id) },
  }),
  'POST /admin/tac-catalog': { body: { tac: '35123456', brand: 'Harvest', model: 'H1' } },
  'POST /admin/tax-rates': { body: { country: 'GB' } },
  'POST /admin/client-prices': (w) => ({
    bodies: (w.rows['/admin/clients'] ?? [])
      .slice(0, 4)
      .flatMap((client) =>
        (w.rows['/admin/services'] ?? [])
          .slice(0, 8)
          .map((service) => ({ clientId: client.id, serviceId: service.id, price: '10.0000' })),
      ),
  }),
  'POST /admin/commission-assignments': (w) => ({
    bodies: (w.rows['/admin/clients'] ?? [])
      .slice(0, 8)
      .flatMap((client) =>
        (w.rows['/admin/commission-plans'] ?? [])
          .slice(0, 3)
          .map((plan) => ({ beneficiaryId: client.id, planId: plan.id })),
      ),
  }),
};

/** The name of a queue from `GET /admin/system/queues`; with `failing`, one that has failed jobs. */
function queueName(world, failing = false) {
  const queues = world.docs['GET /admin/system/queues']?.queues ?? [];
  return (failing ? queues.find((queue) => queue.failed > 0) : undefined)?.name ?? queues[0]?.name ?? 'orders.dispatch';
}
