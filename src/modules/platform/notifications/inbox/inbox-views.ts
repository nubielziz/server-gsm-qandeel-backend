// The wire shape of an inbox item (feature 23, plan section 10.1) and the text it shows: a campaign item reads the campaign's content,
// an event item the registered in-app text, both in the reader's language. Pure mapping; the service reads the data.
import type { NotificationAudience, NotificationInboxCategory } from '../../db/schema';
import { pickText } from '../campaigns/campaign-render';
import type { CampaignContent, CampaignLink } from '../campaigns/campaign-rules';
import { renderText } from '../template-rules';
import { type InboxTextRegistry, renderInboxText } from './inbox-texts';
import type { InboxRow } from './inbox.repository';

/** An item as the three inbox surfaces answer it. */
export interface WireInboxItem {
  readonly id: number;
  readonly category: NotificationInboxCategory;
  readonly title: string;
  readonly body: string;
  /** A site path without the language prefix, or null. */
  readonly link: string | null;
  /** The language `title` and `body` are in. */
  readonly locale: 'en' | 'ar';
  readonly readAt: string | null;
  readonly createdAt: string;
  readonly campaignId: number | null;
  readonly event: string | null;
}

/** Who reads, and in which language. */
export interface InboxReader {
  readonly audience: NotificationAudience;
  readonly locale: string;
  /** The value of `{{name}}` in a campaign's text. */
  readonly name: string;
}

/** The title shown for an event item whose text is no longer registered (a removed event). */
export const UNKNOWN_EVENT_TITLE = 'Notification';

/**
 * The title, body and link of one item.
 *
 * Why: the stored item holds no text (a campaign's wording can be fixed while it is scheduled; an event's text is code), so the
 * text is made at read time in the reader's language; the values are plain text and clients render them as text.
 *
 * @param row the item with its campaign
 * @param reader the audience, language and name
 * @param texts the registry of event texts
 * @returns the text, its link and the language it is in
 */
export function inboxText(
  row: InboxRow,
  reader: InboxReader,
  texts: InboxTextRegistry,
): { title: string; body: string; link: string | null; locale: 'en' | 'ar' } {
  const { item, campaign } = row;
  if (campaign) {
    const picked = pickText(campaign.content as unknown as CampaignContent, reader.locale);
    const variables = { name: reader.name };
    const link = (campaign.link as CampaignLink | null)?.[reader.audience] ?? null;
    return {
      title: renderText(picked.text.title, variables, 'text'),
      body: renderText(picked.text.body, variables, 'text'),
      link,
      locale: picked.locale,
    };
  }
  const definition = item.event === null ? undefined : texts.get(reader.audience, item.event);
  if (!definition)
    return { title: UNKNOWN_EVENT_TITLE, body: '', link: null, locale: reader.locale.startsWith('ar') ? 'ar' : 'en' };
  return renderInboxText(definition, reader.locale, item.variables as Record<string, string>);
}

/**
 * An item as the wire shape.
 *
 * @param row the item with its campaign
 * @param reader the audience, language and name
 * @param texts the registry of event texts
 * @returns the wire item
 */
export function inboxView(row: InboxRow, reader: InboxReader, texts: InboxTextRegistry): WireInboxItem {
  const text = inboxText(row, reader, texts);
  return {
    id: row.item.id,
    category: row.item.category,
    title: text.title,
    body: text.body,
    link: text.link,
    locale: text.locale,
    readAt: row.item.readAt?.toISOString() ?? null,
    createdAt: row.item.createdAt.toISOString(),
    campaignId: row.item.campaignId,
    event: row.item.event,
  };
}
