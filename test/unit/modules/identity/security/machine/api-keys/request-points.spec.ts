// Unit tests of the cost of an API-key call in points of the key's per-minute limit (decision 053).
import { describe, expect, it } from 'bun:test';
import { requestPoints } from '@src/modules/identity/security/machine/api-keys/request-points';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const items = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`r${index}`, { ID: 1 }]));

describe('requestPoints', () => {
  it('charges one point per order of a REST v1 bulk, at most 100', () => {
    expect(requestPoints('POST /v1/orders/bulk', { orders: Array.from({ length: 8 }, () => ({})) })).toBe(8);
    expect(requestPoints('POST /v1/orders/bulk', { orders: [{}] })).toBe(1);
    expect(requestPoints('POST /v1/orders/bulk', { orders: Array.from({ length: 100 }, () => ({})) })).toBe(100);
    expect(requestPoints('POST /v1/orders/bulk', { orders: Array.from({ length: 250 }, () => ({})) })).toBe(100);
  });

  it('charges the item ids of a Dhru placement bulk', () => {
    expect(requestPoints('POST /api/index.php', { action: 'placeimeiorderbulk', parameters: b64(items(6)) })).toBe(6);
    expect(requestPoints('POST /api/index.php', { action: 'placeimeiorderbulk', parameters: items(3) })).toBe(3);
    expect(requestPoints('POST /api/index.php', { action: 'placeimeiorderbulk', parameters: b64(items(300)) })).toBe(
      100,
    );
  });

  it('charges 1 for every other call', () => {
    expect(requestPoints('POST /v1/orders/bulk', { orders: 'many' })).toBe(1);
    expect(requestPoints('POST /v1/orders/bulk', { orders: [] })).toBe(1);
    expect(requestPoints('POST /v1/orders/bulk', undefined)).toBe(1);
    expect(requestPoints('POST /v1/orders', { orders: [{}, {}] })).toBe(1);
    expect(requestPoints('GET /v1/orders/:id', undefined)).toBe(1);
    expect(requestPoints('POST /api/index.php', { action: 'getimeiorderbulk', parameters: b64(items(5)) })).toBe(1);
    expect(requestPoints('POST /api/index.php', { action: 'placeimeiorder', parameters: b64({ ID: 1 }) })).toBe(1);
    expect(requestPoints('POST /api/index.php', { action: 'placeimeiorderbulk', parameters: '%%%' })).toBe(1);
    expect(requestPoints('POST /api/index.php', { action: 'placeimeiorderbulk' })).toBe(1);
  });
});
