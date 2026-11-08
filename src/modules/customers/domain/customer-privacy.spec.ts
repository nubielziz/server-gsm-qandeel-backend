// Unit tests of the customer privacy rules (feature 18): the anonymized words, the notes, the file name and the export content.
import { describe, expect, it } from 'bun:test';
import type { Customer } from '../db/schema';
import type { ExportRows } from '../infra/privacy-reads.repository';
import { buildCustomerExport } from './customer-export';
import {
  ANONYMIZED_NAME,
  anonymizedEmail,
  appendNote,
  blockNoteLine,
  exportFilename,
  scrubInputs,
} from './customer-privacy';

describe('anonymized words', () => {
  it('uses the demo name and a per-customer address that is free to reuse', () => {
    expect(ANONYMIZED_NAME).toBe('Deleted customer');
    expect(anonymizedEmail(14)).toBe('deleted-14@redacted.invalid');
    expect(exportFilename(14)).toBe('customer-14.json');
  });
});

describe('notes', () => {
  it('appends the block line instead of overwriting the notes', () => {
    expect(blockNoteLine('Abuse of refunds')).toBe('Blocked: Abuse of refunds');
    expect(appendNote('', 'Blocked: x')).toBe('Blocked: x');
    expect(appendNote('Called twice.\n', 'Blocked: x')).toBe('Called twice.\nBlocked: x');
  });
});

describe('scrubInputs', () => {
  it('masks IMEI-looking strings and leaves the rest alone', () => {
    expect(scrubInputs({ imei: '353890113898412', note: 'hello', count: 3, other: '12345' })).toEqual({
      imei: '35389011•••••••',
      note: 'hello',
      count: 3,
      other: '12345',
    });
  });
});

describe('buildCustomerExport', () => {
  const customer = {
    id: 14,
    email: 'daniel@example.com',
    emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    name: 'Daniel Whitmore',
    phone: '',
    country: 'GB',
    locale: 'en',
    currency: 'GBP',
    hasAccount: true,
    marketingOptIn: true,
    riskLevel: 'low',
    status: 'active',
    suspendedReason: null,
    internalNotes: 'VIP',
    lastLoginAt: null,
    firstOrderAt: null,
    totalSpent: '0.0000',
    anonymizedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  } as unknown as Customer;
  const rows: ExportRows = {
    orders: [],
    payments: [
      {
        id: 1,
        orderId: 5,
        amount: '14.9900',
        feeAmount: '0.7000',
        currency: 'USD',
        status: 'captured',
        methodType: 'card',
        capturedAt: new Date('2026-10-02T00:00:00.000Z'),
        createdAt: new Date('2026-10-02T00:00:00.000Z'),
      },
    ],
    sessions: [
      {
        id: 2,
        email: 'daniel@example.com',
        service: 'Unlock',
        imeiEnc: 'ciphertext',
        quantity: 1,
        currency: 'USD',
        netAmount: '12.4900',
        taxAmount: '2.5000',
        grossAmount: '14.9900',
        taxCountry: 'GB',
        status: 'paid',
        ip: '203.0.113.9',
        userAgent: 'Firefox',
        orderId: 5,
        createdAt: new Date('2026-10-02T00:00:00.000Z'),
        expiresAt: new Date('2026-10-02T00:30:00.000Z'),
      },
    ],
    consents: [],
    tickets: [],
    imeiChecks: [
      {
        id: 3,
        imeiEnc: null,
        source: 'storefront_free',
        checkType: 'basic',
        status: 'unknown',
        ip: null,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ],
    requests: [],
  };

  it('has the sections of the access right and decrypts the stored IMEI, leaving an erased one null', () => {
    const file = buildCustomerExport(customer, rows, new Date('2026-11-08T00:00:00.000Z'), (kind, text) =>
      text === null ? null : `${kind}:353890113898412`,
    );
    expect(Object.keys(file)).toEqual([
      'format',
      'exportedAt',
      'profile',
      'orders',
      'payments',
      'consents',
      'checkoutSessions',
      'supportTickets',
      'imeiChecks',
      'dataRequests',
    ]);
    expect((file.checkoutSessions as Array<{ imei: string }>)[0]!.imei).toBe('checkout:353890113898412');
    expect((file.imeiChecks as Array<{ imei: string | null }>)[0]!.imei).toBeNull();
    // What staff keep to protect the shop is not in the file; what the customer gave is.
    const profile = file.profile as Record<string, unknown>;
    for (const key of ['internalNotes', 'riskLevel', 'suspendedReason']) expect(profile, key).not.toHaveProperty(key);
    expect(profile).toMatchObject({ id: expect.any(Number), email: expect.any(String), name: expect.any(String) });
    expect(JSON.stringify(file)).not.toContain('VIP');
  });

  it('has no card data and no credentials anywhere in the file', () => {
    const text = JSON.stringify(buildCustomerExport(customer, rows, new Date('2026-11-08T00:00:00.000Z'), () => null));
    for (const word of ['fingerprint', 'brand', 'raw', 'password', 'passwordHash', 'token', 'gatewayTxnId']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
