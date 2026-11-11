// Unit tests of the customer wallet notification events and templates (feature 21, plan § 5.8): every event has English and Arabic email
// templates that use only its variables, and the custom migration holds exactly what `customerWalletTemplatesSql()` writes.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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
  it('give every event an English and an Arabic email that use only its variables', () => {
    for (const definition of CUSTOMER_WALLET_EVENTS) {
      for (const locale of ['en', 'ar'] as const) {
        const template = CUSTOMER_WALLET_TEMPLATES.find((t) => t.event === definition.key && t.locale === locale);
        expect(template, `${definition.key} ${locale}`).toBeDefined();
        const used = [...placeholdersOf(template!.subject), ...placeholdersOf(template!.body)];
        expect(used.filter((name) => !definition.variables.includes(name))).toEqual([]);
        expect(template!.subject.trim()).not.toBe('');
      }
    }
    expect(CUSTOMER_WALLET_TEMPLATES).toHaveLength(10);
  });
});

describe(`migration ${CUSTOMER_WALLET_RULES_MIGRATION}`, () => {
  const migration = readFileSync(
    new URL(`../../../../drizzle/${CUSTOMER_WALLET_RULES_MIGRATION}.sql`, import.meta.url),
    'utf8',
  );

  it('holds exactly the INSERT that customerWalletTemplatesSql() writes', () => {
    const start = migration.indexOf('INSERT INTO "notification_templates"');
    expect(start).toBeGreaterThan(0);
    expect(migration.slice(start).trim()).toBe(customerWalletTemplatesSql());
  });

  it('creates the deferred "below zero is frozen" trigger', () => {
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER "ledger_accounts_negative_customer_wallet_frozen"');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
  });
});
