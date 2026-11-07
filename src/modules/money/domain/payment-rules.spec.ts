// Unit tests of the top-up payment rules: when an automatic payment credits itself, who may review it, and what the job decides.
import { describe, expect, it } from 'bun:test';
import { autoCreditAtOf, confirmationMismatch, decideAutoCredit, reviewRefusal, waitingNote } from './payment-rules';

const captured = new Date('2026-11-01T10:00:00.000Z');

describe('autoCreditAtOf', () => {
  it('waits the delay, and the hold hours only when they are longer', () => {
    expect(autoCreditAtOf(captured, 10, 0).toISOString()).toBe('2026-11-01T10:10:00.000Z');
    expect(autoCreditAtOf(captured, 10, 24).toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(autoCreditAtOf(captured, 120, 1).toISOString()).toBe('2026-11-01T12:00:00.000Z');
  });
});

describe('waitingNote', () => {
  it('says when the payment credits itself', () => {
    expect(waitingNote(new Date('2026-11-01T10:10:00.000Z'))).toBe(
      'Credited automatically after the gateway check at 2026-11-01T10:10:00.000Z',
    );
  });
});

describe('reviewRefusal', () => {
  const pending = { id: 7, status: 'pending', reviewRequired: false };

  it('lets staff decide a pending payment of a manual gateway or one sent to review', () => {
    expect(reviewRefusal(pending, { isManual: true })).toBeUndefined();
    expect(reviewRefusal({ ...pending, reviewRequired: true }, { isManual: false })).toBeUndefined();
  });

  it('keeps staff out of an automatic payment, and refuses a payment that was decided', () => {
    expect(reviewRefusal(pending, { isManual: false })).toEqual({
      code: 'PAYMENT_AUTO_CREDIT_PENDING',
      detail: 'PAY-7 is credited automatically after the gateway check.',
    });
    expect(reviewRefusal({ ...pending, status: 'approved' }, { isManual: true })).toEqual({
      code: 'PAYMENT_ALREADY_REVIEWED',
      detail: 'PAY-7 was already approved.',
    });
    // A decided payment is refused as decided even on an automatic gateway.
    expect(reviewRefusal({ ...pending, status: 'rejected' }, { isManual: false })?.code).toBe(
      'PAYMENT_ALREADY_REVIEWED',
    );
  });
});

describe('confirmationMismatch', () => {
  const invoice = { amount: '100.0000', currency: 'USD' };

  it('accepts the same amount in the same currency, however it is written', () => {
    expect(confirmationMismatch({ amount: '100.0000', currency: 'USD' }, invoice)).toBeUndefined();
    expect(confirmationMismatch({ amount: '100', currency: 'usd' }, invoice)).toBeUndefined();
  });

  it('accepts an event that does not say what was paid (the invoice is then the only record)', () => {
    expect(confirmationMismatch({ amount: null, currency: null }, invoice)).toBeUndefined();
  });

  it('names a different amount, less or more, with both figures', () => {
    expect(confirmationMismatch({ amount: '50.0000', currency: 'USD' }, invoice)).toBe(
      'The gateway reports 50.0000 paid; the invoice is 100.0000.',
    );
    expect(confirmationMismatch({ amount: '100.0001', currency: null }, invoice)).toBe(
      'The gateway reports 100.0001 paid; the invoice is 100.0000.',
    );
  });

  it('names a different currency first, even when the number is the same', () => {
    expect(confirmationMismatch({ amount: '100.0000', currency: 'EUR' }, invoice)).toBe(
      'The gateway reports a payment in EUR; the invoice is in USD.',
    );
    expect(confirmationMismatch({ amount: '1.0000', currency: 'EUR' }, invoice)).toBe(
      'The gateway reports a payment in EUR; the invoice is in USD.',
    );
  });
});

describe('decideAutoCredit', () => {
  const at = (minutes: number) => new Date(captured.getTime() + minutes * 60_000);

  it('credits when the gateway still says confirmed', () => {
    expect(decideAutoCredit({ gateway: 'confirmed', capturedAt: captured, now: at(10) })).toEqual({ action: 'credit' });
  });

  it('sends a payment the gateway no longer confirms to staff', () => {
    expect(decideAutoCredit({ gateway: 'failed', capturedAt: captured, now: at(10) })).toEqual({
      action: 'review',
      reason: 'The gateway no longer reports this payment as confirmed.',
    });
  });

  it('asks again in 5 minutes while unconfirmed, and sends the payment to staff after 24 hours', () => {
    expect(decideAutoCredit({ gateway: 'pending', capturedAt: captured, now: at(10) })).toEqual({
      action: 'recheck',
      at: at(15),
    });
    expect(decideAutoCredit({ gateway: 'pending', capturedAt: captured, now: at(24 * 60 - 1) }).action).toBe('recheck');
    expect(decideAutoCredit({ gateway: 'pending', capturedAt: captured, now: at(24 * 60) }).action).toBe('review');
  });
});
