// Unit tests of the status helper: who may act, and what a status does to the sessions of an account (decision 064).
import { describe, expect, it } from 'bun:test';
import { canAct, sessionStateOf } from '@src/modules/identity/accounts/account-status';
import type { ClientStatus } from '@src/modules/identity/db/schema';

/** The stored words as plain text, so the tests name a status whatever list the type of the moment has. */
const asStatus = (word: string): ClientStatus => word as ClientStatus;

describe('canAct', () => {
  it('lets an active account act', () => {
    expect(canAct(asStatus('active'))).toBe(true);
  });

  it('refuses every other status, a retired one and an unknown word', () => {
    for (const word of ['suspended', 'blocked', 'anonymized', 'pending', 'Active', '', 'deleted']) {
      expect(canAct(asStatus(word))).toBe(false);
    }
  });
});

describe('sessionStateOf', () => {
  it('keeps the sessions of an active account', () => {
    expect(sessionStateOf(asStatus('active'))).toBe('ok');
  });

  it('treats suspended and blocked the same way: refused, sessions ended', () => {
    expect(sessionStateOf(asStatus('suspended'))).toBe('suspended');
    expect(sessionStateOf(asStatus('blocked'))).toBe('suspended');
  });

  it('treats an anonymized account as gone', () => {
    expect(sessionStateOf(asStatus('anonymized'))).toBe('gone');
  });

  it('fails closed: a retired or unknown status is suspended, never ok', () => {
    for (const word of ['pending', 'Active', '', 'deleted']) {
      expect(sessionStateOf(asStatus(word))).toBe('suspended');
    }
  });

  it('agrees with canAct: only the ok state may act', () => {
    for (const word of ['active', 'suspended', 'blocked', 'anonymized', 'pending', 'other']) {
      expect(canAct(asStatus(word))).toBe(sessionStateOf(asStatus(word)) === 'ok');
    }
  });
});
