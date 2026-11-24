// Read-only lookups into tables other modules own (currencies, tax rates, orders, consents, risk assessments), kept in this one file: the
// profile rules read currencies and tax windows, and the privacy read of an account reads its risk signals and the consent evidence of its
// latest shop order.
//
// DEVIATION to resolve when those features land: decision 016 wants these reads through the owning module's public service.
// Money, orders and risk export nothing for them yet, so this file reads the tables with plain selects, like catalog's and orders'
// foreign-read files. Replace the bodies with calls to their services; nothing outside this file knows.
import { and, desc, eq, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/** A currency as the customer routes need it. */
export interface CurrencyRef {
  readonly id: number;
  readonly code: string;
  readonly isStorefront: boolean;
  readonly isActive: boolean;
}

/**
 * Reads a currency by its ISO code.
 *
 * Why: a customer stores the currency as a code (the foreign key), and the wire shows its id.
 *
 * @param db the database or a transaction
 * @param code the ISO code
 * @returns the currency, or `undefined` when the code is not in the table
 */
export async function currencyByCode(db: DbExecutor, code: string): Promise<CurrencyRef | undefined> {
  const [row] = await db
    .select({
      id: s.currencies.id,
      code: s.currencies.code,
      isStorefront: s.currencies.isStorefront,
      isActive: s.currencies.isActive,
    })
    .from(s.currencies)
    .where(eq(s.currencies.code, code))
    .limit(1);
  return row;
}

/**
 * Tells whether a country has a tax rate in force.
 *
 * Why: ANSWERS customers Q8: the storefront sells to the countries that have a current `tax_rates` row (the list
 * `GET /store/v1/config` serves), so staff can only give a customer one of them. The money module owns the table; this is a
 * foreign read like the others in this file.
 *
 * @param db the database or a transaction
 * @param country the upper-case ISO 3166 alpha-2 code
 * @param now the clock's time (decision 031): the window must have started and not ended
 * @returns true when a row of that country has `valid_from <= now` and no end, or an end after `now`
 */
export async function hasCurrentTaxRate(db: DbExecutor, country: string, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: s.taxRates.id })
    .from(s.taxRates)
    .where(
      and(
        eq(s.taxRates.country, country),
        sql`${s.taxRates.validFrom} <= ${now}`,
        sql`(${s.taxRates.validTo} is null or ${s.taxRates.validTo} > ${now})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Tells whether any country has a tax window in force.
 *
 * Why: decision 050: a shop with no window in force sells everywhere without tax, so the checkout refuses a country without a window only
 * while the shop has some; this is the same notion of "in force" as `GET /store/v1/config`'s `taxRates` and {@link hasCurrentTaxRate}.
 *
 * @param db the database or a transaction
 * @param now the clock's time (decision 031): the window must have started and not ended
 * @returns true when any `tax_rates` row has `valid_from <= now` and no end, or an end after `now`
 */
export async function hasAnyCurrentTaxRate(db: DbExecutor, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: s.taxRates.id })
    .from(s.taxRates)
    .where(
      and(
        sql`${s.taxRates.validFrom} <= ${now}`,
        sql`(${s.taxRates.validTo} is null or ${s.taxRates.validTo} > ${now})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The risk side of the privacy read. */
export interface RiskSummary {
  readonly highestScore: number | null;
  readonly signals: ReadonlyArray<{ readonly text: string; readonly orderId: number }>;
}

/** The most signals the privacy read lists (RESOLUTIONS b2c-11). */
export const MAX_RISK_SIGNALS = 20;

/**
 * Reads the highest risk score and the signals behind an account's orders.
 *
 * Why: RESOLUTIONS b2c-11: `highestScore` is the maximum over every assessment of the account; `signals` flatten the assessments that
 * have an order, newest first, in stored order, at most 20.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns the summary
 */
export async function riskOf(db: DbExecutor, accountId: number): Promise<RiskSummary> {
  const [top] = await db
    .select({ highest: sql<number | null>`max(${s.riskAssessments.score})::int` })
    .from(s.riskAssessments)
    .where(eq(s.riskAssessments.accountId, accountId));
  const assessments = await db
    .select({ orderId: s.riskAssessments.orderId, signals: s.riskAssessments.signals })
    .from(s.riskAssessments)
    .where(and(eq(s.riskAssessments.accountId, accountId), sql`${s.riskAssessments.orderId} is not null`))
    .orderBy(desc(s.riskAssessments.createdAt), desc(s.riskAssessments.id))
    // Twenty assessments hold at least twenty signals unless some are empty; the loop below stops at the cap.
    .limit(MAX_RISK_SIGNALS * 5);
  const signals: Array<{ text: string; orderId: number }> = [];
  for (const assessment of assessments) {
    for (const text of assessment.signals ?? []) {
      if (typeof text === 'string' && assessment.orderId !== null && signals.length < MAX_RISK_SIGNALS) {
        signals.push({ text, orderId: assessment.orderId });
      }
    }
  }
  return { highestScore: top?.highest ?? null, signals };
}

/** One consent record of the latest order, with its document. */
export interface ConsentEvidence {
  readonly purpose: string;
  readonly documentType: string | null;
  readonly documentVersion: string | null;
  readonly at: Date;
  readonly ip: string;
}

/**
 * Reads the consent evidence of an account's latest shop order.
 *
 * Why: RESOLUTIONS b2c-14 and b2c-12: the privacy read shows the consent records written for the latest shop order, with the document
 * (type and version) when the purpose has one, and the address each was given from. Only a shop order carries consents (a portal or
 * Dhru order of a merchant rank asks for none), so the latest order is the latest of `source = 'store'`.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns the latest shop order's id and its consent records (oldest first), or `null` when the account has no shop order
 */
export async function latestConsentEvidence(
  db: DbExecutor,
  accountId: number,
): Promise<{ orderId: number; records: ConsentEvidence[] } | null> {
  const [latest] = await db
    .select({ id: s.orders.id })
    .from(s.orders)
    .where(and(eq(s.orders.accountId, accountId), eq(s.orders.source, 'store')))
    .orderBy(desc(s.orders.createdAt), desc(s.orders.id))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select({
      purpose: s.consentRecords.purpose,
      documentType: s.legalDocuments.type,
      documentVersion: s.legalDocuments.version,
      at: s.consentRecords.createdAt,
      ip: s.consentRecords.ip,
    })
    .from(s.consentRecords)
    .leftJoin(s.legalDocuments, eq(s.legalDocuments.id, s.consentRecords.legalDocumentId))
    .where(
      and(
        eq(s.consentRecords.subjectType, 'account'),
        eq(s.consentRecords.subjectId, accountId),
        eq(s.consentRecords.orderId, latest.id),
      ),
    )
    .orderBy(s.consentRecords.createdAt, s.consentRecords.id);
  return { orderId: latest.id, records: rows };
}
