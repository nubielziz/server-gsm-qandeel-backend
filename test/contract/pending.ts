// Routes of the map that are not built yet: the contract tests compare the registry with the route manifest minus this
// list (docs/contract/TESTS.md). Generated once by scripts/gen-contract-pending.mjs; from then on each feature deletes
// the keys of the routes it builds, and route-parity fails if a built route is still listed here.

/**
 * Manifest keys (`METHOD /path`, `DHRU <action>`, `SUPPLIER <call>`, `EVENT <name>`) that have no contract yet.
 *
 * Why: decision 009 and docs/contract/TESTS.md: the registry must equal the manifest, and this list is the part of the
 * manifest that later features still owe, so the gap shrinks to nothing in Phase 4.
 */
export const PENDING: readonly string[] = [
  // identity
  // platform
  // money
  // catalog
  // orders
  // suppliers
  'SUPPLIER accountinfo',
  'SUPPLIER imeiservicelist',
  'SUPPLIER placeimeiorder+placeimeiorderbulk',
  'SUPPLIER getimeiorder+getimeiorderbulk',
  // health
  // customers
  'POST /admin/customers/:id/block',
  'GET /admin/customers/:id/export',
  'POST /admin/customers/:id/anonymize',
  // storefront
  // risk
  'POST /store/v1/me/data-export',
  'POST /store/v1/me/data-delete',
  'GET /admin/data-requests',
  'GET /admin/data-requests/:id',
  'PATCH /admin/data-requests/:id',
  'GET /admin/risk/queue',
  'POST /admin/risk/orders/:id/approve',
  'POST /admin/risk/orders/:id/refund',
  'GET /admin/imei-checks',
  'GET /admin/imei-checks/:id',
  'GET /admin/blocklist',
  'GET /admin/blocklist/:id',
  'POST /admin/blocklist',
  'DELETE /admin/blocklist/:id',
  'GET /admin/risk/rules',
  'PUT /admin/risk/rules',
];
