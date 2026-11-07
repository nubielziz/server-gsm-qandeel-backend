// Backend module map: which module owns each table and each map row (so every endpoint has exactly one home).
// Table ownership follows the map's domains A-K; system health takes its five tables from domain G.
// Row rules: an endpoint belongs to the module owning the main table it changes or the resource it returns.

/**
 * Modules of the modular monolith, in build order of their first stage.
 * `tables`: tables the module owns (only it reads/writes them; others call its public service).
 * `additionalTables`: tables the backend adds beyond the map's 66 (MISMATCHES B116 note); owned like the others, but no map row
 * describes them, so slices and route checks ignore them.
 * `rows`: matchers on the row key "<surface> <m> <p>" (string = exact key, RegExp = pattern).
 * Every row must match exactly one module: scripts/build-route-slices.mjs fails on a gap or an overlap.
 */
export const modules = [
  {
    id: 'identity',
    name: 'Identity & access',
    domain: 'A',
    tables: ['staff_users', 'roles', 'clients', 'sessions', 'auth_tokens', 'api_keys', 'kyc_submissions', 'ip_rules'],
    rows: [
      /^admin \S+ \/admin\/(auth|staff|ip-rules|access|roles|permissions|sessions)(\/|$)/,
      'admin CRUD /admin/clients',
      'admin GET /admin/clients/:id/api-keys',
      'admin DELETE /admin/api-keys/:id',
      /^admin \S+ \/admin\/kyc-submissions(\/|$)/,
      /^client \S+ \/client\/(auth|profile|security|sessions|api-keys|kyc)(\/|$)/,
    ],
  },
  {
    id: 'platform',
    name: 'Platform (settings, audit, files, notifications, webhooks, outbox)',
    domain: 'G',
    tables: ['settings', 'notification_templates', 'notifications', 'webhook_endpoints', 'webhook_deliveries', 'outbox_events', 'audit_logs', 'files'],
    rows: [
      /^admin \S+ \/admin\/(audit-logs|settings|files|dashboard|webhook-deliveries|notification-templates|notifications)(\/|$)/,
      /^client \S+ \/client\/(files|webhooks|notification-preferences|telegram)(\/|$)/,
      /^v1 \S+ \/v1\/files(\/|$)/,
      'hooks POST /webhooks/telegram/:secret',
      /^system GET \/(openapi\.json|docs)$/,
    ],
  },
  {
    id: 'money',
    name: 'Money (ledger, wallets, invoices, payments, refunds, disputes, tax, currencies)',
    domain: 'E',
    tables: [
      'currencies', 'ledger_accounts', 'ledger_transactions', 'ledger_entries', 'invoices', 'payment_gateways',
      'payments', 'withdrawal_requests', 'refunds', 'disputes', 'tax_rates',
    ],
    rows: [
      /^admin \S+ \/admin\/clients\/:id\/(wallet|statement|credit-limit)(\/|$)/,
      /^admin \S+ \/admin\/(ledger|currencies|payment-gateways|invoices|payments|tax-rates|refunds|disputes)(\/|$)/,
      /^admin GET \/admin\/reports\/(profit|wallet-exposure|client-statement|vat|payments)(\/|$)/,
      /^client \S+ \/client\/(wallet|payment-methods|invoices)(\/|$)/,
      /^v1 GET \/v1\/(account|transactions)$/,
      'dhru ACTION accountinfo',
      /^hooks POST \/webhooks\/(payments|disputes)\//,
      /^events EVENT (wallet|invoice)\./,
    ],
  },
  {
    id: 'catalog',
    name: 'Catalog & pricing',
    domain: 'B',
    tables: [
      'client_groups', 'service_categories', 'services', 'service_fields', 'service_options', 'service_group_prices',
      'service_client_prices', 'pricing_rules', 'inventory_codes', 'tac_catalog',
    ],
    additionalTables: ['listed_prices'],
    rows: [
      /^admin \S+ \/admin\/(client-groups|service-categories|client-prices|pricing-rules|pricing|inventory-codes|tac-catalog)(\/|$)/,
      'admin CRUD /admin/services',
      /^admin \S+ \/admin\/services\/(:id\/(fields|options|group-prices|inventory\/import)|bulk-price\/)/,
      /^client GET \/client\/(services|prices)(\/|$)/,
      /^v1 GET \/v1\/services(\/|$)/,
      'dhru ACTION imeiservicelist',
    ],
  },
  {
    id: 'orders',
    name: 'Orders (one engine for B2B and B2C)',
    domain: 'D',
    tables: ['orders', 'order_events'],
    rows: [
      /^admin \S+ \/admin\/orders(\/|$)/,
      'admin GET /admin/reports/top-clients',
      /^client \S+ \/client\/(dashboard|orders)(\/|$)/,
      /^v1 \S+ \/v1\/orders(\/|$)/,
      /^dhru ACTION (place|get)(imei|file)order/,
      /^store GET \/store\/v1\/orders\//,
      'store GET /store/v1/me/orders',
      'events EVENT order.status_changed',
    ],
  },
  {
    id: 'suppliers',
    name: 'Suppliers',
    domain: 'C',
    tables: ['suppliers', 'supplier_services', 'service_supplier_links', 'supplier_api_logs'],
    rows: [
      /^admin \S+ \/admin\/(suppliers|supplier-api-logs)(\/|$)/,
      'admin PUT /admin/services/:id/supplier-links',
      'admin GET /admin/reports/suppliers',
      /^supplier /,
    ],
  },
  {
    id: 'health',
    name: 'System health (checks, alerts, incidents, jobs, queues)',
    domain: 'G',
    tables: ['service_checks', 'alert_rules', 'alert_events', 'incidents', 'job_runs'],
    rows: [/^admin \S+ \/admin\/(system|alert-rules|alerts|incidents|queues)(\/|$)/, /^system GET \/(health|metrics)$/],
  },
  {
    id: 'commissions',
    name: 'Commissions & referrals',
    domain: 'F',
    tables: ['commission_plans', 'commission_assignments', 'commission_accruals'],
    rows: [/^admin \S+ \/admin\/commission-/, /^client GET \/client\/(referrals|commissions)$/],
  },
  {
    id: 'customers',
    name: 'Storefront customers & checkout (B2C)',
    domain: 'I',
    tables: ['customers', 'customer_credentials', 'checkout_sessions', 'consent_records'],
    rows: [
      /^admin \S+ \/admin\/(customers|checkouts)(\/|$)/,
      'admin GET /admin/reports/funnel',
      /^store \S+ \/store\/v1\/(checkout-sessions|auth)(\/|$)/,
      /^store \S+ \/store\/v1\/me(\/password)?$/,
    ],
  },
  {
    id: 'storefront',
    name: 'Storefront & content',
    domain: 'H',
    tables: ['service_listings', 'content_pages', 'help_articles', 'legal_documents'],
    rows: [
      /^admin \S+ \/admin\/(service-listings|content-pages|help-articles|legal-documents|storefront)(\/|$)/,
      /^store GET \/store\/v1\/(config|services|pages|help)(\/|$)/,
    ],
  },
  {
    id: 'support',
    name: 'Support',
    domain: 'J',
    tables: ['support_tickets', 'ticket_messages', 'reply_templates'],
    rows: [/^admin \S+ \/admin\/(support-tickets|reply-templates)(\/|$)/, /^store \S+ \/store\/v1\/tickets(\/|$)/],
  },
  {
    id: 'risk',
    name: 'Risk & compliance',
    domain: 'K',
    tables: ['imei_checks', 'risk_assessments', 'blocklist_entries', 'data_requests'],
    rows: [
      /^admin \S+ \/admin\/(risk|imei-checks|blocklist|data-requests)(\/|$)/,
      'store POST /store/v1/imei/check',
      /^store POST \/store\/v1\/me\/data-(export|delete)$/,
    ],
  },
];

/** Returns the ids of every module whose matchers accept the row key (the caller requires exactly one). */
export function modulesForRow(key) {
  return modules.filter((m) => m.rows.some((r) => (typeof r === 'string' ? r === key : r.test(key)))).map((m) => m.id);
}
