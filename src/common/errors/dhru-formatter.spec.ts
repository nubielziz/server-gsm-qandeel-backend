// Unit tests of the Dhru error envelope (decision 026): HTTP 200, { ERROR: [{ MESSAGE }], apiversion }, standard messages.
import { describe, expect, it } from 'bun:test';
import { AppError } from './app-error';
import { DHRU_API_VERSION, DhruErrorFormatter, dhruMessageOf } from './dhru-formatter';
import type { ErrorFormatContext } from './formatter-registry';

const formatter = new DhruErrorFormatter();
const context = (error: AppError): ErrorFormatContext => ({
  error,
  problem: {
    type: 'x',
    title: error.title,
    status: error.status,
    code: error.code,
    detail: error.message,
    requestId: 'r',
  },
  requestId: 'r',
  path: '/api/index.php',
  surface: 'dhru',
});

describe('DhruErrorFormatter', () => {
  it('owns the Dhru surface only', () => {
    expect(formatter.matches({ surface: 'dhru' })).toBe(true);
    for (const surface of ['admin', 'client', 'v1', 'store', 'hooks', 'system']) {
      expect(formatter.matches({ surface }), surface).toBe(false);
    }
  });

  it('answers HTTP 200 with the Dhru error body and headers whatever the catalog status was', () => {
    const response = formatter.format(context(new AppError('UNAUTHORIZED')));
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json; charset=utf-8');
    expect(response.headers).toEqual({ 'x-powered-by': 'DHRU-FUSION', 'dhru-fusion-api-version': '6.1' });
    expect(response.body).toEqual({ ERROR: [{ MESSAGE: 'Authentication Failed' }], apiversion: DHRU_API_VERSION });
    expect(formatter.format(context(new AppError('RATE_LIMITED', { retryAfterSeconds: 3 }))).status).toBe(200);
  });

  it('uses the detail of the occurrence first, then the standard Dhru message, then the catalog title', () => {
    expect(dhruMessageOf(new AppError('UNAUTHORIZED', { detail: 'Custom detail.' }))).toBe('Custom detail.');
    expect(dhruMessageOf(new AppError('UNAUTHORIZED'))).toBe('Authentication Failed');
    expect(dhruMessageOf(new AppError('INSUFFICIENT_FUNDS'))).toBe('Not enough credits');
    expect(dhruMessageOf(new AppError('NOT_FOUND'))).toBe('The requested item was not found.');
  });

  it('words a changed price and a short balance the same way whatever the detail says (user rule 9, decision 026)', () => {
    const changed = new AppError('PRICE_CHANGED', {
      detail: 'The price changed since you last listed it.',
      extensions: { listedPrice: '10.0000', currentPrice: '12.0000' },
    });
    expect(dhruMessageOf(changed)).toBe('Price changed. Please refresh the service list and order again.');
    const short = new AppError('INSUFFICIENT_FUNDS', { detail: 'Your balance would go to -3.0000 of a 0.0000 limit.' });
    expect(dhruMessageOf(short)).toBe('Not enough credits');
  });
});
