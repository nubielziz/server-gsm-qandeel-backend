// Unit tests of the reference-type wire mapping (resolution money-1): the wire set stays a subset of the console's eight words.
import { describe, expect, it } from 'bun:test';
import { LEDGER_REF_TYPES } from '../db/schema';
import { WIRE_REF_TYPES, storedRefTypesOf, toWireRefType } from './ref-types';

/** The console's `LedgerRefType` (docs/contract/frontend-endpoints.json, GET /admin/ledger/transactions). */
const CONSOLE_REF_TYPES = ['order', 'payment', 'invoice', 'refund', 'dispute', 'accrual', 'supplier', 'system'];

describe('toWireRefType', () => {
  it("sends a manual adjustment's stored `client` as `system` and every other value unchanged", () => {
    expect(toWireRefType('client')).toBe('system');
    for (const stored of LEDGER_REF_TYPES.filter((type) => type !== 'client'))
      expect(toWireRefType(stored)).toBe(stored);
  });

  it('never sends a word the console does not know, whatever the stored value (contract enum test)', () => {
    for (const stored of LEDGER_REF_TYPES) expect(CONSOLE_REF_TYPES).toContain(toWireRefType(stored));
    for (const wire of WIRE_REF_TYPES) expect(CONSOLE_REF_TYPES).toContain(wire);
  });
});

describe('storedRefTypesOf', () => {
  it('matches stored `system` and `client` for the wire word `system`', () => {
    expect(storedRefTypesOf('system')).toEqual(['system', 'client']);
  });

  it('matches itself for every other word, and every stored type is reachable from a wire word', () => {
    expect(storedRefTypesOf('order')).toEqual(['order']);
    expect(new Set(WIRE_REF_TYPES.flatMap((wire) => storedRefTypesOf(wire)))).toEqual(new Set(LEDGER_REF_TYPES));
  });
});
