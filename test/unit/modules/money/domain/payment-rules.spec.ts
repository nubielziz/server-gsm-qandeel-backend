// Unit tests of the top-up payment rules: when an automatic payment credits itself, who may review it, and what the job decides.
import { describe, expect, it } from 'bun:test';
import {
  aftermathNote,
  autoCreditAtOf,
  closedInvoiceNote,
  confirmationMismatch,
  decideAutoCredit,
  reviewRefusal,
  topUpRecordProblem,
  waitingNote,
} from '@src/modules/money/domain/payment-rules';

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

  it('an event that does not say its currency or its amount is a mismatch', () => {
    const noCurrency = 'The gateway does not say in which currency this payment was made; the invoice is in USD.';
    expect(confirmationMismatch({ amount: null, currency: null }, invoice)).toBe(noCurrency);
    expect(confirmationMismatch({ amount: '100.0000', currency: null }, invoice)).toBe(noCurrency);
    expect(confirmationMismatch({ amount: null, currency: 'USD' }, invoice)).toBe(
      'The gateway does not say how much was paid; the invoice is 100.0000.',
    );
  });

  it('names a different amount, less or more, with both figures', () => {
    expect(confirmationMismatch({ amount: '50.0000', currency: 'USD' }, invoice)).toBe(
      'The gateway reports 50.0000 paid; the invoice is 100.0000.',
    );
    expect(confirmationMismatch({ amount: '100.0001', currency: 'usd' }, invoice)).toBe(
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

describe('closedInvoiceNote', () => {
  it('says the confirmed payment of a closed invoice is never credited and what staff do', () => {
    expect(closedInvoiceNote('INV-2026-0001', 'void')).toBe(
      'The gateway confirmed this payment for INV-2026-0001, which is void: it is never credited. Refund it at the gateway or ' +
        'adjust the wallet by hand, then reject it (the reason you give is sent to the customer).',
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

describe('aftermathNote (decision 048)', () => {
  it('says what the record shows happened to the money', () => {
    expect(aftermathNote('refunded')).toBe(
      "The gateway's record shows this payment was refunded in full after it was made.",
    );
    expect(aftermathNote('partially_refunded')).toBe(
      "The gateway's record shows part of this payment was refunded after it was made.",
    );
    expect(aftermathNote('disputed')).toBe("The gateway's record shows this payment is disputed.");
  });
});

describe('topUpRecordProblem (decision 048)', () => {
  const invoice = { number: 'INV-2026-0007', amount: '100.0000', currency: 'USD' };
  const record = { amount: '100.0000', currency: 'USD', belongsTo: 'INV-2026-0007' };

  it('finds nothing when the record states the invoice, its amount and its currency, with or without a reference', () => {
    expect(topUpRecordProblem(record, invoice)).toBeUndefined();
    expect(topUpRecordProblem({ ...record, belongsTo: null }, invoice)).toBeUndefined();
    expect(topUpRecordProblem({ ...record, currency: 'usd', amount: '100' }, invoice)).toBeUndefined();
  });

  it('names a record of another invoice, another amount or currency, one that does not say, and money that went back', () => {
    expect(topUpRecordProblem({ ...record, belongsTo: 'INV-2026-0008' }, invoice)).toBe(
      "The gateway's record of this payment names INV-2026-0008, not INV-2026-0007.",
    );
    expect(topUpRecordProblem({ ...record, amount: '50.0000' }, invoice)).toBe(
      "The gateway's record does not match the invoice. The gateway reports 50.0000 paid; the invoice is 100.0000.",
    );
    expect(topUpRecordProblem({ ...record, currency: 'EUR' }, invoice)).toBe(
      "The gateway's record does not match the invoice. The gateway reports a payment in EUR; the invoice is in USD.",
    );
    expect(topUpRecordProblem({ ...record, amount: null }, invoice)).toContain('does not say how much was paid');
    expect(topUpRecordProblem({ ...record, currency: null }, invoice)).toContain('does not say in which currency');
    expect(topUpRecordProblem({ ...record, afterPayment: 'partially_refunded' }, invoice)).toBe(
      "The gateway's record shows part of this payment was refunded after it was made.",
    );
    // Every difference is named.
    expect(
      topUpRecordProblem(
        { amount: '1.0000', currency: 'USD', belongsTo: 'INV-2026-0008', afterPayment: 'disputed' },
        invoice,
      ),
    ).toBe(
      "The gateway's record of this payment names INV-2026-0008, not INV-2026-0007. The gateway's record shows this payment is " +
        "disputed. The gateway's record does not match the invoice. The gateway reports 1.0000 paid; the invoice is 100.0000.",
    );
  });
});
