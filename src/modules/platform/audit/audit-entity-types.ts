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
 * Why: RESOLUTIONS identity-platform-15. Table to word: `clients` is `merchant`, `staff_users` `staff`, `checkout_sessions`
 * `checkout`, `legal_documents` `legal`, blocklist entries `blocklist`, `settings` `setting`, `commission_plans` `plan`,
 * `withdrawal_requests` `withdrawal`, `support_tickets` `ticket`. The list is enforced in code with no database CHECK, so the
 * append-only table never needs a migration for a new word; a feature that needs one adds it here in its own commit.
 */
export const AUDIT_ENTITY_TYPES = [
  ...CONSOLE_AUDIT_ENTITY_TYPES,
  'role',
  'client_group',
  'category',
  'currency',
  'payment_gateway',
  'invoice',
  'api_key',
  'webhook_endpoint',
  'kyc_submission',
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
] as const;

/** One value of {@link AUDIT_ENTITY_TYPES}. */
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

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
