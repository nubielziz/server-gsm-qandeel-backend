// Unit test of the outbox retention (decision 055): relayed rows are kept longer than every reader of relayed rows looks back.
import { describe, expect, it } from 'bun:test';
import { PRICE_SCAN_WINDOW_DAYS } from '@src/modules/catalog/application/price-change-scan';
import { EXPIRE_AFTER_MS } from '@src/modules/platform/notifications/notification-reconcile';
import {
  OUTBOX_PURGE_BATCH,
  OUTBOX_PURGE_MAX_BATCHES,
  OUTBOX_RETENTION_DAYS,
} from '@src/modules/platform/outbox/outbox-purge';
import { RECENT_DISPATCH_REQUESTS } from '@src/modules/suppliers/application/dispatch-requests';

const DAY_MS = 86_400_000;

describe('outbox retention', () => {
  it('keeps relayed outbox events longer than every reader looks back', () => {
    expect(OUTBOX_RETENTION_DAYS).toBe(45);
    // The price change scan asks whether an event was written in the last 30 days.
    expect(OUTBOX_RETENTION_DAYS).toBeGreaterThan(PRICE_SCAN_WINDOW_DAYS);
    // The notification reconcile joins relayed notification.send rows of the last 48 hours.
    expect(OUTBOX_RETENTION_DAYS * DAY_MS).toBeGreaterThan(EXPIRE_AFTER_MS);
    // The dispatch sweep and the lost-work reconcile look back hours (24 at most).
    expect(OUTBOX_RETENTION_DAYS).toBeGreaterThan(1);
    expect(RECENT_DISPATCH_REQUESTS).toBeGreaterThan(0);
  });

  it('deletes in short statements and bounds one run', () => {
    expect(OUTBOX_PURGE_BATCH).toBe(5_000);
    expect(OUTBOX_PURGE_MAX_BATCHES).toBe(20);
  });
});
