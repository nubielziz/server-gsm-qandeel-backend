// Unit tests of the audit entity vocabulary (decision 064): the word `account` is writable, the words of before stay readable, and the sets of
// words that mean an account are what the account scope of the audit list reads.
import { describe, expect, it } from 'bun:test';
import {
  ACCOUNT_ACTOR_WORDS,
  ACCOUNT_ENTITY_WORDS,
  AUDIT_ENTITY_TYPES,
  CONSOLE_AUDIT_ENTITY_TYPES,
  isAuditEntityType,
} from '@src/modules/platform/audit/audit-entity-types';

describe('AUDIT_ENTITY_TYPES', () => {
  it('has the word account, once, beside the console words', () => {
    expect(isAuditEntityType('account')).toBe(true);
    expect(AUDIT_ENTITY_TYPES.filter((word) => word === 'account')).toHaveLength(1);
    // The console's own 19 words are still there: the console labels old rows with them.
    for (const word of CONSOLE_AUDIT_ENTITY_TYPES) expect(isAuditEntityType(word), word).toBe(true);
    expect(CONSOLE_AUDIT_ENTITY_TYPES).not.toContain('account');
  });

  it('keeps merchant and customer in the list so old rows read and filter (no writer may use them: a tooling test forbids it)', () => {
    expect(isAuditEntityType('merchant')).toBe(true);
    expect(isAuditEntityType('customer')).toBe(true);
    expect(isAuditEntityType('client')).toBe(false);
  });

  it('refuses a word that is not an entity', () => {
    for (const word of ['', 'Account', 'accounts', 'rank']) expect(isAuditEntityType(word), word).toBe(false);
  });
});

describe('the words that mean an account', () => {
  it('are the current word and the two of before, for an entity and for an actor', () => {
    expect([...ACCOUNT_ENTITY_WORDS]).toEqual(['account', 'merchant', 'customer']);
    expect([...ACCOUNT_ACTOR_WORDS]).toEqual(['account', 'client', 'customer']);
  });

  it('start with the one word new rows write', () => {
    expect(ACCOUNT_ENTITY_WORDS[0]).toBe('account');
    expect(ACCOUNT_ACTOR_WORDS[0]).toBe('account');
    for (const word of ACCOUNT_ENTITY_WORDS) expect(isAuditEntityType(word), word).toBe(true);
  });
});
