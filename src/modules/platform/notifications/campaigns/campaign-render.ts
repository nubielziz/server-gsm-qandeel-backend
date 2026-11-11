// Renders a campaign's message for one person and one channel (feature 23, plan section 6): language pick with English fallback,
// `{{name}}`, the absolute link, the RTL HTML part of an email, the marketing footer and one-click unsubscribe headers. Pure.
import type { NotificationAudience, NotificationCampaignPurpose } from '../../db/schema';
import { TELEGRAM_MAX_TEXT, emailHtml, renderText } from '../template-rules';
import type { CampaignContent, CampaignLink, CampaignText } from './campaign-rules';
import type { CampaignChannel } from './notification-audiences';

/** What a campaign stores that rendering needs. */
export interface RenderableCampaign {
  readonly content: CampaignContent;
  readonly link: CampaignLink | null;
  readonly purpose: NotificationCampaignPurpose;
}

/** Who and where the message is for. */
export interface RenderTarget {
  /** The reader's language (`en`, `ar`, `ar-JO`, ...). */
  readonly locale: string;
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
  /** Which language was used (`ar` falls back to `en` when the campaign has no Arabic). */
  readonly locale: 'en' | 'ar';
}

/**
 * Picks the text of a language, falling back to English.
 *
 * @param content the campaign's content
 * @param locale the reader's language
 * @returns the text and the language it is in
 */
export function pickText(content: CampaignContent, locale: string): { text: CampaignText; locale: 'en' | 'ar' } {
  if (locale.startsWith('ar') && content.ar) return { text: content.ar, locale: 'ar' };
  return { text: content.en, locale: 'en' };
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
 * HTML part (right to left for Arabic); Telegram: title, a blank line, the body, cut at the Bot API limit; in-app: title and body.
 * A link is added when the campaign has one for the audience and the site's address is known (a staff email carries none). A
 * marketing email carries a way out: the unsubscribe link and headers for a customer, the preferences page for a merchant.
 *
 * @param campaign the content, link and purpose
 * @param target the reader's language, name, audience, channel and addresses
 * @returns the message
 */
export function renderCampaign(campaign: RenderableCampaign, target: RenderTarget): RenderedCampaign {
  const picked = pickText(campaign.content, target.locale);
  const variables = { name: target.name };
  const title = renderText(picked.text.title, variables, 'text');
  const body = renderText(picked.text.body, variables, 'text');
  const link =
    target.channel === 'in_app'
      ? undefined
      : target.baseUrl === undefined
        ? undefined
        : linkFor(campaign.link, target.audience, target.baseUrl);
  const arabic = picked.locale === 'ar';
  const parts = [body];
  if (link) parts.push(link);

  if (target.channel === 'telegram') {
    const text = [title, '', ...parts].join('\n').slice(0, TELEGRAM_MAX_TEXT);
    return { subject: title, text, locale: picked.locale };
  }
  if (target.channel === 'in_app') return { subject: title, text: body, locale: picked.locale };

  let headers: Record<string, string> | undefined;
  if (campaign.purpose === 'marketing') {
    if (target.unsubscribe) {
      parts.push(`${arabic ? 'لإلغاء الاشتراك:' : 'Unsubscribe:'} ${target.unsubscribe.pageUrl}`);
      headers = {
        'List-Unsubscribe': `<${target.unsubscribe.oneClickUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    } else if (target.preferencesUrl) {
      parts.push(`${arabic ? 'إدارة الإشعارات:' : 'Manage notifications:'} ${target.preferencesUrl}`);
    }
  }
  const text = parts.join('\n\n');
  return {
    subject: title,
    text,
    html: emailHtml(text, picked.locale),
    ...(headers ? { headers } : {}),
    locale: picked.locale,
  };
}
