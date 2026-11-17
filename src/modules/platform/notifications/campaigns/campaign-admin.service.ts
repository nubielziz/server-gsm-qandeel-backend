// CampaignAdminService: the staff's reads and edits of notification campaigns (feature 23, plan section 7): list, read, create, edit,
// delete a draft, the recipients of a campaign and the render preview. Every write is one transaction with its audit row.
import { Inject, Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../../common/contract';
import { AppError, type FieldError } from '../../../../common/errors';
import { getRequestContext } from '../../../../common/request-context';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { DbService, type DbExecutor } from '../../../../infra/db';
import { AuditService } from '../../audit/audit.service';
import type {
  NotificationAudience,
  NotificationCampaign,
  NotificationCampaignPurpose,
  NewNotificationCampaign,
} from '../../db/schema';
import { campaignReadCounts } from '../inbox/inbox.repository';
import { MailTransport } from '../mail-transport';
import { staffNames } from '../notification-foreign-reads';
import { type AudienceSpec, audienceProblems, parseStoredAudience } from './audience-spec';
import { renderCampaign } from './campaign-render';
import {
  type CampaignContent,
  type CampaignLink,
  EDITABLE_STATUSES,
  contentProblems,
  linkProblems,
} from './campaign-rules';
import {
  type CampaignSortField,
  type RecipientStatus,
  campaignDelivery,
  deleteDraft,
  findCampaign,
  insertCampaign,
  listCampaigns,
  listRecipients,
  updateCampaignIf,
} from './campaign.repository';
import {
  type WireCampaign,
  type WireCampaignDetail,
  type WireRecipient,
  campaignDetailView,
  campaignView,
  channelsOf,
  contentOf,
  linkOf,
  recipientView,
} from './campaign-views';
import type { CampaignChannel } from './notification-audiences';

/** The fields staff write. */
export interface CampaignInput {
  readonly name: string;
  readonly purpose: NotificationCampaignPurpose;
  readonly channels: CampaignChannel[];
  readonly audience: AudienceSpec;
  readonly content: CampaignContent;
  readonly link?: CampaignLink | null | undefined;
}

/** A render preview, in the template preview's shape. */
export interface CampaignPreview {
  readonly subject: string;
  readonly body: string;
  readonly format: 'text' | 'html';
  readonly from: string;
  readonly note: string;
}

/**
 * The staff member of the current request.
 *
 * Why: the author of a write comes from the authenticated session, never from the body (`files.controller.ts` pattern).
 *
 * @returns the staff id and name
 * @throws {AppError} `UNAUTHORIZED` outside a staff request
 */
export function currentStaff(): { id: number; name: string } {
  const actor = getRequestContext()?.actor;
  if (actor?.type !== 'staff') throw new AppError('UNAUTHORIZED');
  return { id: actor.id, name: actor.name };
}

/**
 * The 404 of a campaign id.
 *
 * @returns the error
 */
export const campaignNotFound = (): AppError => new AppError('NOT_FOUND', { detail: 'No campaign with this id.' });

/**
 * The 409 of a transition the campaign's status does not allow.
 *
 * @param row the campaign as it is now
 * @param what what was tried, as a phrase ("edited", "sent")
 * @returns the error
 */
export const notNow = (row: NotificationCampaign, what: string): AppError =>
  new AppError('INVALID_TRANSITION', { detail: `A ${row.status} campaign cannot be ${what}.` });

/** What the audit log keeps of a campaign. */
function snapshotOf(row: NotificationCampaign): Record<string, unknown> {
  return {
    name: row.name,
    purpose: row.purpose,
    channels: row.channels,
    audience: row.audience,
    content: row.content,
    link: row.link,
    status: row.status,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
  };
}

/** The fields of `after` that differ from `before`, on both sides. */
function changed(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const keys = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return {
    before: Object.fromEntries(keys.map((key) => [key, before[key]])),
    after: Object.fromEntries(keys.map((key) => [key, after[key]])),
  };
}

/** Sample names of the preview per audience (the console's mock names). */
const SAMPLE_NAMES: Record<Exclude<NotificationAudience, 'staff'>, string> = {
  customer: 'Daniel',
  merchant: 'Zain Mobile Hub',
};

/**
 * Lists, reads, creates, edits and deletes campaigns.
 *
 * Why: owner list E: staff create and manage broadcasts from the console. Every write checks the content (plain text, `{{name}}`
 * only), the links (site paths) and the audience, runs in one transaction and writes its audit row (RULES settings 12).
 *
 * Side effects: writes `notification_campaigns` and `audit_logs`.
 */
@Injectable()
export class CampaignAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: MailTransport,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists campaigns.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async list(query: ParsedListQuery<CampaignSortField>): Promise<{ rows: WireCampaign[]; total: number }> {
    const { rows, total } = await listCampaigns(this.db.db, query);
    const names = await staffNames(
      this.db.db,
      rows.map((row) => row.createdBy),
    );
    return { rows: rows.map((row) => campaignView(row, names)), total };
  }

  /**
   * Reads one campaign with its live delivery numbers.
   *
   * @param id the campaign
   * @param db the pool or a transaction (a use case answers with what it just wrote)
   * @returns the detail
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number, db: DbExecutor = this.db.db): Promise<WireCampaignDetail> {
    const row = await findCampaign(db, id);
    if (!row) throw campaignNotFound();
    return this.detail(row, db);
  }

  /**
   * Builds the detail of a row.
   *
   * @param row the campaign
   * @param db the pool or a transaction
   * @returns the detail with names and delivery numbers
   */
  async detail(row: NotificationCampaign, db: DbExecutor = this.db.db): Promise<WireCampaignDetail> {
    const [names, delivery, reads] = await Promise.all([
      staffNames(
        db,
        [row.createdBy, row.updatedBy, row.cancelledBy].filter((id): id is number => id !== null),
      ),
      campaignDelivery(db, row.id),
      campaignReadCounts(db, row.id),
    ]);
    return campaignDetailView(row, names, { inApp: reads, email: delivery.email, telegram: delivery.telegram });
  }

  /**
   * Creates a draft.
   *
   * @param input the campaign
   * @returns the stored draft
   * @throws {AppError} `VALIDATION_FAILED` for blank or HTML text, an unknown placeholder, a link that leaves the site, or an audience
   *   that targets nobody (or Telegram without merchants)
   */
  async create(input: CampaignInput): Promise<WireCampaignDetail> {
    const staff = currentStaff();
    this.validate(input);
    return this.db.runInTransaction(async ({ tx }) => {
      const now = this.clock.now();
      const row = await insertCampaign(tx, {
        name: input.name,
        purpose: input.purpose,
        channels: input.channels,
        audience: input.audience,
        content: storedContent(input.content),
        link: input.link ? { ...input.link } : null,
        status: 'draft',
        createdBy: staff.id,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'created notification campaign',
        entityType: 'notification_campaign',
        entityId: row.id,
        entityLabel: row.name,
        after: { name: row.name, purpose: row.purpose, channels: row.channels, audience: row.audience },
      });
      return this.detail(row, tx);
    });
  }

  /**
   * Edits a draft or scheduled campaign; a scheduled one keeps its time.
   *
   * @param id the campaign
   * @param input the fields to change
   * @returns the stored campaign
   * @throws {AppError} `NOT_FOUND`; `INVALID_TRANSITION` when it is no longer a draft or scheduled; `VALIDATION_FAILED` as for create,
   *   judged on the merged campaign
   */
  async update(id: number, input: Partial<CampaignInput>): Promise<WireCampaignDetail> {
    const staff = currentStaff();
    return this.db.runInTransaction(async ({ tx }) => {
      const current = await findCampaign(tx, id, true);
      if (!current) throw campaignNotFound();
      if (!EDITABLE_STATUSES.includes(current.status)) throw notNow(current, 'edited');
      const merged: CampaignInput = {
        name: input.name ?? current.name,
        purpose: input.purpose ?? current.purpose,
        channels: input.channels ?? channelsOf(current),
        // A stored audience that no longer parses counts as empty, so the merged campaign is refused instead of saved broken.
        audience: input.audience ?? parseStoredAudience(current.audience) ?? {},
        content: input.content ?? contentOf(current),
        link: input.link === undefined ? linkOf(current) : input.link,
      };
      this.validate(merged);
      const set: Partial<NewNotificationCampaign> = {
        name: merged.name,
        purpose: merged.purpose,
        channels: merged.channels,
        audience: merged.audience,
        content: storedContent(merged.content),
        link: merged.link ? { ...merged.link } : null,
        updatedBy: staff.id,
        updatedAt: this.clock.now(),
      };
      const row = await updateCampaignIf(tx, id, EDITABLE_STATUSES, set);
      if (!row) throw notNow(current, 'edited');
      await this.audit.record(tx, {
        action: 'edited notification campaign',
        entityType: 'notification_campaign',
        entityId: id,
        entityLabel: row.name,
        ...changed(snapshotOf(current), snapshotOf(row)),
      });
      return this.detail(row, tx);
    });
  }

  /**
   * Deletes a draft.
   *
   * @param id the campaign
   * @throws {AppError} `NOT_FOUND`; `NOT_A_DRAFT` for any other status
   */
  async remove(id: number): Promise<void> {
    currentStaff();
    await this.db.runInTransaction(async ({ tx }) => {
      const row = await deleteDraft(tx, id);
      if (!row) {
        const current = await findCampaign(tx, id);
        if (!current) throw campaignNotFound();
        throw new AppError('NOT_A_DRAFT', {
          detail: `Only a draft can be deleted; this campaign is ${current.status}. Cancel it instead.`,
        });
      }
      await this.audit.record(tx, {
        action: 'deleted notification campaign',
        entityType: 'notification_campaign',
        entityId: id,
        entityLabel: row.name,
        before: snapshotOf(row),
      });
    });
  }

  /**
   * Lists the recipients of a campaign on one channel.
   *
   * @param id the campaign
   * @param query the parsed list request (status filter, id sort) and `channel`
   * @returns the page with masked addresses and the exact total
   * @throws {AppError} `NOT_FOUND`
   */
  async recipients(
    id: number,
    query: ParsedListQuery<'id', { channel: CampaignChannel }>,
  ): Promise<{ rows: WireRecipient[]; total: number }> {
    const row = await findCampaign(this.db.db, id);
    if (!row) throw campaignNotFound();
    const channel = query.extra.channel;
    const statuses = query.filters
      .filter((filter) => filter.field === 'status')
      .flatMap((filter) => filter.values.map(String) as RecipientStatus[]);
    const { rows, total } = await listRecipients(
      this.db.db,
      id,
      channel,
      statuses,
      query.range,
      query.sort[0]?.order ?? 'asc',
    );
    return { rows: rows.map((recipient) => recipientView(recipient, channel)), total };
  }

  /**
   * Renders a campaign for one channel and audience with a sample name; nothing is sent.
   *
   * @param id the campaign
   * @param input the channel and audience (default customer)
   * @returns the subject, body, format, sender and a note
   * @throws {AppError} `NOT_FOUND`
   */
  async preview(
    id: number,
    input: { channel: CampaignChannel; audience?: NotificationAudience | undefined },
  ): Promise<CampaignPreview> {
    const staff = currentStaff();
    const row = await findCampaign(this.db.db, id);
    if (!row) throw campaignNotFound();
    const audience = input.audience ?? 'customer';
    const { storeBaseUrl } = this.config.http;
    const message = renderCampaign(
      { content: contentOf(row), link: linkOf(row), purpose: row.purpose },
      {
        name: audience === 'staff' ? staff.name : SAMPLE_NAMES[audience],
        audience,
        channel: input.channel,
        // Site paths join the site's root for customers and merchants alike (see NotificationDelivery).
        baseUrl: audience === 'staff' ? undefined : storeBaseUrl,
        ...(audience === 'customer'
          ? {
              unsubscribe: {
                pageUrl: `${storeBaseUrl}/unsubscribe?token=example`,
                oneClickUrl: `${storeBaseUrl}/store/v1/marketing/unsubscribe/example`,
              },
            }
          : audience === 'merchant'
            ? { preferencesUrl: `${storeBaseUrl}/merchant/settings/notifications` }
            : {}),
      },
    );
    return {
      subject: message.subject,
      body: message.html ?? message.text,
      format: message.html === undefined ? 'text' : 'html',
      from:
        input.channel === 'email'
          ? this.mail.from
          : input.channel === 'telegram'
            ? this.config.telegram.botUsername
              ? `@${this.config.telegram.botUsername}`
              : 'Telegram bot'
            : 'In-app notification',
      note: 'A sample with made-up details.',
    };
  }

  /** Refuses a campaign whose content, links or audience break a rule. */
  private validate(input: CampaignInput): void {
    const errors: FieldError[] = [
      ...contentProblems(input.content),
      ...linkProblems(input.link),
      ...audienceProblems(input.audience, input.channels),
    ];
    if (errors.length > 0) throw new AppError('VALIDATION_FAILED', { errors });
  }
}

/** The content as stored: the one title and body. */
function storedContent(content: CampaignContent): Record<string, unknown> {
  return { title: content.title, body: content.body };
}
