// Unit tests of the upload quota rules (decision 053): the numbers, windows and prefixes of the four quotas and the edge of each bound.
import { describe, expect, it } from 'bun:test';
import {
  CUSTOMER_DAILY_QUOTA,
  MERCHANT_DAILY_QUOTA,
  PENDING_MERCHANT_QUOTA,
  quotaExceeded,
  ticketDailyQuota,
} from '@src/modules/platform/files/upload-quota';

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

describe('the upload quotas', () => {
  it('gives a merchant that waits for approval 10 files and 50 MiB in all, under files/', () => {
    expect(PENDING_MERCHANT_QUOTA).toMatchObject({
      maxFiles: 10,
      maxBytes: 50 * MIB,
      windowMs: null,
      keyPrefixes: ['files/'],
    });
    expect(PENDING_MERCHANT_QUOTA.message).toContain('10 uploaded files (50 MiB)');
  });

  it('gives an approved merchant 500 files and 5 GiB in 24 hours, under files/', () => {
    expect(MERCHANT_DAILY_QUOTA).toMatchObject({
      maxFiles: 500,
      maxBytes: 5 * 1024 * MIB,
      windowMs: DAY,
      keyPrefixes: ['files/'],
    });
    expect(MERCHANT_DAILY_QUOTA.message).toContain('500 files (5 GiB) in 24 hours');
  });

  it('gives a customer 30 files and 100 MiB in 24 hours, under files/ and tickets-', () => {
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
});

describe('quotaExceeded', () => {
  it('refuses the 11th file of a pending merchant and allows the 10th', () => {
    expect(quotaExceeded(PENDING_MERCHANT_QUOTA, { files: 9, bytes: 0 }, 1)).toBe(false);
    expect(quotaExceeded(PENDING_MERCHANT_QUOTA, { files: 10, bytes: 0 }, 1)).toBe(true);
  });

  it('allows bytes equal to the bound and refuses one more', () => {
    expect(quotaExceeded(PENDING_MERCHANT_QUOTA, { files: 1, bytes: 50 * MIB - 100 }, 100)).toBe(false);
    expect(quotaExceeded(PENDING_MERCHANT_QUOTA, { files: 1, bytes: 50 * MIB - 100 }, 101)).toBe(true);
    expect(quotaExceeded(ticketDailyQuota(1), { files: 0, bytes: 0 }, 50 * MIB)).toBe(false);
    expect(quotaExceeded(ticketDailyQuota(1), { files: 0, bytes: 0 }, 50 * MIB + 1)).toBe(true);
  });
});
