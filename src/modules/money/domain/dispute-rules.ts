// The pure rules of card disputes (feature 16): the sentence a bank's reason code becomes, the six lines of the evidence pack with their
// weights, how strong the case looks, the text sent to the gateway, and the default deadline. No database.

/** How long staff have to answer a dispute when the gateway names no deadline (days). */
export const DEFAULT_EVIDENCE_DAYS = 7;

/** The longest note staff may add to an evidence submission. */
export const MAX_EVIDENCE_NOTE_LENGTH = 1000;

const REASONS: Readonly<Record<string, string>> = {
  fraudulent: 'The cardholder says they did not make this payment.',
  unrecognized: 'The cardholder does not recognise this payment on their statement.',
  product_not_received: 'The cardholder says they did not receive what they paid for.',
  product_unacceptable: 'The cardholder says what they received was not as described.',
  duplicate: 'The cardholder says they were charged more than once for the same thing.',
  credit_not_processed: 'The cardholder says a refund they were promised never arrived.',
  subscription_canceled: 'The cardholder says they cancelled before this payment.',
  general: 'The cardholder disputed this payment with their bank.',
};

/**
 * The sentence a dispute's reason code reads as.
 *
 * Why: B84: `disputes` has no note column, so the console's "what the bank or the customer said, in a sentence" is derived from
 * `reason_code`; a code nobody knows is quoted.
 *
 * @param reasonCode the bank's code as the gateway reported it
 * @returns one sentence
 */
export function disputeNote(reasonCode: string): string {
  return REASONS[reasonCode] ?? `The bank gave the reason "${reasonCode}".`;
}

/** The keys of the evidence pack, in the order the console lists them. */
export const EVIDENCE_KEYS = ['payment', 'three_ds', 'delivery', 'consents', 'history', 'contact'] as const;

/** One key of the pack. */
export type EvidenceKey = (typeof EVIDENCE_KEYS)[number];

/** One line of the pack as the console shows it. */
export interface EvidenceLine {
  readonly key: EvidenceKey;
  readonly title: string;
  readonly body: string;
  /** True when the line supports our case. */
  readonly ok: boolean;
}

/** What the pack is built from. */
export interface EvidenceInput {
  readonly payment: {
    readonly brand: string;
    /** What the customer paid with the currency's symbol or code, ready to print (`$14.99`). */
    readonly paid: string;
    readonly capturedAt: Date | null;
    readonly reference: string;
    readonly threeDs: boolean;
  };
  readonly order: { readonly deliveredAt: Date | null; readonly resultCode: string | null; readonly email: string };
  readonly consents: ReadonlyArray<{
    purpose: string;
    documentType: string | null;
    version: string | null;
    ip: string;
  }>;
  readonly priorPaidOrders: number;
  readonly tickets: ReadonlyArray<{ number: string; subject: string }>;
}

/** The pack and how strong it is. */
export interface EvidencePack {
  readonly items: readonly EvidenceLine[];
  readonly strength: 'strong' | 'fair' | 'weak';
}

const day = (date: Date | null): string => (date ? date.toISOString().slice(0, 10) : 'unknown date');
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const CONSENT_WORDS: Readonly<Record<string, string>> = {
  terms: 'Terms of service',
  privacy: 'Privacy policy',
  refund_policy: 'Refund policy',
  withdrawal_waiver: 'Digital service starts now, right of withdrawal is waived',
  marketing: 'Marketing emails (opt-in)',
};

/**
 * Builds the evidence pack of a dispute and weighs it.
 *
 * Why: scenario b2c-chargeback step 4, ANSWERS refunds Q5: the server builds six lines from the payment, the order's result, the consent
 * records with their IP and time, the customer's history and their support contacts; the demo's weights are 1, 3, 3, 2, 1, 1 counted
 * when the line supports us (`ok`), and 8 or more is strong, 5 or more fair.
 *
 * @param input the facts
 * @returns the six lines and the strength
 */
export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const { payment, order } = input;
  const delivered = order.deliveredAt !== null;
  const consentWords = input.consents.map((consent) => {
    const word = CONSENT_WORDS[consent.purpose] ?? consent.purpose;
    return consent.documentType !== null && consent.version !== null ? `${word} v${consent.version}` : word;
  });
  const consentIp = input.consents[0]?.ip ?? '';
  const lines: Array<EvidenceLine & { weight: number }> = [
    {
      key: 'payment',
      title: 'Payment record',
      ok: true,
      weight: 1,
      body: `${payment.brand || 'Payment'}, ${payment.paid} captured ${day(payment.capturedAt)}. Gateway ref ${payment.reference}.`,
    },
    {
      key: 'three_ds',
      title: '3D Secure authentication',
      ok: payment.threeDs,
      weight: payment.threeDs ? 3 : 0,
      body: payment.threeDs
        ? 'The cardholder passed the bank’s own check. For fraud disputes this usually shifts liability to the bank.'
        : 'No 3D Secure on this payment. The bank can claim the cardholder did not authorise it.',
    },
    {
      key: 'delivery',
      title: 'Proof of delivery',
      ok: delivered,
      weight: delivered ? 3 : 0,
      body: delivered
        ? `Result delivered ${day(order.deliveredAt)} to ${order.email}: “${(order.resultCode || 'Unlock confirmed').slice(0, 90)}”`
        : 'Not delivered yet.',
    },
    {
      key: 'consents',
      title: 'Terms the customer accepted',
      ok: consentWords.length > 0,
      weight: consentWords.length > 0 ? 2 : 0,
      body:
        consentWords.length > 0
          ? `${consentWords.join('; ')}.${consentIp ? ` Recorded from IP ${consentIp}.` : ''}`
          : 'No consent record was found for this checkout.',
    },
    {
      key: 'history',
      title: 'Order history',
      ok: input.priorPaidOrders > 0,
      weight: input.priorPaidOrders > 0 ? 1 : 0,
      body:
        input.priorPaidOrders > 0
          ? `${plural(input.priorPaidOrders, 'earlier paid order')} from the same customer that ${input.priorPaidOrders === 1 ? 'was' : 'were'} not disputed.`
          : 'First order from this customer.',
    },
    {
      key: 'contact',
      title: 'Customer contact',
      ok: input.tickets.length === 0,
      weight: input.tickets.length > 0 ? 0 : 1,
      body:
        input.tickets.length > 0
          ? `${plural(input.tickets.length, 'support ticket')} around this order: ${input.tickets.map((ticket) => ticket.subject).join('; ')}.`
          : 'The customer never contacted support about this order.',
    },
  ];
  const score = lines.reduce((total, line) => total + line.weight, 0);
  return {
    items: lines.map(({ weight: _weight, ...line }) => line),
    strength: score >= 8 ? 'strong' : score >= 5 ? 'fair' : 'weak',
  };
}

/**
 * The text of an evidence submission.
 *
 * Why: the gateway takes the evidence as text (and our stored PDF holds the same lines): the chosen lines in pack order, then the
 * staff note.
 *
 * @param items the lines staff chose
 * @param note the staff note, or `''`
 * @returns the text sent to the gateway
 */
export function evidenceText(items: readonly EvidenceLine[], note: string): string {
  const body = items.map((line) => `${line.title}: ${line.body}`).join('\n');
  return note.trim() === '' ? body : `${body}\n\nNote from the merchant: ${note.trim()}`;
}
