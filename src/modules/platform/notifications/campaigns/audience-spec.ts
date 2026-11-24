// The audience of a notification campaign (feature 23, plan section 5.1): the wire and stored shape, its cross-field rules, and how
// the spec splits into one query per group of people (staff, merchant ranks, retail accounts and guests). Pure: no database, no clock.
import { z } from 'zod';
import { zId } from '../../../../common/contract';
import type { FieldError } from '../../../../common/errors';
import type { NotificationAudience, NotificationRecipientType } from '../../db/schema';

/** Most ids in `roleIds` or `groupIds`. */
export const MAX_SEGMENT_IDS = 100;
/** Most codes in `countries`. */
export const MAX_SEGMENT_CODES = 50;
/** Most people in `include` or `exclude`. */
export const MAX_PEOPLE = 500;

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

/**
 * The merchant segment: the accounts whose rank is a merchant rank, by rank and country.
 *
 * Why: decision 064: a merchant is an account of a merchant rank. Only `active` accounts are reached, so `statuses` is kept only so a
 * stored or an older request still parses; `pending` (a status that no longer exists) reads as `active`.
 */
export const zMerchantSegment = z.strictObject({
  statuses: codes(z.enum(['active', 'pending']), 'Ignored: only active accounts are reached.').optional(),
  groupIds: ids('Only accounts of these merchant ranks (client groups).').optional(),
  countries: codes(zCountry, 'Only merchants of these countries.').optional(),
});

/** The customer segment: active retail accounts and guests (every account that holds no merchant rank), by country. */
export const zCustomerSegment = z.strictObject({
  hasAccount: z
    .boolean()
    .optional()
    .describe('true = accounts that can sign in only, false = guests only, absent = both.'),
  countries: codes(zCountry, 'Only customers of these countries.').optional(),
});

/** A person added or left out by hand: a staff member, or an account of either rank (decision 064; `client` and `customer` are refused). */
const zPerson = z.strictObject({
  type: z.enum(['staff', 'account']),
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

/** The recipient types of a campaign's rows, in the order the fan-out walks them (an account is one type whatever its rank). */
export const AUDIENCE_TYPE_ORDER: readonly NotificationRecipientType[] = ['staff', 'account'];

/**
 * The groups of people a campaign reaches, in the order the fan-out walks them.
 *
 * Why: staff, accounts of a merchant rank and accounts of any other rank (with the guests) are three questions to three owners
 * (decision 064: one table of accounts, told apart by the rank), and the console's counts and segments are by these three words. An
 * account belongs to exactly one of the last two, so a person added by hand is found by one of them only.
 */
export const AUDIENCE_KIND_ORDER = ['staff', 'merchant', 'retail'] as const;

/** One group of people a campaign reaches. */
export type AudienceKind = (typeof AUDIENCE_KIND_ORDER)[number];

/**
 * The recipient type the rows of a group are stored under.
 *
 * @param kind the group
 * @returns `staff` for staff, `account` for the other two
 */
export function recipientTypeOfKind(kind: AudienceKind): NotificationRecipientType {
  return kind === 'staff' ? 'staff' : 'account';
}

/**
 * The audience (text family) of a group of people.
 *
 * @param kind `staff`, `merchant` or `retail`
 * @returns `staff`, `merchant` or `customer`
 */
export function audienceOfKind(kind: AudienceKind): NotificationAudience {
  return kind === 'retail' ? 'customer' : kind;
}

/**
 * The group of people an audience (a text family) belongs to.
 *
 * @param audience `staff`, `merchant` or `customer`
 * @returns `staff`, `merchant` or `retail`
 */
export function kindOfAudience(audience: NotificationAudience): AudienceKind {
  return audience === 'customer' ? 'retail' : audience;
}

/**
 * Checks the rules of an audience that one field alone cannot say.
 *
 * Why: plan 5.1: an audience must target someone, and a person listed twice in `include` or `exclude` is a mistake staff should see.
 *
 * @param spec the parsed spec
 * @returns the field errors (empty when the audience is acceptable)
 */
export function audienceProblems(spec: AudienceSpec): FieldError[] {
  const errors: FieldError[] = [];
  const include = spec.include ?? [];
  if (!spec.staff && !spec.merchants && !spec.customers && include.length === 0) {
    errors.push({
      field: 'audience',
      code: 'empty',
      message: 'Choose at least one group of people (staff, merchants or retail accounts) or add people.',
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
  return errors;
}

/**
 * Reads a stored audience again.
 *
 * Why: the fan-out and the detail read `notification_campaigns.audience` back; a value that no longer parses (a hand edit, a
 * shape change) must stop the fan-out with a clear reason instead of sending to the wrong people. A stored merchant status filter of
 * `['pending']` (a status that no longer exists) reads as `['active']`.
 *
 * @param value the stored jsonb
 * @returns the spec, or `undefined` when it does not parse
 */
export function parseStoredAudience(value: unknown): AudienceSpec | undefined {
  const parsed = zAudienceSpec.safeParse(value);
  if (!parsed.success) return undefined;
  const merchants = parsed.data.merchants;
  if (merchants?.statuses === undefined) return parsed.data;
  return { ...parsed.data, merchants: { ...merchants, statuses: ['active'] } };
}

/** What a provider is asked for one group of people. */
export interface TypeSelection {
  /** The segment of the group, or `undefined` when only `include` ids are targeted. */
  readonly segment: StaffSegment | MerchantSegment | CustomerSegment | undefined;
  readonly include: readonly number[];
  readonly exclude: readonly number[];
}

/** One group of a spec: who it is, how its rows are stored, and what the providers are asked. */
export type KindSelection = { readonly kind: AudienceKind; readonly type: NotificationRecipientType } & TypeSelection;

/**
 * Splits a spec into one selection per targeted group, in the fan-out's order.
 *
 * Why: a person added by hand is `account` and may hold either rank, so its id goes to both account groups and each group's provider keeps
 * only the accounts of its own rank kind: an account is reached once, by exactly one group.
 *
 * @param spec the spec
 * @returns the targeted groups with their segment and ids (a group is targeted by its segment or by an `include` id of its type)
 */
export function selectionsOf(spec: AudienceSpec): KindSelection[] {
  const segments: Record<AudienceKind, TypeSelection['segment']> = {
    staff: spec.staff,
    merchant: spec.merchants,
    retail: spec.customers,
  };
  const idsOf = (list: AudienceSpec['include'], type: NotificationRecipientType) =>
    (list ?? []).filter((person) => person.type === type).map((person) => person.id);
  return AUDIENCE_KIND_ORDER.flatMap((kind) => {
    const type = recipientTypeOfKind(kind);
    const include = idsOf(spec.include, type);
    const segment = segments[kind];
    if (segment === undefined && include.length === 0) return [];
    return [{ kind, type, segment, include, exclude: idsOf(spec.exclude, type) }];
  });
}
