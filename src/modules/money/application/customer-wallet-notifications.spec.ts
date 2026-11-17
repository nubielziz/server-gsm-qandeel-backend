// Unit tests of the customer wallet notification events and templates (feature 21, plan § 5.8): every event has one English email
// template that uses only its variables, the custom migration that shipped them holds each row, and `customerWalletTemplatesSql()`
// writes today's shape (no language, decision 039).
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { insertedTemplates } from '../../../../test/support/applied-templates';
import { NotificationEventRegistry } from '../../platform';
import {
  CUSTOMER_WALLET_EVENTS,
  CUSTOMER_WALLET_RULES_MIGRATION,
  CUSTOMER_WALLET_TEMPLATES,
  customerWalletTemplatesSql,
} from './customer-wallet-notifications';

const placeholdersOf = (text: string): string[] => [
  ...new Set([...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]!)),
];

describe('CUSTOMER_WALLET_EVENTS', () => {
  it('register next to the platform events as transactional customer emails with a sample per variable', () => {
    const registry = new NotificationEventRegistry();
    for (const definition of CUSTOMER_WALLET_EVENTS) registry.register(definition);
    expect(CUSTOMER_WALLET_EVENTS.map((event) => event.key)).toEqual([
      'wallet.topup_credited',
      'wallet.topup_rejected',
      'wallet.adjusted',
      'wallet.frozen',
      'wallet.order_refunded',
    ]);
    for (const definition of CUSTOMER_WALLET_EVENTS) {
      expect(registry.get(definition.key, 'customer')).toBeDefined();
      expect(definition).toMatchObject({ audience: 'customer', channels: ['email'], transactional: true });
      for (const name of definition.variables) expect(definition.sample[name], name).toBeTruthy();
    }
  });
});

describe('CUSTOMER_WALLET_TEMPLATES', () => {
  it('give every event one English email that uses only its variables', () => {
    for (const definition of CUSTOMER_WALLET_EVENTS) {
      const own = CUSTOMER_WALLET_TEMPLATES.filter((t) => t.event === definition.key);
      expect(own, definition.key).toHaveLength(1);
      const used = [...placeholdersOf(own[0]!.subject), ...placeholdersOf(own[0]!.body)];
      expect(used.filter((name) => !definition.variables.includes(name))).toEqual([]);
      expect(own[0]!.subject.trim()).not.toBe('');
      expect(`${own[0]!.subject} ${own[0]!.body}`, definition.key).toMatch(/^[\x20-\x7e\n]+$/);
    }
    expect(CUSTOMER_WALLET_TEMPLATES).toHaveLength(5);
  });
});

describe(`migration ${CUSTOMER_WALLET_RULES_MIGRATION}`, () => {
  const migration = readFileSync(
    new URL(`../../../../drizzle/${CUSTOMER_WALLET_RULES_MIGRATION}.sql`, import.meta.url),
    'utf8',
  );

  it('holds every template of the code, in English, with the same event, channel, audience, subject and body', () => {
    // The file also holds the Arabic rows it shipped with (migration 0035 deletes them): every English row is one of the code's.
    const english = insertedTemplates(`${CUSTOMER_WALLET_RULES_MIGRATION}.sql`).filter((row) => row.locale === 'en');
    expect(english).toHaveLength(CUSTOMER_WALLET_TEMPLATES.length);
    for (const template of CUSTOMER_WALLET_TEMPLATES)
      expect(english, template.event).toContainEqual({ ...template, locale: 'en' });
  });

  it('has its templates installed today by customerWalletTemplatesSql(), without a language', () => {
    const insert = customerWalletTemplatesSql();
    expect(insert).toContain('("event", "channel", "audience", "subject", "body", "is_active")');
    expect(insert).toEndWith('ON CONFLICT ("event", "channel", "audience") DO NOTHING;');
    expect(insert.match(/, true\)/g)).toHaveLength(CUSTOMER_WALLET_TEMPLATES.length);
  });

  it('creates the deferred "below zero is frozen" trigger', () => {
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER "ledger_accounts_negative_customer_wallet_frozen"');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
  });
});
