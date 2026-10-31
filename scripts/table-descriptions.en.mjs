// English descriptions of the 66 tables in reference/gsm-map/data/schema.mjs (the map's own text is Arabic).
// Copied from the frontend (scripts/table-descriptions.en.mjs); the slices script puts them next to each table.

export const tableDescriptions = {
  // A. Identity and permissions
  staff_users:
    'Admin console staff. Two-factor authentication is mandatory. Status is invited until the first sign-in, then active, or suspended (a reversible stop that ends the sessions and keeps the record). The last owner and the staff member themselves cannot be suspended. Allowed addresses live in ip_rules, not in a column.',
  roles: 'Roles and their permissions (RBAC).',
  clients: 'B2B merchants; username is the Dhru username.',
  sessions: 'Sign-in sessions for staff, merchants and customers (magic link).',
  auth_tokens:
    'One-time tokens for invite and password-reset links for merchants, customers and staff, and for link sign-in and email verification: hash only, valid for one hour and one use.',
  api_keys: 'Merchant API keys, stored as a hash.',
  kyc_submissions: 'Merchant identity-verification (KYC) requests.',
  ip_rules:
    'Network rules checked before any other logic: allow addresses for the admin console, and block an address or range for one audience (storefront, API or admin) or for all. A block beats an allow. Restricting the console to the allowlist is a switch in settings. Active rules are loaded into Redis, so no query runs per request.',

  // B. Catalog and pricing
  client_groups:
    'Merchant groups with their discount percentages and promotion limits; kind = b2c_retail marks the single retail group used by the storefront.',
  service_categories: 'Service categories; equal to GROUPNAME in Dhru.',
  services: 'Services; id equals SERVICEID.',
  service_fields: 'Custom fields of a service; equal to Requires.Custom.',
  service_options: 'Lists of models, providers and MEP values for a service.',
  service_group_prices: 'The price of a service per merchant group, including the storefront Retail price.',
  service_client_prices: 'A negotiated price of a service for one specific merchant.',
  pricing_rules: 'Margin and discount rules for automatic pricing.',
  inventory_codes: 'Stock of digital codes.',
  tac_catalog:
    'The first 8 digits of an IMEI (TAC) with brand and model; used for automatic recognition, IMEI checks and SEO pages.',

  // C. Suppliers
  suppliers: 'Supplier connections and your balance with each one.',
  supplier_services: "A copy of a supplier's services after a sync.",
  service_supplier_links: 'Links your service to a supplier service, in priority order.',
  supplier_api_logs: 'A log of every request sent to a supplier.',

  // D. Orders
  orders:
    'Orders; id equals REFERENCEID. client_id accepts null for storefront (B2C) orders, which fill customer_id instead; exactly one of the two is set.',
  order_events: 'The order timeline; append only.',

  // E. Money
  currencies:
    'Currencies and exchange rates, with a markup and psychological (charm) rounding for the storefront display.',
  ledger_accounts: 'Accounts: wallet, hold, revenue, customer funds and tax payable.',
  ledger_transactions: 'The journal entry header, with an idempotency key.',
  ledger_entries: 'Journal entry lines; they always sum to zero.',
  invoices: 'Top-up invoices and statements, and B2C tax receipts with a PDF copy.',
  payment_gateways: 'Payment gateways with their fees and limits, split by audience (B2B or B2C).',
  payments: 'Payments and their confirmation: a wallet top-up or a B2C order payment.',
  withdrawal_requests: 'Withdrawal requests, for a later phase.',
  refunds: 'Refunds: full or partial, to the card, the wallet or store credit.',
  disputes: 'Chargeback disputes: the deadline, the evidence pack and the outcome.',
  tax_rates: 'Tax rates per country for digital services, including the OSS scheme.',

  // F. Commissions
  commission_plans: 'Referral and cashback plans.',
  commission_assignments: 'Links a plan to the merchant who benefits from it.',
  commission_accruals: 'Commissions owed and paid out.',

  // G. Platform
  settings: 'System settings as key and value pairs.',
  notification_templates: 'Email and Telegram templates for staff, merchants and customers.',
  notifications: 'A log of the notifications that were sent.',
  webhook_endpoints: 'Webhook URLs registered by merchants.',
  webhook_deliveries: 'Attempts to deliver webhooks.',
  outbox_events: 'Events waiting to be processed by the worker.',
  audit_logs: 'The audit log of admin actions.',
  files: 'S3 files and their metadata.',

  // H. Storefront and content
  service_listings: 'The public service page in the storefront: title, slug and SEO fields per language.',
  content_pages: 'Landing pages, static pages and the blog, in several languages.',
  help_articles: 'The help centre and FAQ; an article can be linked to a service.',
  legal_documents: 'Terms, privacy, refund and cookie documents, with archived versions.',

  // I. B2C customers
  customers:
    'Storefront customers: a guest with an email, or an account with a password or a sign-in link. Status is active, suspended (a reversible pause), blocked (fraud) or anonymized.',
  customer_credentials:
    'Account sign-in data, kept apart from the profile: hash only. A temporary password set by a staff member forces a change at first sign-in, and nobody can read the current password.',
  checkout_sessions:
    'The payment session before any order exists: the price, tax and exchange rate are locked in, and the order is created after payment.',
  consent_records:
    'Proof of consent: terms, privacy, marketing and the withdrawal-right waiver, with the IP address and the time.',

  // J. Support
  support_tickets:
    'Support tickets from storefront customers and merchants, linked to an order, with an SLA deadline.',
  ticket_messages: 'Ticket messages from the customer, a staff member or the system, plus internal notes.',
  reply_templates: 'Ready-made reply templates for staff, by category and language.',

  // K. Risk and compliance
  imei_checks: 'IMEI checks: blacklist, lock and iCloud, free or before an order, with a cache.',
  risk_assessments:
    'Risk assessment of a session or an order: a score, signals and a decision (allow, review or block).',
  blocklist_entries:
    'The blocklist: email, domain, IMEI, card fingerprint, device and country. IP addresses live in ip_rules.',
  data_requests: 'Data-subject requests: export or deletion, with a legal deadline.',
  // G. System health and alerting (domain G in the map)
  service_checks:
    'Results of the periodic health checks: every minute the worker checks the database, the cache, storage, every supplier and every payment gateway, and writes the status and the response time. Uptime is computed from these rows and outages are detected from them. High-resolution metrics (requests, latency) are not stored here but in the monitoring system. Rows are deleted after 90 days.',
  alert_rules:
    'Alert rules: metric, comparator, threshold, window, severity and channels (Telegram or email). A temporary mute, for example during maintenance, uses muted_until.',
  alert_events:
    'Each time a rule fires: firing, then acknowledged, then resolved. It closes on its own when the value is back in range, and the message is not repeated until a staff member acknowledges it or the reminder interval passes.',
  incidents:
    'Operational incidents: declared by a staff member or opened from a critical alert. Severity, affected components, the timeline (timeline jsonb), and the root cause and action taken at closing.',
  job_runs:
    'Run log of scheduled and background jobs (price sync, ledger integrity check, expired-data deletion, reminders): start, end, result and error. result holds the job summary; the last money integrity result comes from it.',
};
