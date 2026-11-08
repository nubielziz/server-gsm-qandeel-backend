// Unit tests of the dispute rules (feature 16): the sentence of a reason code, the six lines of the evidence pack with their weights and the strength
// (the demo's `evidenceFor`: 1, 3, 3, 2, 1, 1; strong from 8, fair from 5), and the text sent to the gateway.
import { describe, expect, it } from 'bun:test';
import { type EvidenceInput, EVIDENCE_KEYS, buildEvidencePack, disputeNote, evidenceText } from './dispute-rules';

const consent = { purpose: 'terms', documentType: 'terms', version: '3.2', ip: '203.0.113.7' };

/** The full case: 3-D Secure, delivered, consents, an earlier paid order and no support ticket (1 + 3 + 3 + 2 + 1 + 1 = 11). */
const FULL: EvidenceInput = {
  payment: {
    brand: 'Visa •••• 4242',
    paid: '$14.99',
    capturedAt: new Date('2026-11-05T10:00:00.000Z'),
    reference: 'pi_123',
    threeDs: true,
  },
  order: { deliveredAt: new Date('2026-11-05T10:30:00.000Z'), resultCode: 'Unlocked', email: 'jack@mail.example' },
  consents: [consent, { purpose: 'withdrawal_waiver', documentType: null, version: null, ip: '203.0.113.7' }],
  priorPaidOrders: 2,
  tickets: [],
};

const lines = (input: EvidenceInput) =>
  Object.fromEntries(buildEvidencePack(input).items.map((line) => [line.key, line]));

describe('disputeNote', () => {
  it('turns the known reason codes into a sentence', () => {
    expect(disputeNote('fraudulent')).toBe('The cardholder says they did not make this payment.');
    expect(disputeNote('product_not_received')).toBe('The cardholder says they did not receive what they paid for.');
    expect(disputeNote('general')).toBe('The cardholder disputed this payment with their bank.');
  });

  it('quotes a code nobody knows', () => {
    expect(disputeNote('weird_code')).toBe('The bank gave the reason "weird_code".');
  });
});

describe('buildEvidencePack', () => {
  it('has the six lines in the console order', () => {
    expect(buildEvidencePack(FULL).items.map((line) => line.key)).toEqual([...EVIDENCE_KEYS]);
  });

  it('a full case is strong and every line supports us', () => {
    const pack = buildEvidencePack(FULL);
    expect(pack.strength).toBe('strong');
    expect(pack.items.every((line) => line.ok)).toBe(true);
    const byKey = lines(FULL);
    expect(byKey.payment!.body).toBe('Visa •••• 4242, $14.99 captured 2026-11-05. Gateway ref pi_123.');
    expect(byKey.delivery!.body).toBe('Result delivered 2026-11-05 to jack@mail.example: “Unlocked”');
    expect(byKey.consents!.body).toBe(
      'Terms of service v3.2; Digital service starts now, right of withdrawal is waived. Recorded from IP 203.0.113.7.',
    );
    expect(byKey.history!.body).toBe('2 earlier paid orders from the same customer that were not disputed.');
    expect(byKey.contact!.body).toBe('The customer never contacted support about this order.');
  });

  it('weighs 3-D Secure and delivery at 3, consents at 2, the others at 1: 8 is strong, 5 is fair, less is weak', () => {
    const none = {
      ...FULL,
      payment: { ...FULL.payment, threeDs: false },
      order: { ...FULL.order, deliveredAt: null },
      consents: [],
      priorPaidOrders: 0,
      tickets: [{ number: 'TCK-1', subject: 'Where is it?' }],
    };
    // Only the payment record counts: 1 point.
    expect(buildEvidencePack(none).strength).toBe('weak');
    // 1 + 3 (3DS) + 1 (contact is clean) = 5: fair.
    expect(buildEvidencePack({ ...none, payment: FULL.payment, tickets: [] }).strength).toBe('fair');
    // 1 + 3 + 3 + 1 = 8 without consents and history: strong.
    expect(buildEvidencePack({ ...FULL, consents: [], priorPaidOrders: 0 }).strength).toBe('strong');
    // 1 + 3 + 1 = 5 with delivery missing and no consents: fair; one point less is weak.
    expect(
      buildEvidencePack({ ...FULL, order: { ...FULL.order, deliveredAt: null }, consents: [], priorPaidOrders: 0 })
        .strength,
    ).toBe('fair');
    expect(
      buildEvidencePack({
        ...FULL,
        payment: { ...FULL.payment, threeDs: false },
        order: { ...FULL.order, deliveredAt: null },
        consents: [],
        priorPaidOrders: 0,
        tickets: [{ number: 'TCK-1', subject: 'x' }],
      }).strength,
    ).toBe('weak');
  });

  it('says what is missing in the words of the demo', () => {
    const byKey = lines({
      ...FULL,
      payment: { ...FULL.payment, threeDs: false, brand: '' },
      order: { ...FULL.order, deliveredAt: null },
      consents: [],
      priorPaidOrders: 0,
      tickets: [
        { number: 'TCK-1', subject: 'Where is it?' },
        { number: 'TCK-2', subject: 'Still waiting' },
      ],
    });
    expect(byKey.payment!.body.startsWith('Payment, $14.99 captured')).toBe(true);
    expect(byKey.three_ds).toMatchObject({
      ok: false,
      body: 'No 3D Secure on this payment. The bank can claim the cardholder did not authorise it.',
    });
    expect(byKey.delivery).toMatchObject({ ok: false, body: 'Not delivered yet.' });
    expect(byKey.consents).toMatchObject({ ok: false, body: 'No consent record was found for this checkout.' });
    expect(byKey.history).toMatchObject({ ok: false, body: 'First order from this customer.' });
    expect(byKey.contact).toMatchObject({
      ok: false,
      body: '2 support tickets around this order: Where is it?; Still waiting.',
    });
  });

  it('writes a missing date as unknown and clips a long result', () => {
    const byKey = lines({
      ...FULL,
      payment: { ...FULL.payment, capturedAt: null },
      order: { ...FULL.order, resultCode: 'x'.repeat(200) },
    });
    expect(byKey.payment!.body).toContain('captured unknown date');
    expect(byKey.delivery!.body).toContain(`“${'x'.repeat(90)}”`);
    expect(byKey.delivery!.body).not.toContain('x'.repeat(91));
  });
});

describe('evidenceText', () => {
  const pack = buildEvidencePack(FULL).items;

  it('lists the chosen lines in pack order', () => {
    const text = evidenceText([pack[0]!, pack[2]!], '');
    expect(text).toBe(
      'Payment record: Visa •••• 4242, $14.99 captured 2026-11-05. Gateway ref pi_123.\n' +
        'Proof of delivery: Result delivered 2026-11-05 to jack@mail.example: “Unlocked”',
    );
  });

  it('adds the staff note after a blank line, trimmed, and ignores a blank note', () => {
    expect(evidenceText([pack[0]!], '  Delivered and acknowledged.  ')).toEndWith(
      '\n\nNote from the merchant: Delivered and acknowledged.',
    );
    expect(evidenceText([pack[0]!], '   ')).not.toContain('Note from the merchant');
  });
});
