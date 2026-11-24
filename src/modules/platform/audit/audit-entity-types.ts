// The closed list of record kinds an audit entry can be about (resolution identity-platform-15): the console's own words
// plus the backend's additions. AuditService.record refuses anything else, so the audit filter and the links stay honest.

/**
 * The 19 words the console's audit screen knows (its `entities.ts`).
 *
 * Why: the console labels an entry and links to the record from `entityType`; a word outside this list gets a generic label
 * and no link.
 */
export const CONSOLE_AUDIT_ENTITY_TYPES = [
  'order',
  'merchant',
  'service',
  'supplier',
  'payment',
  'withdrawal',
  'plan',
  'session',
  'customer',
  'staff',
  'ip_rule',
  'checkout',
  'refund',
  'dispute',
  'ticket',
  'listing',
  'blocklist',
  'legal',
  'setting',
] as const;

/**
 * Every entity type `AuditService.record` accepts: the console's words plus the backend additions.
 *
 * Why: RESOLUTIONS identity-platform-15. Table to word: `clients` is `account` (decision 064: one word for every merchant and customer;
 * `merchant` and `customer` stay in the list only so the rows written before it can be read and filtered, and no writer uses them: a
 * tooling test forbids it), `staff_users` `staff`, `checkout_sessions`
 * `checkout`, `legal_documents` `legal`, blocklist entries `blocklist`, `settings` `setting`, `commission_plans` `plan` (retired,
 * decision 062: only old rows carry it, and the word stays so they can still be read and filtered), `withdrawal_requests` `withdrawal`, `support_tickets` `ticket`, `ledger_accounts` `ledger_account` (the system accounts `bun run setup`
 * opens, P4b). The list is enforced in code with no database CHECK, so the
 * append-only table never needs a migration for a new word; a feature that needs one adds it here in its own commit.
 */
export const AUDIT_ENTITY_TYPES = [
  ...CONSOLE_AUDIT_ENTITY_TYPES,
  // Decision 064: every staff change of an account (merchant or retail rank), the rank change included.
  'account',
  'role',
  'client_group',
  'category',
  'currency',
  'payment_gateway',
  'invoice',
  'api_key',
  'notification_template',
  'reply_template',
  'alert_rule',
  'alert',
  'incident',
  'tax_rate',
  'help_article',
  'content_page',
  'ledger_transaction',
  'inventory_code',
  'pricing_rule',
  'queue',
  'job',
  'tac_entry',
  'ledger_account',
  'notification_campaign',
  // Feature 29 (storefront search, slice B2's console routes).
  'search_synonym',
  'search_pin',
  'search_hidden_term',
  'search_index',
  // Feature 31 (decision 040, slice B1): the retail price rules.
  'retail_price_rule',
  // Feature 31 (plan 31 section 6.6): a bulk publish run, its close and its run switch.
  'publish_run',
] as const;

/** One value of {@link AUDIT_ENTITY_TYPES}. */
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Every word a stored audit entity can use for an account: the current word and the two of before the accounts were merged.
 *
 * Why: decision 064. An old merchant's rows say `merchant` (the same number as the account) and an old customer's rows say `customer` (the old
 * customer number, which is not the account id), so a filter on the entity type `account` reads all three; the id side goes through
 * `accountHistorySql`.
 */
export const ACCOUNT_ENTITY_WORDS = ['account', 'merchant', 'customer'] as const;

/**
 * Every word a stored audit actor can use for an account: the current word and the two of before the accounts were merged.
 *
 * Why: decision 064, as {@link ACCOUNT_ENTITY_WORDS}, for the `actor_type` column.
 */
export const ACCOUNT_ACTOR_WORDS = ['account', 'client', 'customer'] as const;

/**
 * Tells whether a text is an audit entity type.
 *
 * Why: the audit service and the audit list filter share one definition of the vocabulary.
 *
 * @param value any text
 * @returns true for a word of {@link AUDIT_ENTITY_TYPES}
 */
export function isAuditEntityType(value: string): value is AuditEntityType {
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}
