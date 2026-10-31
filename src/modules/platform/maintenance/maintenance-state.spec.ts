// Unit tests of maintenance mode: reading the stored state, which requests each scope refuses, the 503 answer, and the Dhru
// action.
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  type MaintenanceRequest,
  type MaintenanceScope,
  type MaintenanceState,
  MAINTENANCE_OFF,
  dhruActionOf,
  maintenanceRefusal,
  maintenanceRetryAfter,
  parseMaintenanceState,
  scopesCovering,
} from './maintenance-state';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const on = (scope: MaintenanceScope, extra: Partial<MaintenanceState> = {}): MaintenanceState => ({
  ...MAINTENANCE_OFF,
  enabled: true,
  scope,
  message: 'Checkout is paused while we check the ledger.',
  ...extra,
});

describe('parseMaintenanceState', () => {
  it('reads the state the console writes', () => {
    const stored: MaintenanceState = {
      enabled: true,
      scope: 'checkout',
      message: 'Back soon',
      expectedEndAt: '2026-03-01T14:00:00.000Z',
      startedAt: '2026-03-01T11:00:00.000Z',
      startedBy: { id: 1, name: 'Rami K.' },
    };
    expect(parseMaintenanceState(stored)).toEqual(stored);
  });

  it('reads the off state, with the other fields null or missing', () => {
    expect(parseMaintenanceState({ enabled: false, scope: null, message: null, expectedEndAt: null })).toEqual(
      MAINTENANCE_OFF,
    );
    expect(parseMaintenanceState({ enabled: false })).toEqual(MAINTENANCE_OFF);
  });

  it('refuses a value that is not a state, so a bad row never switches maintenance on', () => {
    for (const bad of [
      null,
      'on',
      true,
      [],
      {},
      { enabled: 'yes' },
      { enabled: true },
      { enabled: true, scope: 'everything' },
      { enabled: true, scope: null },
      { enabled: false, scope: 'store', message: 12 },
    ]) {
      expect(parseMaintenanceState(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('scopesCovering', () => {
  const covers = (method: string, path: string, dhruAction?: string): readonly MaintenanceScope[] =>
    scopesCovering({ method, path, dhruAction });

  it('puts the whole storefront API in the store scope', () => {
    expect(covers('GET', '/store/v1/services')).toEqual(['store', 'all']);
    expect(covers('GET', '/store/v1/orders/:token')).toEqual(['store', 'all']);
    expect(covers('POST', '/store/v1/auth/login')).toEqual(['store', 'all']);
  });

  it('puts starting a checkout and starting its payment in the checkout scope as well', () => {
    expect(covers('POST', '/store/v1/checkout-sessions')).toEqual(['store', 'checkout', 'all']);
    expect(covers('POST', '/store/v1/checkout-sessions/:token/pay')).toEqual(['store', 'checkout', 'all']);
    expect(covers('POST', '/store/v1/checkout-sessions/abc123/pay')).toEqual(['store', 'checkout', 'all']);
    // Reading or consenting on a session that exists is not starting one.
    expect(covers('GET', '/store/v1/checkout-sessions/:token')).toEqual(['store', 'all']);
    expect(covers('POST', '/store/v1/checkout-sessions/:token/consents')).toEqual(['store', 'all']);
    expect(covers('GET', '/store/v1/checkout-sessions')).toEqual(['store', 'all']);
  });

  it('puts order placement over REST v1 and Dhru in the api_orders scope, and nothing else of the API', () => {
    expect(covers('POST', '/v1/orders')).toEqual(['api_orders', 'all']);
    expect(covers('POST', '/v1/orders/bulk')).toEqual(['api_orders', 'all']);
    expect(covers('POST', '/api/index.php', 'placeimeiorder')).toEqual(['api_orders', 'all']);
    expect(covers('POST', '/api/index.php', 'placeimeiorderbulk')).toEqual(['api_orders', 'all']);
    expect(covers('POST', '/api/index.php', 'placefileorder')).toEqual(['api_orders', 'all']);
    for (const kept of [
      ['GET', '/v1/orders'],
      ['GET', '/v1/orders/:id'],
      ['POST', '/v1/orders/:id/cancel'],
      ['POST', '/v1/orders/:id/verify'],
      ['GET', '/v1/services'],
      ['POST', '/v1/files'],
      ['POST', '/api/index.php', 'getimeiorder'],
      ['POST', '/api/index.php', 'getimeiorderbulk'],
      ['POST', '/api/index.php', 'accountinfo'],
      ['POST', '/api/index.php', 'imeiservicelist'],
      ['POST', '/api/index.php', undefined],
      ['GET', '/api/index.php', 'placeimeiorder'],
    ] as const) {
      expect(covers(kept[0], kept[1], kept[2]), kept.join(' ')).toEqual([]);
    }
  });

  it('never covers the admin console, the merchant portal, webhooks, health, metrics and the documentation', () => {
    for (const path of [
      '/admin/staff',
      '/admin/system/maintenance',
      '/client/orders',
      '/webhooks/payments/:gateway',
      '/health',
      '/metrics',
      '/docs',
      '/openapi.json',
      '/reference',
      '/nope',
    ]) {
      expect(covers('POST', path), path).toEqual([]);
      expect(covers('GET', path), path).toEqual([]);
    }
  });

  it('is case-insensitive about the method', () => {
    expect(covers('post', '/v1/orders')).toEqual(['api_orders', 'all']);
  });
});

describe('maintenanceRefusal', () => {
  const request = (method: string, path: string, dhruAction?: string): MaintenanceRequest => ({
    method,
    path,
    dhruAction,
  });

  it('answers 503 MAINTENANCE with the message, the expected end and a Retry-After', () => {
    const error = maintenanceRefusal(
      on('checkout', { expectedEndAt: '2026-03-01T12:10:00.000Z' }),
      request('POST', '/store/v1/checkout-sessions'),
      NOW,
    );
    expect(error?.code).toBe('MAINTENANCE');
    expect(error?.status).toBe(503);
    expect(error?.detail).toBe('Checkout is paused while we check the ledger.');
    expect(error?.extensions).toEqual({ expectedEndAt: '2026-03-01T12:10:00.000Z' });
    expect(error?.retryAfterSeconds).toBe(300);
  });

  it('refuses only the requests of the chosen scope', () => {
    const checkout = on('checkout');
    expect(maintenanceRefusal(checkout, request('POST', '/store/v1/checkout-sessions'), NOW)).toBeDefined();
    expect(maintenanceRefusal(checkout, request('GET', '/store/v1/services'), NOW)).toBeUndefined();
    expect(maintenanceRefusal(checkout, request('POST', '/v1/orders'), NOW)).toBeUndefined();
    expect(maintenanceRefusal(on('store'), request('GET', '/store/v1/services'), NOW)).toBeDefined();
    expect(maintenanceRefusal(on('store'), request('POST', '/v1/orders'), NOW)).toBeUndefined();
    expect(maintenanceRefusal(on('api_orders'), request('POST', '/v1/orders'), NOW)).toBeDefined();
    expect(maintenanceRefusal(on('api_orders'), request('GET', '/store/v1/services'), NOW)).toBeUndefined();
    expect(maintenanceRefusal(on('all'), request('POST', '/api/index.php', 'placeimeiorder'), NOW)).toBeDefined();
    expect(maintenanceRefusal(on('all'), request('GET', '/admin/staff'), NOW)).toBeUndefined();
  });

  it('refuses nothing while maintenance is off', () => {
    expect(maintenanceRefusal(MAINTENANCE_OFF, request('POST', '/v1/orders'), NOW)).toBeUndefined();
    expect(maintenanceRefusal(on('all', { enabled: false }), request('POST', '/v1/orders'), NOW)).toBeUndefined();
  });

  it('uses a default sentence when staff wrote no message', () => {
    for (const message of [null, '', '   ']) {
      expect(maintenanceRefusal(on('all', { message }), request('POST', '/v1/orders'), NOW)?.detail).toBe(
        DEFAULT_MAINTENANCE_MESSAGE,
      );
    }
  });

  it('sends expectedEndAt as null when none is known', () => {
    expect(maintenanceRefusal(on('all'), request('POST', '/v1/orders'), NOW)?.extensions).toEqual({
      expectedEndAt: null,
    });
  });
});

describe('maintenanceRetryAfter', () => {
  it('is the time to the expected end, kept between 30 seconds and 5 minutes', () => {
    expect(maintenanceRetryAfter('2026-03-01T12:01:30.000Z', NOW)).toBe(90);
    expect(maintenanceRetryAfter('2026-03-01T12:00:05.000Z', NOW)).toBe(30);
    expect(maintenanceRetryAfter('2026-03-01T18:00:00.000Z', NOW)).toBe(300);
  });

  it('is 60 seconds when no end is known, it has passed, or it is not a time', () => {
    expect(maintenanceRetryAfter(null, NOW)).toBe(60);
    expect(maintenanceRetryAfter('2026-03-01T11:00:00.000Z', NOW)).toBe(60);
    expect(maintenanceRetryAfter('tomorrow', NOW)).toBe(60);
  });
});

describe('dhruActionOf', () => {
  it('reads the action of a parsed body, trimmed and lower-cased', () => {
    expect(dhruActionOf({ action: 'placeimeiorder', username: 'x' })).toBe('placeimeiorder');
    expect(dhruActionOf({ action: ' PlaceImeiOrder ' })).toBe('placeimeiorder');
  });

  it('is undefined for a body without a usable action', () => {
    for (const body of [
      undefined,
      null,
      'action=placeimeiorder',
      [],
      {},
      { action: 7 },
      { action: ' ' },
      { action: ['a'] },
    ]) {
      expect(dhruActionOf(body), JSON.stringify(body)).toBeUndefined();
    }
  });
});
