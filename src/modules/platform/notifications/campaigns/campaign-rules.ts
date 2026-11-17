// Pure rules of notification campaigns (feature 23, plan sections 6 and 7): channels, the state machine's status lists, content, link,
// schedule and confirmation checks, the inbox category and which rows the fan-out makes for one person. No database, no clock.
import type { FieldError } from '../../../../common/errors';
import type {
  NotificationCampaignPurpose,
  NotificationCampaignStatus,
  NotificationInboxCategory,
  NotificationRecipientType,
} from '../../db/schema';
import { unknownPlaceholders } from '../template-rules';
import type { AudienceMember, CampaignChannel } from './notification-audiences';

/**
 * The channels a campaign can use.
 *
 * Why: L5: in-app, email and Telegram (merchants with a linked chat). Not `NOTIFICATION_CHANNELS`: that list is the log's wire
 * enum; the in-app channel is its own table.
 */
export const CAMPAIGN_CHANNELS = ['in_app', 'email', 'telegram'] as const satisfies readonly CampaignChannel[];

/** The outbox event (and job name on the `notifications` queue) that starts and continues a campaign's fan-out. */
export const CAMPAIGN_FANOUT_EVENT = 'notification.campaign_fanout';

/** Statuses in which a campaign may be edited (PATCH). */
export const EDITABLE_STATUSES: readonly NotificationCampaignStatus[] = ['draft', 'scheduled'];
/** Statuses from which a campaign may be sent now or (re)scheduled, and tested. */
export const SENDABLE_STATUSES: readonly NotificationCampaignStatus[] = ['draft', 'scheduled'];
/** Statuses from which a campaign may be cancelled (a draft is deleted instead). */
export const CANCELLABLE_STATUSES: readonly NotificationCampaignStatus[] = ['scheduled', 'queued', 'sending'];
/** Statuses in which the fan-out works on a campaign. */
export const FANOUT_STATUSES: readonly NotificationCampaignStatus[] = ['queued', 'sending'];

/** Longest campaign name. */
export const MAX_NAME_LENGTH = 120;
/** Longest title of a message. */
export const MAX_TITLE_LENGTH = 120;
/** Longest body of a message. */
export const MAX_CAMPAIGN_BODY_LENGTH = 3500;
/** The one placeholder campaign text may use. */
export const CAMPAIGN_PLACEHOLDERS = ['name'] as const;
/** The earliest a campaign may be scheduled: one minute ahead. */
export const MIN_SCHEDULE_AHEAD_MS = 60_000;
/** The latest a campaign may be scheduled: 90 days ahead. */
export const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60_000;

/** The content of a campaign: one title and one body (English only, decision 039). */
export interface CampaignContent {
  readonly title: string;
  readonly body: string;
}

/** The site-relative link per audience. */
export interface CampaignLink {
  readonly staff?: string | undefined;
  readonly merchant?: string | undefined;
  readonly customer?: string | undefined;
}

/** What the fan-out counted, stored in `notification_campaigns.stats`. */
export interface CampaignStats {
  readonly planned: { readonly inApp: number; readonly email: number; readonly telegram: number };
  readonly skipped: { readonly optedOut: number; readonly noTelegram: number; readonly noAccount: number };
}

/** Stats with every counter at zero. */
export const EMPTY_STATS: CampaignStats = {
  planned: { inApp: 0, email: 0, telegram: 0 },
  skipped: { optedOut: 0, noTelegram: 0, noAccount: 0 },
};

const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) ? value : 0);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Reads the stored stats, tolerating a missing or partial object.
 *
 * @param value `notification_campaigns.stats`
 * @returns the counters (zero where missing)
 */
export function statsOf(value: unknown): CampaignStats {
  const planned = record(record(value)['planned']);
  const skipped = record(record(value)['skipped']);
  return {
    planned: { inApp: count(planned['inApp']), email: count(planned['email']), telegram: count(planned['telegram']) },
    skipped: {
      optedOut: count(skipped['optedOut']),
      noTelegram: count(skipped['noTelegram']),
      noAccount: count(skipped['noAccount']),
    },
  };
}

/**
 * Adds two stats.
 *
 * @param a the stored stats
 * @param b the stats of one chunk
 * @returns the sum
 */
export function addStats(a: CampaignStats, b: CampaignStats): CampaignStats {
  return {
    planned: {
      inApp: a.planned.inApp + b.planned.inApp,
      email: a.planned.email + b.planned.email,
      telegram: a.planned.telegram + b.planned.telegram,
    },
    skipped: {
      optedOut: a.skipped.optedOut + b.skipped.optedOut,
      noTelegram: a.skipped.noTelegram + b.skipped.noTelegram,
      noAccount: a.skipped.noAccount + b.skipped.noAccount,
    },
  };
}

/**
 * Any HTML-like tag (`<b>`, `</p>`, `<script src=...>`, `<br/>`), stricter than the templates' `looksLikeHtml`, which knows only the
 * common layout tags: campaign text is plain text everywhere (inbox, Telegram, the escaped email part), so no tag is ever meant.
 */
const CAMPAIGN_HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>/;

/**
 * Checks the text of a campaign.
 *
 * Why: S5: campaign text is plain text with `{{name}}` as the only placeholder. HTML is refused on write (the email layout is added
 * by the server, and the inbox clients render text), so stored content can never become markup.
 *
 * @param content the content (lengths are already checked by the contract)
 * @returns the field errors, named `content.title` and `content.body`
 */
