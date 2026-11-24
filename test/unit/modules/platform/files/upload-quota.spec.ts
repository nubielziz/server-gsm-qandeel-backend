// Unit tests of the upload quota rules (decisions 053 and 064): the numbers, windows and prefixes of the three quotas, the rule each rank
// kind gets, and the edge of each bound.
import { describe, expect, it } from 'bun:test';
import * as quotas from '@src/modules/platform/files/upload-quota';
import {
  CUSTOMER_DAILY_QUOTA,
  MERCHANT_DAILY_QUOTA,
  quotaExceeded,
  ticketDailyQuota,
  uploadQuotaFor,
} from '@src/modules/platform/files/upload-quota';

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

describe('the upload quotas', () => {
  it('gives an account of a merchant rank 500 files and 5 GiB in 24 hours, under files/', () => {
    expect(MERCHANT_DAILY_QUOTA).toMatchObject({
      maxFiles: 500,
      maxBytes: 5 * 1024 * MIB,
      windowMs: DAY,
      keyPrefixes: ['files/'],
    });
    expect(MERCHANT_DAILY_QUOTA.message).toContain('500 files (5 GiB) in 24 hours');
  });

  it('gives an account of a retail rank 30 files and 100 MiB in 24 hours, under files/ and tickets-', () => {
    expect(CUSTOMER_DAILY_QUOTA).toMatchObject({
      maxFiles: 30,
      maxBytes: 100 * MIB,
      windowMs: DAY,
      keyPrefixes: ['files/', 'tickets-'],
    });
    expect(CUSTOMER_DAILY_QUOTA.message).toContain('30 files (100 MiB) in 24 hours');
  });

  it('gives one ticket 20 files and 50 MiB in 24 hours, under its own area', () => {
    expect(ticketDailyQuota(42)).toMatchObject({
      maxFiles: 20,
      maxBytes: 50 * MIB,
      windowMs: DAY,
      keyPrefixes: ['tickets-42/'],
    });
    expect(ticketDailyQuota(42).message).toContain('20 files (50 MiB)');
    // The trailing slash keeps ticket 4 from counting the files of ticket 42.
    expect(ticketDailyQuota(4).keyPrefixes).toEqual(['tickets-4/']);
  });

  it('has no quota for an account that waits for approval: the status is gone, and so is its rule', () => {
    expect(Object.keys(quotas).filter((name) => /PENDING/i.test(name))).toEqual([]);
  });
});

describe('uploadQuotaFor (the quota follows the rank kind, not the route)', () => {
  it('gives a merchant rank the merchant rule, so the 30-file store rule never caps it', () => {
    const rule = uploadQuotaFor('merchant');
    expect(rule).toBe(MERCHANT_DAILY_QUOTA);
    expect(quotaExceeded(rule, { files: 30, bytes: 100 * MIB }, 1)).toBe(false);
    expect(quotaExceeded(rule, { files: 499, bytes: 0 }, 1)).toBe(false);
    expect(quotaExceeded(rule, { files: 500, bytes: 0 }, 1)).toBe(true);
  });

  it('gives a retail rank the retail rule, which counts the upload routes and the ticket links together', () => {
    const rule = uploadQuotaFor('retail');
    expect(rule).toBe(CUSTOMER_DAILY_QUOTA);
    expect(rule.keyPrefixes).toEqual(['files/', 'tickets-']);
    expect(quotaExceeded(rule, { files: 29, bytes: 0 }, 1)).toBe(false);
    expect(quotaExceeded(rule, { files: 30, bytes: 0 }, 1)).toBe(true);
  });
});

describe('quotaExceeded', () => {
  it('refuses the 31st file of a retail rank and allows the 30th', () => {
    expect(quotaExceeded(CUSTOMER_DAILY_QUOTA, { files: 29, bytes: 0 }, 1)).toBe(false);
    expect(quotaExceeded(CUSTOMER_DAILY_QUOTA, { files: 30, bytes: 0 }, 1)).toBe(true);
  });

  it('allows bytes equal to the bound and refuses one more', () => {
    expect(quotaExceeded(CUSTOMER_DAILY_QUOTA, { files: 1, bytes: 100 * MIB - 100 }, 100)).toBe(false);
    expect(quotaExceeded(CUSTOMER_DAILY_QUOTA, { files: 1, bytes: 100 * MIB - 100 }, 101)).toBe(true);
    expect(quotaExceeded(ticketDailyQuota(1), { files: 0, bytes: 0 }, 50 * MIB)).toBe(false);
    expect(quotaExceeded(ticketDailyQuota(1), { files: 0, bytes: 0 }, 50 * MIB + 1)).toBe(true);
  });
});
