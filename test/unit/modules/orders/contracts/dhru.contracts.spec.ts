// Unit tests of the Dhru contracts of the orders module (decision 026): the transport route's documentation and the six action contracts.
import { describe, expect, it } from 'bun:test';
import { buildOperation } from '@src/common/contract/openapi';
import { dhruActionRegistry } from '@src/common/dhru';
import {
  dhruEndpoint,
  dhruGetFileOrder,
  dhruGetImeiOrder,
  dhruGetImeiOrderBulk,
  dhruPlaceFileOrder,
  dhruPlaceImeiOrder,
  dhruPlaceImeiOrderBulk,
} from '@src/modules/orders/contracts/dhru.contracts';

describe('the Dhru transport route', () => {
  it('documents the success response only: every refusal is an ERROR list in a 200 body, never problem+json', () => {
    const parts = buildOperation(dhruEndpoint);
    expect(Object.keys(parts.responses)).toEqual(['200']);
    expect(parts.requestBody?.mediaType).toBe('application/x-www-form-urlencoded');
    // The Dhru surface sends no per-key RateLimit headers.
    expect(parts.responses['200']!.headers).not.toHaveProperty('ratelimit-limit');
    expect(parts.security).toBeDefined();
  });
});

describe('the order actions', () => {
  it('are registered under the keys of the manifest, bulk where the map says bulk', () => {
    const keys = [
      dhruPlaceImeiOrder,
      dhruPlaceImeiOrderBulk,
      dhruGetImeiOrder,
      dhruGetImeiOrderBulk,
      dhruPlaceFileOrder,
      dhruGetFileOrder,
    ].map((action) => action.key);
    expect(keys).toEqual([
      'DHRU placeimeiorder',
      'DHRU placeimeiorderbulk',
      'DHRU getimeiorder',
      'DHRU getimeiorderbulk',
      'DHRU placefileorder',
      'DHRU getfileorder',
    ]);
    for (const action of dhruActionRegistry.all()) expect(action.bulk, action.key).toBe(action.action.endsWith('bulk'));
  });

  it('read ids and quantities as numbers or as the text of one (Dhru clients send strings), and an IMEI sent as a number as text', () => {
    const parsed = dhruPlaceImeiOrder.params.parse({ ID: '12', QNT: '3', IMEI: 352905112490861 });
    expect(parsed).toMatchObject({ ID: 12, QNT: 3, IMEI: '352905112490861' });
    for (const bad of [
      {},
      { ID: 0 },
      { ID: -1 },
      { ID: 'x' },
      { ID: 1.5 },
      { ID: 1, QNT: 0 },
      { ID: 1, QNT: 100001 },
    ]) {
      expect(dhruPlaceImeiOrder.params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('answer a placement with the order id as text and a status with 0, 1, 3 or 4', () => {
    expect(dhruPlaceImeiOrder.success.safeParse({ MESSAGE: 'Order received', REFERENCEID: '48101' }).success).toBe(
      true,
    );
    expect(dhruPlaceImeiOrder.success.safeParse({ MESSAGE: 'Order received', REFERENCEID: 48101 }).success).toBe(false);
    for (const status of [0, 1, 3, 4])
      expect(dhruGetImeiOrder.success.safeParse({ STATUS: status, CODE: '' }).success).toBe(true);
    expect(dhruGetImeiOrder.success.safeParse({ STATUS: 2, CODE: '' }).success).toBe(false);
    expect(dhruGetFileOrder.success.safeParse({ STATUS: 4, CODE: 'Done', FILEID: 9 }).success).toBe(true);
  });

  it('name the refusals of a placement, a frozen merchant wallet included, and keep them out of a status call', () => {
    for (const action of [dhruPlaceImeiOrder, dhruPlaceImeiOrderBulk, dhruPlaceFileOrder]) {
      expect(action.errors, action.key).toContain('WALLET_FROZEN');
      expect(action.errors, action.key).toContain('INSUFFICIENT_FUNDS');
    }
    for (const action of [dhruGetImeiOrder, dhruGetImeiOrderBulk, dhruGetFileOrder]) {
      expect(action.errors, action.key).not.toContain('WALLET_FROZEN');
    }
  });
});
