// Sample addition rows for test/unit/map-additions.test.ts (stage 99 belongs to the tooling test): never loaded by the real tools.
// Four rows, five endpoints: one console-called action, one public Turnstile route, one CRUD row, and a row whose path matches
// another module's matcher (its own `module` must win). One row flag (feature 24A): Turnstile added to a public map row.
import { R } from '../../../../scripts/lib/map-additions.mjs';

export const rows = [
  R(
    'admin',
    'ops',
    'POST',
    '/admin/w0-sample/:id/ping',
    'اختبار الأدوات: نبضة',
    'settings:update',
    99,
    ['settings', 'audit_logs'],
    {
      en: 'Tooling sample: ping.',
      module: 'platform',
      spec: 'B-TBD w0-sample-ping',
      successStatus: 204,
    },
  ),
  R(
    'store',
    'catalog',
    'POST',
    '/store/v1/w0-sample/check',
    'اختبار الأدوات: فحص عام',
    'عام + Turnstile',
    99,
    ['services', 'listed_prices'],
    {
      en: 'Tooling sample: public check behind Turnstile.',
      module: 'catalog',
      spec: 'B-TBD w0-sample-check',
    },
  ),
  R('admin', 'ops', 'CRUD', '/admin/w0-samples', 'اختبار الأدوات: قائمة وإنشاء', 'settings:*', 99, ['settings'], {
    ops: 'LC',
    en: 'Tooling sample: list and create.',
    module: 'platform',
    spec: 'B-TBD w0-sample-crud',
    successStatus: { L: 200, C: 201 },
  }),
  R(
    'admin',
    'clients',
    'GET',
    '/admin/customers/:id/w0-sample',
    'اختبار الأدوات: قراءة المحفظة',
    'wallet:read',
    99,
    ['ledger_accounts', 'idempotency_keys'],
    {
      en: 'Tooling sample: read a customer wallet figure.',
      module: 'money',
      spec: 'B-TBD w0-sample-wallet',
    },
  ),
];

export const rowFlags = [
  { row: 'client POST /client/auth/password/reset', turnstile: true, spec: 'B-TBD w0-sample-flag' },
];
