// The audience of a notification campaign (feature 23, plan section 5.1): the wire and stored shape, its cross-field rules, and how
// the spec splits into one query per recipient type. Pure: no database, no clock.
import { z } from 'zod';
import { zId } from '../../../../common/contract';
import type { FieldError } from '../../../../common/errors';
import type { NotificationRecipientType } from '../../db/schema';

/** Most ids in `roleIds` or `groupIds`. */
export const MAX_SEGMENT_IDS = 100;
/** Most codes in `countries` or `locales`. */
export const MAX_SEGMENT_CODES = 50;
/** Most people in `include` or `exclude`. */
export const MAX_PEOPLE = 500;

/**
 * The languages a campaign is written in and a customer may read.
 *
 * Why: L5: English is required, Arabic optional.
 */
export const CAMPAIGN_LOCALES = ['en', 'ar'] as const;

/** One value of {@link CAMPAIGN_LOCALES}. */
export type CampaignLocale = (typeof CAMPAIGN_LOCALES)[number];

const zCountry = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Use an ISO 3166-1 alpha-2 code in capitals, such as JO.')
  .describe('An ISO 3166-1 alpha-2 country code in capitals.');
const ids = (what: string) => z.array(zId).min(1).max(MAX_SEGMENT_IDS).describe(what);
const codes = <T extends z.ZodType>(item: T, what: string) =>
  z.array(item).min(1).max(MAX_SEGMENT_CODES).describe(what);

/** The staff segment: every active staff member, or those of some roles. */
export const zStaffSegment = z.strictObject({
  roleIds: ids('Only staff of these roles.').optional(),
});

/** The merchant segment: merchants by status (default active), group and country. */
export const zMerchantSegment = z.strictObject({
  statuses: codes(z.enum(['active', 'pending']), 'Merchant statuses; default `["active"]`.').optional(),
  groupIds: ids('Only merchants of these client groups.').optional(),
  countries: codes(zCountry, 'Only merchants of these countries.').optional(),
});

/** The customer segment: active customers, accounts or guests, by country and language. */
export const zCustomerSegment = z.strictObject({
  hasAccount: z
    .boolean()
    .optional()
    .describe('true = customers with an account only, false = guests only, absent = both.'),
  countries: codes(zCountry, 'Only customers of these countries.').optional(),
  locales: codes(z.enum(CAMPAIGN_LOCALES), 'Only customers who read these languages.').optional(),
});

const zPerson = z.strictObject({
  type: z.enum(['staff', 'client', 'customer']),
  id: zId,
});

/**
 * The audience of a campaign, as staff send it and as `notification_campaigns.audience` stores it.
 *
 * Why: L5 and plan 5.1: a key present means "this segment is targeted" (`{}` = all of it); `include` adds individual people,
 * `exclude` removes people; eligibility (active, consent) always applies on top.
 */
export const zAudienceSpec = z.strictObject({
  staff: zStaffSegment.optional(),
  merchants: zMerchantSegment.optional(),
  customers: zCustomerSegment.optional(),
  include: z.array(zPerson).max(MAX_PEOPLE).optional().describe('Individual people to add.'),
  exclude: z.array(zPerson).max(MAX_PEOPLE).optional().describe('People to leave out.'),
});

/** An audience spec. */
export type AudienceSpec = z.output<typeof zAudienceSpec>;
/** The staff segment of a spec. */
export type StaffSegment = z.output<typeof zStaffSegment>;
/** The merchant segment of a spec. */
export type MerchantSegment = z.output<typeof zMerchantSegment>;
/** The customer segment of a spec. */
export type CustomerSegment = z.output<typeof zCustomerSegment>;

/** The fixed order the fan-out walks the recipient types in. */
export const AUDIENCE_TYPE_ORDER: readonly NotificationRecipientType[] = ['staff', 'client', 'customer'];

/**
 * Checks the rules of an audience that one field alone cannot say.
 *
 * Why: plan 5.1: an audience must target someone, Telegram exists only for merchants (`clients.telegram_chat_id`), and a person
 * listed twice in `include` or `exclude` is a mistake staff should see.
 *
 * @param spec the parsed spec
 * @param channels the campaign's channels
 * @returns the field errors (empty when the audience is acceptable)
 */
export function audienceProblems(spec: AudienceSpec, channels: readonly string[]): FieldError[] {
  const errors: FieldError[] = [];
  const include = spec.include ?? [];
  if (!spec.staff && !spec.merchants && !spec.customers && include.length === 0) {
    errors.push({
      field: 'audience',
      code: 'empty',
      message: 'Choose at least one group of people (staff, merchants or customers) or add people.',
    });
  }
  for (const key of ['include', 'exclude'] as const) {
    const seen = new Set<string>();
    for (const person of spec[key] ?? []) {
      const id = `${person.type}:${person.id}`;
      if (seen.has(id)) {
        errors.push({ field: `audience.${key}`, code: 'duplicate', message: 'A person is listed twice.' });
        break;
      }
      seen.add(id);
    }
  }
  if (channels.includes('telegram') && !spec.merchants && !include.some((person) => person.type === 'client')) {
    errors.push({
      field: 'channels',
      code: 'telegram_needs_merchants',
      message: 'Telegram reaches merchants only: target merchants or remove Telegram.',
    });
  }
  return errors;
}

/**
 * Reads a stored audience again.
 *
 * Why: the fan-out and the detail read `notification_campaigns.audience` back; a value that no longer parses (a hand edit, a
 * shape change) must stop the fan-out with a clear reason instead of sending to the wrong people.
 *
 * @param value the stored jsonb
 * @returns the spec, or `undefined` when it does not parse
 */
export function parseStoredAudience(value: unknown): AudienceSpec | undefined {
  const parsed = zAudienceSpec.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** What a provider is asked for one recipient type. */
export interface TypeSelection {
  /** The segment of the type, or `undefined` when only `include` ids of the type are targeted. */
  readonly segment: StaffSegment | MerchantSegment | CustomerSegment | undefined;
  readonly include: readonly number[];
  readonly exclude: readonly number[];
}

/**
 * Splits a spec into one selection per targeted recipient type, in the fan-out's order.
 *
 * @param spec the spec
 * @returns the targeted types with their segment and ids (a type is targeted by its segment or by an `include` id)
 */
export function selectionsOf(spec: AudienceSpec): Array<{ type: NotificationRecipientType } & TypeSelection> {
  const segments: Record<NotificationRecipientType, TypeSelection['segment']> = {
    staff: spec.staff,
    client: spec.merchants,
    customer: spec.customers,
  };
  const idsOf = (list: AudienceSpec['include'], type: NotificationRecipientType) =>
    (list ?? []).filter((person) => person.type === type).map((person) => person.id);
  return AUDIENCE_TYPE_ORDER.flatMap((type) => {
    const include = idsOf(spec.include, type);
    const segment = segments[type];
    if (segment === undefined && include.length === 0) return [];
    return [{ type, segment, include, exclude: idsOf(spec.exclude, type) }];
  });
}
