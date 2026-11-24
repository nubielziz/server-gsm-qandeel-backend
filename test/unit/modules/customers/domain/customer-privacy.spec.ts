// Unit tests of the account privacy rules (feature 18, decision 064): the anonymized words, the notes, the file name, which accounts cover
// the guest row of their email and the export content.
import { describe, expect, it } from 'bun:test';
import type { AccountRow } from '@src/modules/customers/infra/customer.repository';
import type { ExportRows, MerchantExport } from '@src/modules/customers/infra/privacy-reads.repository';
import { buildAccountExport } from '@src/modules/customers/domain/customer-export';
import {
  ANONYMIZED_NAME,
  anonymizedEmail,
  appendNote,
  blockNoteLine,
  coversGuestRow,
  exportFilename,
  guestRowOpenText,
  holdsMerchantPart,
  scrubInputs,
  statusAfterUnblock,
} from '@src/modules/customers/domain/customer-privacy';

describe('anonymized words', () => {
  it('names the account, and the address pattern cannot collide with an old customer number', () => {
    expect(ANONYMIZED_NAME).toBe('Deleted account');
    expect(anonymizedEmail(14)).toBe('deleted-account-14@redacted.invalid');
    // The old pattern of a former customer anonymized under the same number is a different address.
    expect(anonymizedEmail(14)).not.toBe('deleted-14@redacted.invalid');
    expect(exportFilename(14)).toBe('account-14.json');
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

describe('coversGuestRow', () => {
  const proven = new Date('2026-10-01T00:00:00.000Z');

  it('is true only for a retail account with a login and a proven email', () => {
    expect(coversGuestRow({ rankKind: 'retail', hasAccount: true, emailVerifiedAt: proven })).toBe(true);
    // An unproven address proves nothing about who typed it.
    expect(coversGuestRow({ rankKind: 'retail', hasAccount: true, emailVerifiedAt: null })).toBe(false);
    // A merchant rank has no guest history of its own.
    expect(coversGuestRow({ rankKind: 'merchant', hasAccount: true, emailVerifiedAt: proven })).toBe(false);
    // The guest row itself is not its own guest row.
    expect(coversGuestRow({ rankKind: 'retail', hasAccount: false, emailVerifiedAt: proven })).toBe(false);
  });
});

describe('statusAfterUnblock', () => {
  it('returns a blocked account to the suspension it had, never lifting it, and to active otherwise', () => {
    expect(statusAfterUnblock({ suspendedAt: new Date('2026-11-01T08:00:00.000Z') })).toBe('suspended');
    expect(statusAfterUnblock({ suspendedAt: null })).toBe('active');
  });
});

describe('holdsMerchantPart', () => {
  const none = { walletLines: 0, apiKeys: 0, merchantInvoices: 0 };

  it('is true for a merchant rank, and for an account that held one: wallet lines, an API key or a merchant invoice', () => {
    expect(holdsMerchantPart({ rankKind: 'merchant', ...none })).toBe(true);
    expect(holdsMerchantPart({ rankKind: 'retail', ...none, walletLines: 1 })).toBe(true);
    expect(holdsMerchantPart({ rankKind: 'retail', ...none, apiKeys: 1 })).toBe(true);
    expect(holdsMerchantPart({ rankKind: 'retail', ...none, merchantInvoices: 1 })).toBe(true);
  });

  it('is false for a retail account with nothing of a merchant (an opened, unused merchant wallet tells nothing)', () => {
    expect(holdsMerchantPart({ rankKind: 'retail', ...none })).toBe(false);
  });
});

describe('guestRowOpenText', () => {
  it('says what is still open, in the singular and the plural', () => {
    expect(guestRowOpenText({ checkouts: 1, payments: 0 })).toContain('an open checkout.');
    expect(guestRowOpenText({ checkouts: 0, payments: 2 })).toContain('2 payments still pending.');
    expect(guestRowOpenText({ checkouts: 3, payments: 1 })).toContain('3 open checkouts and a payment still pending.');
  });
});

describe('buildAccountExport', () => {
  const account = {
    id: 14,
    email: 'daniel@example.com',
    emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    name: 'Daniel Whitmore',
    phone: '',
    company: '',
    address: '',
    taxId: '',
    username: null,
    country: 'GB',
    currency: 'GBP',
    hasAccount: true,
    marketingOptIn: true,
    status: 'active',
    suspendedReason: null,
    internalNotes: 'VIP',
    passwordHash: '$argon2id$secret',
    totpSecretEnc: 'secret',
    lastLoginAt: null,
    anonymizedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  } as unknown as AccountRow;
  const empty: ExportRows = {
    orders: [],
    payments: [],
    sessions: [],
    consents: [],
    tickets: [],
    requests: [],
    files: [],
  };
  const rows: ExportRows = {
    ...empty,
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
        ipCountry: 'GB',
        userAgent: 'Firefox',
        orderId: 5,
        createdAt: new Date('2026-10-02T00:00:00.000Z'),
        expiresAt: new Date('2026-10-02T00:30:00.000Z'),
      },
    ],
  };
  const retail = { id: 4, name: 'Storefront retail', kind: 'retail' as const };
  const exportedAt = new Date('2026-11-08T00:00:00.000Z');

  it('has the sections of the access right and decrypts the stored IMEI, leaving an erased one null', () => {
    const file = buildAccountExport({
      account,
      rank: retail,
      rows,
      exportedAt,
      imeiOf: (text) => (text === null ? null : 'decrypted:353890113898412'),
    });
    expect(Object.keys(file)).toEqual([
      'format',
      'exportedAt',
      'profile',
      'orders',
      'payments',
      'consents',
      'checkoutSessions',
      'supportTickets',
      'dataRequests',
      'files',
    ]);
    expect((file.checkoutSessions as Array<{ imei: string }>)[0]!.imei).toBe('decrypted:353890113898412');
    expect((file.checkoutSessions as Array<{ ipCountry: string | null }>)[0]!.ipCountry).toBe('GB');
    // What staff keep to protect the shop is not in the file; what the account gave is, with its rank.
    const profile = file.profile as Record<string, unknown>;
    for (const key of ['internalNotes', 'riskLevel', 'suspendedReason', 'passwordHash', 'totpSecretEnc']) {
      expect(profile, key).not.toHaveProperty(key);
    }
    expect(file).not.toHaveProperty('imeiChecks');
    expect(profile).toMatchObject({
      id: 14,
      email: 'daniel@example.com',
      name: 'Daniel Whitmore',
      rank: { id: 4, name: 'Storefront retail', kind: 'retail' },
    });
    // Format 4 (decision 064): the rank, the files and the merchant and guest parts are added; the two columns nothing wrote are gone.
    expect(file.format).toBe(4);
    for (const key of ['locale', 'firstOrderAt', 'totalSpent', 'username', 'company', 'address', 'taxId']) {
      expect(profile, key).not.toHaveProperty(key);
    }
    expect(file).not.toHaveProperty('merchant');
    expect(file).not.toHaveProperty('ordersPlacedAsGuest');
    expect(JSON.stringify(file)).not.toContain('VIP');
    expect(JSON.stringify(file)).not.toContain('argon2');
  });

  it('has no card data and no credentials anywhere in the file', () => {
    const text = JSON.stringify(buildAccountExport({ account, rank: retail, rows, exportedAt, imeiOf: () => null }));
    for (const word of ['fingerprint', 'brand', 'raw', 'password', 'passwordHash', 'token', 'gatewayTxnId']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('lists the guest row of a proven email in its own section, with its own orders and files', () => {
    const guestRows: ExportRows = {
      ...empty,
      orders: [
        {
          id: 77,
          service: 'Unlock',
          imei: '353890113898412',
          status: 'completed',
          quantity: 1,
          totalPrice: '12.4900',
          taxAmount: '2.5000',
          currency: 'USD',
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
          completedAt: null,
        },
      ],
      files: [
        {
          id: 9,
          filename: 'receipt.pdf',
          mime: 'application/pdf',
          size: 1000,
          createdAt: new Date('2026-08-02T00:00:00.000Z'),
        },
      ],
    };
    const file = buildAccountExport({
      account,
      rank: retail,
      rows,
      guest: { email: 'daniel@example.com', rows: guestRows },
      exportedAt,
      imeiOf: () => null,
    });
    const section = file.ordersPlacedAsGuest as Record<string, Array<Record<string, unknown>>> & { email: string };
    expect(section.email).toBe('daniel@example.com');
    expect(section.orders).toEqual([expect.objectContaining({ id: 77, imei: '353890113898412' })]);
    expect(section.files).toEqual([
      expect.objectContaining({ id: 9, filename: 'receipt.pdf', mime: 'application/pdf', size: 1000 }),
    ]);
    // The account's own orders are not mixed into it.
    expect(file.orders).toEqual([]);
    // No storage key of a file is ever listed.
    expect(JSON.stringify(file)).not.toContain('files/');
  });

  it('adds the merchant parts for a merchant rank: rank, username, wallet and statement, keys without a hash, invoices', () => {
    const merchantAccount = {
      ...account,
      company: 'Acme Unlocks',
      address: '1 High Street',
      taxId: 'GB123',
      username: 'acme',
    } as unknown as AccountRow;
    const merchant: MerchantExport = {
      wallet: {
        currency: 'USD',
        balance: '120.0000',
        reserved: '10.0000',
        creditLimit: '50.0000',
        lines: [
          { at: new Date('2026-10-03T00:00:00.000Z'), kind: 'topup', amount: '120.0000', balanceAfter: '120.0000' },
        ],
      },
      apiKeys: [
        {
          id: 3,
          name: 'Portal',
          prefix: 'gsm_abcd',
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        },
      ],
      invoices: [
        {
          number: 'INV-1',
          kind: 'topup',
          walletKind: 'client_wallet',
          status: 'paid',
          amount: '120.0000',
          total: '120.0000',
          currency: 'USD',
          createdAt: new Date('2026-10-03T00:00:00.000Z'),
          paidAt: new Date('2026-10-03T00:05:00.000Z'),
        },
      ],
    };
    const file = buildAccountExport({
      account: merchantAccount,
      rank: { id: 1, name: 'Standard', kind: 'merchant' },
      rows: empty,
      merchant,
      exportedAt,
      imeiOf: () => null,
    });
    expect(file.profile).toMatchObject({
      rank: { id: 1, name: 'Standard', kind: 'merchant' },
      username: 'acme',
      company: 'Acme Unlocks',
      address: '1 High Street',
      taxId: 'GB123',
    });
    const part = file.merchant as {
      wallet: { balance: string; statement: unknown[] };
      apiKeys: Array<Record<string, unknown>>;
      invoices: unknown[];
    };
    expect(part.wallet.balance).toBe('120.0000');
    expect(part.wallet.statement).toHaveLength(1);
    expect(part.apiKeys).toEqual([expect.objectContaining({ label: 'Portal', prefix: 'gsm_abcd' })]);
    expect(part.invoices).toHaveLength(1);
    expect(JSON.stringify(file)).not.toContain('keyHash');
    // The wallet kind only tells a merchant invoice apart: it is not written to the file.
    expect(JSON.stringify(file)).not.toContain('walletKind');
  });
});
