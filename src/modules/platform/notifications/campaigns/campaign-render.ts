// Renders a campaign's message for one person and one channel (feature 23, plan section 6): `{{name}}`, the absolute link, the HTML
// part of an email, the marketing footer and one-click unsubscribe headers. English only (decision 039). Pure.
import type { NotificationAudience, NotificationCampaignPurpose } from '../../db/schema';
import { TELEGRAM_MAX_TEXT, emailHtml, renderText } from '../template-rules';
import type { CampaignContent, CampaignLink } from './campaign-rules';
import type { CampaignChannel } from './notification-audiences';

/** What a campaign stores that rendering needs. */
export interface RenderableCampaign {
  readonly content: CampaignContent;
  readonly link: CampaignLink | null;
  readonly purpose: NotificationCampaignPurpose;
}

/** Who and where the message is for. */
export interface RenderTarget {
  /** The value of `{{name}}`. */
  readonly name: string;
  readonly audience: NotificationAudience;
  readonly channel: CampaignChannel;
  /** The site's root (STORE_BASE_URL) that the audience's site path is joined to, for customers and merchants; none for staff. */
  readonly baseUrl?: string | undefined;
  /** For a marketing email to a customer: the unsubscribe page and the one-click POST address (slice D builds them). */
  readonly unsubscribe?: { readonly pageUrl: string; readonly oneClickUrl: string } | undefined;
  /** For a marketing email to a merchant: the portal's notification settings. */
  readonly preferencesUrl?: string | undefined;
}

/** A rendered campaign message. */
export interface RenderedCampaign {
  /** The email subject, or the title of an in-app or Telegram message. */
  readonly subject: string;
  /** The text part (the whole Telegram message; the in-app body). */
  readonly text: string;
  /** The HTML part of an email. */
  readonly html?: string;
  /** Extra email headers (`List-Unsubscribe`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The link of an audience, absolute when a base address is known.
 *
 * @param link the campaign's links
 * @param audience who reads it
 * @param baseUrl the site's base address
 * @returns the address, or `undefined` when the campaign has no link for the audience
 */
export function linkFor(
  link: CampaignLink | null,
  audience: NotificationAudience,
  baseUrl?: string,
): string | undefined {
  const path = link?.[audience];
  if (!path) return undefined;
  return baseUrl === undefined ? path : `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Renders a campaign for one person and channel.
 *
 * Why: one function makes what the worker sends and what the preview shows. Email: subject = title, a text part and an escaped
 * HTML part; Telegram: title, a blank line, the body, cut at the Bot API limit; in-app: title and body.
 * A link is added when the campaign has one for the audience and the site's address is known (a staff email carries none). A
 * marketing email carries a way out: the unsubscribe link and headers for a customer, the preferences page for a merchant.
 *
 * @param campaign the content, link and purpose
 * @param target the reader's name, audience, channel and addresses
 * @returns the message
 */
export function renderCampaign(campaign: RenderableCampaign, target: RenderTarget): RenderedCampaign {
  const variables = { name: target.name };
  const title = renderText(campaign.content.title, variables, 'text');
  const body = renderText(campaign.content.body, variables, 'text');
  const link =
    target.channel === 'in_app'
      ? undefined
      : target.baseUrl === undefined
        ? undefined
        : linkFor(campaign.link, target.audience, target.baseUrl);
  const parts = [body];
  if (link) parts.push(link);

  if (target.channel === 'telegram') {
    const text = [title, '', ...parts].join('\n').slice(0, TELEGRAM_MAX_TEXT);
    return { subject: title, text };
  }
  if (target.channel === 'in_app') return { subject: title, text: body };

  let headers: Record<string, string> | undefined;
  if (campaign.purpose === 'marketing') {
    if (target.unsubscribe) {
      parts.push(`Unsubscribe: ${target.unsubscribe.pageUrl}`);
      headers = {
        'List-Unsubscribe': `<${target.unsubscribe.oneClickUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    } else if (target.preferencesUrl) {
      parts.push(`Manage notifications: ${target.preferencesUrl}`);
    }
  }
  const text = parts.join('\n\n');
  return {
    subject: title,
    text,
    html: emailHtml(text),
    ...(headers ? { headers } : {}),
  };
}
