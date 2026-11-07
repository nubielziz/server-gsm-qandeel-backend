// Unit tests of the Dhru contracts of the orders module (decision 026): the transport route's documentation and the six action contracts.
import { describe, expect, it } from 'bun:test';
import { buildOperation } from '../../../common/contract/openapi';
import { dhruActionRegistry } from '../../../common/dhru';
import {
  dhruEndpoint,
  dhruGetFileOrder,
  dhruGetImeiOrder,
  dhruGetImeiOrderBulk,
  dhruPlaceFileOrder,
  dhruPlaceImeiOrder,
  dhruPlaceImeiOrderBulk,
} from './dhru.contracts';

describe('the Dhru transport route', () => {
  it('documents the success response only: every refusal is an ERROR list in a 200 body, never problem+json', () => {
    const parts = buildOperation(dhruEndpoint);
    expect(Object.keys(parts.responses)).toEqual(['200']);
    expect(parts.requestBody?.mediaType).toBe('application/x-www-form-urlencoded');
    // The per-key RateLimit headers belong to REST v1.
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
});