export function contentProblems(content: CampaignContent): FieldError[] {
  const errors: FieldError[] = [];
  for (const part of ['title', 'body'] as const) {
    const field = `content.${part}`;
    const value = content[part];
    if (value.trim() === '') {
      errors.push({ field, code: 'required', message: 'Write a text.' });
      continue;
    }
    const unknown = unknownPlaceholders(value, CAMPAIGN_PLACEHOLDERS);
    if (unknown.length > 0) {
      errors.push({
        field,
        code: 'unknown_placeholder',
        message: `Only {{name}} can be used; remove ${unknown.map((name) => `{{${name}}}`).join(', ')}.`,
      });
    }
    if (CAMPAIGN_HTML_TAG.test(value)) {
      errors.push({ field, code: 'html', message: 'Write plain text; the email layout is added for you.' });
    }
  }
  return errors;
}

const SITE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/?#=&%]{0,199}$/;
/** The merchant portal's part of the site: `/merchant`, then `/`, `?`, `#` or nothing. */
const MERCHANT_PATH = /^\/merchant(?:[/?#]|$)/;

/**
 * Checks the links of a campaign.
 *
 * Why: a link is a path on our own site (one leading `/`, no scheme, no host), so a campaign cannot carry a phishing URL (13.1).
 * A merchant link must be a page of the merchant portal (`/merchant/...`): the inbox shows the path as it is and the email and
 * Telegram join it to the site's root, so a path outside the portal (`/orders`) would be wrong on both.
 *
 * @param link the links per audience, or null
 * @returns the field errors, named `link.<audience>`
 */
export function linkProblems(link: CampaignLink | null | undefined): FieldError[] {
  if (!link) return [];
  const errors: FieldError[] = [];
  for (const key of ['staff', 'merchant', 'customer'] as const) {
    const value = link[key];
    if (value === undefined) continue;
    if (!SITE_PATH.test(value)) {
      errors.push({
        field: `link.${key}`,
        code: 'invalid',
        message: 'Use a path on the site that starts with one /, such as /account/orders.',
      });
    } else if (key === 'merchant' && !MERCHANT_PATH.test(value)) {
      errors.push({
        field: 'link.merchant',
        code: 'invalid',
        message: 'Use a page of the merchant portal, such as /merchant/orders.',
      });
    }
  }
  return errors;
}

/**
 * Checks a schedule time.
 *
 * Why: O5: at least one minute ahead (the sweep runs every minute) and at most 90 days.
 *
 * @param scheduledAt the asked time
 * @param nowMs the clock's time
 * @returns the field error on `scheduledAt`, or `undefined`
 */
export function scheduleProblem(scheduledAt: Date, nowMs: number): FieldError | undefined {
  const ahead = scheduledAt.getTime() - nowMs;
  if (ahead < MIN_SCHEDULE_AHEAD_MS)
    return { field: 'scheduledAt', code: 'too_soon', message: 'Choose a time at least one minute from now.' };
  if (ahead > MAX_SCHEDULE_AHEAD_MS)
    return { field: 'scheduledAt', code: 'too_late', message: 'Choose a time at most 90 days from now.' };
  return undefined;
}

/**
 * Compares the number of people staff confirmed with the number the audience reaches now.
 *
 * Why: S11: a send needs the number staff saw; a drift above max(5, 2 %) means the audience changed under them.
 *
 * @param confirm the number staff confirmed
 * @param reachable the number reachable now
 * @returns `empty` when nobody is reachable, `changed` for a drift beyond the tolerance, else `undefined`
 */
export function confirmProblem(confirm: number, reachable: number): 'empty' | 'changed' | undefined {
  if (reachable === 0) return 'empty';
  if (Math.abs(reachable - confirm) > Math.max(5, Math.ceil(confirm * 0.02))) return 'changed';
  return undefined;
}

/**
 * The inbox category of a campaign's items.
 *
 * @param purpose the campaign's purpose
 * @returns `announcement` for a service campaign, `marketing` for marketing
 */
export function categoryOf(purpose: NotificationCampaignPurpose): NotificationInboxCategory {
  return purpose === 'marketing' ? 'marketing' : 'announcement';
}

/** What the fan-out makes for one member. */
export interface MemberRows {
  readonly inApp: boolean;
  readonly email: boolean;
  readonly telegram: boolean;
  readonly skipped: { readonly noAccount: boolean; readonly optedOut: boolean; readonly noTelegram: boolean };
}

/**
 * Which rows the fan-out makes for one person, and why it skips a channel.
 *
 * @param member the person and the channels that reach them
 * @param channels the campaign's channels
 * @returns the rows to make and the skip reasons
 */
export function rowsFor(member: AudienceMember, channels: readonly CampaignChannel[]): MemberRows {
  const wantsInApp = channels.includes('in_app');
  const wantsEmail = channels.includes('email');
  const wantsTelegram = channels.includes('telegram');
  return {
    inApp: wantsInApp && member.inApp,
    email: wantsEmail && member.email,
    telegram: wantsTelegram && member.telegram,
    skipped: {
      noAccount: wantsInApp && !member.inApp,
      optedOut: wantsEmail && !member.email,
      noTelegram: wantsTelegram && !member.telegram,
    },
  };
}

/**
 * The dedupe key of a campaign's email or Telegram row.
 *
 * Why: the fan-out inserts with `ON CONFLICT (dedupe_key) DO NOTHING`, so a chunk that runs twice makes each message once.
 *
 * @param campaignId the campaign
 * @param channel `email` or `telegram`
 * @param type the recipient type
 * @param recipientId the recipient
 * @returns `campaign-<id>:<channel>:<type>-<recipientId>`
 */
export function campaignDedupeKey(
  campaignId: number,
  channel: 'email' | 'telegram',
  type: NotificationRecipientType,
  recipientId: number,
): string {
  return `campaign-${campaignId}:${channel}:${type}-${recipientId}`;
}
