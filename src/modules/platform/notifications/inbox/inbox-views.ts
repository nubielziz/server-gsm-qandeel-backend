// The wire shape of an inbox item (feature 23, plan section 10.1) and the text it shows: a campaign item reads the campaign's content,
// an event item the registered in-app text, both in English (decision 039). Pure mapping; the service reads the data.
import type { NotificationAudience, NotificationInboxCategory } from '../../db/schema';
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
  readonly readAt: string | null;
  readonly createdAt: string;
  readonly campaignId: number | null;
  readonly event: string | null;
}

/** Who reads. */
export interface InboxReader {
  readonly audience: NotificationAudience;
  /** The value of `{{name}}` in a campaign's text. */
  readonly name: string;
}

/** The title shown for an event item whose text is no longer registered (a removed event). */
export const UNKNOWN_EVENT_TITLE = 'Notification';

/**
 * The title, body and link of one item.
 *
 * Why: the stored item holds no text (a campaign's wording can be fixed while it is scheduled; an event's text is code), so the
 * text is made at read time; the values are plain text and clients render them as text.
 *
 * @param row the item with its campaign
 * @param reader the audience and name
 * @param texts the registry of event texts
 * @returns the text and its link
 */
export function inboxText(
  row: InboxRow,
  reader: InboxReader,
  texts: InboxTextRegistry,
): { title: string; body: string; link: string | null } {
  const { item, campaign } = row;
  if (campaign) {
    const content = campaign.content as unknown as CampaignContent;
    const variables = { name: reader.name };
    const link = (campaign.link as CampaignLink | null)?.[reader.audience] ?? null;
    return {
      title: renderText(content.title, variables, 'text'),
      body: renderText(content.body, variables, 'text'),
      link,
    };
  }
  const definition = item.event === null ? undefined : texts.get(reader.audience, item.event);
  if (!definition) return { title: UNKNOWN_EVENT_TITLE, body: '', link: null };
  return renderInboxText(definition, item.variables as Record<string, string>);
}

/**
 * An item as the wire shape.
 *
 * @param row the item with its campaign
 * @param reader the audience and name
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
    readAt: row.item.readAt?.toISOString() ?? null,
    createdAt: row.item.createdAt.toISOString(),
    campaignId: row.item.campaignId,
    event: row.item.event,
  };
}
