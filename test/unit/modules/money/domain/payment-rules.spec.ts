// Unit tests of the top-up payment rules: when an automatic payment credits itself, who may review it, and what the job decides.
import { describe, expect, it } from 'bun:test';
import {
  aftermathNote,
  autoCreditAtOf,
  bankReferenceProblem,
  closedInvoiceNote,
  confirmationMismatch,
  decideAutoCredit,
  normalizeBankReference,
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

describe('normalizeBankReference', () => {
  it('upper-cases the reference and drops its white space and dashes', () => {
    expect(normalizeBankReference(' ft-2611 0177\t88 ')).toBe('FT2611017788');
    expect(normalizeBankReference('Ft\u20102611\u2013017788\u00a0')).toBe('FT2611017788');
    expect(normalizeBankReference('TRX/55.21_a')).toBe('TRX/55.21_A');
    expect(normalizeBankReference(' - ')).toBe('');
  });

  it('drops invisible (control, format and default-ignorable) characters and the minus sign, and folds full-width letters and digits', () => {
    for (const typed of [
      'FT2611\u0001017788', // start of heading (control)
      'FT2611\u001f017788', // unit separator (control)
      'FT2611\u007f017788', // delete (control)
      'FT2611\u0085017788', // next line (control)
      'FT2611\u009f017788', // application program command (control)
      'FT2611\u200b017788', // zero width space
      'FT\u00ad2611017788', // soft hyphen
      'FT2611\u2060017788', // word joiner
      'FT2611\u200e017788', // left-to-right mark
      'FT2611\u034f017788', // combining grapheme joiner
      'FT2611\ufe0f017788', // variation selector 16
      'FT2611\u3164017788', // Hangul filler
      'FT2611\u2800017788', // braille pattern blank
      'FT\u22122611017788', // minus sign
      '\uff26\uff34\uff12\uff16\uff11\uff11\uff10\uff11\uff17\uff17\uff18\uff18', // full-width FT2611017788
    ]) {
      expect(normalizeBankReference(typed), JSON.stringify(typed)).toBe('FT2611017788');
    }
    expect(normalizeBankReference('\u200b\u00ad ')).toBe('');
  });

  it('reads digits of any script as their ASCII digits', () => {
    expect(normalizeBankReference('\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669')).toBe('0123456789');
    expect(normalizeBankReference('\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9')).toBe('0123456789');
    // Arabic-Indic and Eastern Arabic-Indic digits
    expect(normalizeBankReference('ft\u0662\u0666\u0661\u0661\u0660\u0661\u0667\u0667\u0668\u0668')).toBe(
      'FT2611017788',
    );
    expect(normalizeBankReference('FT\u06f2\u06f6\u06f1\u06f1 \u06f0\u06f1\u06f7\u06f7\u06f8\u06f8')).toBe(
      'FT2611017788',
    );
  });

  it('leaves an ordinary reference as it is', () => {
    for (const reference of ['FT2611017788', 'TRX/55.21_A', 'CLIQ77812']) {
      expect(normalizeBankReference(reference)).toBe(reference);
    }
  });
});

describe('bankReferenceProblem', () => {
  it('refuses a reference that holds a letter outside A to Z', () => {
    for (const typed of [
      'F\u04222611017788', // Cyrillic Te
      '\u03a4F2611017788', // Greek Tau
      'FT2611017788\u0430', // Cyrillic a
      'FT\u00c92611017788', // Latin E with acute
      'FT\u06452611017788', // Arabic letter
    ]) {
      expect(bankReferenceProblem(normalizeBankReference(typed)), JSON.stringify(typed)).toBe(
        'Type the reference as the bank printed it, in Latin letters and digits.',
      );
    }
  });

  it('refuses a character outside printable ASCII that the stored form keeps', () => {
    for (const typed of [
      'FT2611\u0301017788', // combining acute accent
      'FT2611\u0332017788', // combining low line
      'FT2611\ue000017788', // private use
      'FT2611\u0378017788', // unassigned
      'FT2611\u{16fe4}017788', // Khitan small script filler
      'FT2611\u{1d159}017788', // musical null notehead
      'FT\u01f02611017788', // Latin j with caron
      'FT\u1e972611017788', // Latin t with diaeresis
      'FT\u1e962611017788', // Latin h with line below
      'FT\u1e982611017788', // Latin w with ring above
      'FT\u1e992611017788', // Latin y with ring above
      'FT\u20ac2611017788', // euro sign
      'FT2611\u2022017788', // bullet
      'FT\u{1f4b3}2611017788', // emoji
      'FT2611\ud800017788', // lone surrogate
    ]) {
      expect(bankReferenceProblem(normalizeBankReference(typed)), JSON.stringify(typed)).toBe(
        'Type the reference as the bank printed it, in Latin letters and digits.',
      );
    }
  });

  it('takes Latin letters, digits of any script and the punctuation the stored form keeps', () => {
    for (const typed of [
      'FT2611017788',
      ' ft-2611 0177\t88 ',
      'FT2611\u0001017788',
      'FT2611\u0085017788',
      'TRX/55.21_a',
      '!"#$%&()*+,./:;<=>?@[\\]^_`{|}~',
      'FT\u0662\u0666\u0661\u0661\u0660\u0661\u0667\u0667\u0668\u0668',
      '\uff26\uff34\uff12\uff16\uff11\uff11\uff10\uff11\uff17\uff17\uff18\uff18',
      'FT2611\u3164017788',
      '',
    ]) {
      expect(bankReferenceProblem(normalizeBankReference(typed)), JSON.stringify(typed)).toBeUndefined();
    }
  });
});
