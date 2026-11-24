// Wire shapes of the notification campaigns (feature 23, plan section 10.1): a list row, the detail with live delivery numbers, and a
// recipient with a masked address. Pure mapping; the services read the data.
import type { NotificationCampaign, NotificationCampaignPurpose, NotificationCampaignStatus } from '../../db/schema';
import { maskEmail } from '../masking';
import type { AudienceSpec } from './audience-spec';
import { type CampaignContent, type CampaignLink, statsOf } from './campaign-rules';
import type { ChannelDelivery, RecipientRow } from './campaign.repository';
import type { CampaignChannel } from './notification-audiences';

/** A staff member named on a campaign. */
export interface StaffRef {
  readonly id: number;
  readonly name: string;
}

/** A campaign in the list. */
export interface WireCampaign {
  readonly id: number;
  readonly name: string;
  readonly purpose: NotificationCampaignPurpose;
  readonly channels: CampaignChannel[];
  readonly status: NotificationCampaignStatus;
  readonly scheduledAt: string | null;
  readonly queuedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly cancelledAt: string | null;
  readonly expectedRecipients: number | null;
  readonly recipients: number;
  readonly planned: { inApp: number; email: number };
  readonly error: string | null;
  readonly createdBy: StaffRef;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A campaign with its audience, content and delivery numbers. */
export interface WireCampaignDetail extends WireCampaign {
  readonly audience: AudienceSpec;
  readonly content: CampaignContent;
  readonly link: CampaignLink | null;
  readonly skipped: { optedOut: number; noAccount: number };
  readonly delivery: {
    inApp: { delivered: number; read: number };
    email: ChannelDelivery;
  };
  readonly updatedBy: StaffRef | null;
  readonly cancelledBy: StaffRef | null;
}

/** A recipient of a campaign on one channel. */
export interface WireRecipient {
  readonly id: number;
  readonly channel: CampaignChannel;
  readonly recipientType: 'staff' | 'account';
  readonly recipientId: number;
  readonly recipient: string;
  readonly status: 'delivered' | 'read' | 'queued' | 'sent' | 'failed';
  readonly error: string | null;
  readonly attempts: number | null;
  readonly sentAt: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/**
 * The content of a stored campaign.
 *
 * @param row the campaign
 * @returns the content (validated on write)
 */
export function contentOf(row: NotificationCampaign): CampaignContent {
  return row.content as unknown as CampaignContent;
}

/**
 * The links of a stored campaign.
 *
 * @param row the campaign
 * @returns the links, or null
 */
export function linkOf(row: NotificationCampaign): CampaignLink | null {
  return row.link ?? null;
}

/**
 * The channels of a stored campaign.
 *
 * Why: the column's CHECK still allows the value of the retired Telegram channel, so a campaign stored with it reads without it: the
 * value is "not sent" (the fan-out, the preview and the wire never see it).
 *
 * @param row the campaign
 * @returns the channels in use (`in_app`, `email`), in the stored order
 */
export function channelsOf(row: NotificationCampaign): CampaignChannel[] {
  return row.channels.filter((channel): channel is CampaignChannel => channel === 'in_app' || channel === 'email');
}

const refOf = (id: number | null, names: ReadonlyMap<number, string>): StaffRef | null =>
  id === null ? null : { id, name: names.get(id) ?? '' };

/**
 * A campaign as a list row.
 *
 * @param row the campaign
 * @param names staff names by id (the author)
 * @returns the wire row
 */
export function campaignView(row: NotificationCampaign, names: ReadonlyMap<number, string>): WireCampaign {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    channels: channelsOf(row),
    status: row.status,
    scheduledAt: iso(row.scheduledAt),
    queuedAt: iso(row.queuedAt),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    cancelledAt: iso(row.cancelledAt),
    expectedRecipients: row.expectedRecipients,
    recipients: row.recipients,
    planned: { ...statsOf(row.stats).planned },
    error: row.error,
    createdBy: refOf(row.createdBy, names)!,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A campaign with everything the detail page shows.
 *
 * @param row the campaign
 * @param names staff names by id (author, editor, canceller)
 * @param delivery the live counters
 * @returns the wire detail
 */
export function campaignDetailView(
  row: NotificationCampaign,
  names: ReadonlyMap<number, string>,
  delivery: WireCampaignDetail['delivery'],
): WireCampaignDetail {
  const content = contentOf(row);
  return {
    ...campaignView(row, names),
    audience: row.audience,
    content: { title: content.title, body: content.body },
    link: linkOf(row),
    skipped: { ...statsOf(row.stats).skipped },
    delivery,
    updatedBy: refOf(row.updatedBy, names),
    cancelledBy: refOf(row.cancelledBy, names),
  };
}

/**
 * A recipient row with its address masked.
 *
 * @param row the row with the current address
 * @param channel the channel the list is for
 * @returns the wire row
 */
export function recipientView(row: RecipientRow, channel: CampaignChannel): WireRecipient {
  return {
    id: row.id,
    channel,
    recipientType: row.recipientType,
    recipientId: row.recipientId,
    recipient: maskEmail(row.email ?? ''),
    status: row.status as WireRecipient['status'],
    error: row.error,
    attempts: row.attempts,
    sentAt: iso(row.sentAt),
    readAt: iso(row.readAt),
    createdAt: row.createdAt.toISOString(),
  };
}
