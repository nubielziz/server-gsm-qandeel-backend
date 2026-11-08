// NotificationTemplateAdminService: the use cases behind `/admin/notification-templates*` (feature 12a): list, read, add, change, delete
// and preview, each write audited with before and after.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { type DbExecutor, DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../audit/audit.service';
import type {
  NotificationAudience,
  NotificationChannel,
  NotificationRecipientType,
  NotificationTemplate,
} from '../db/schema';
import { type NotificationEventDefinition, NotificationEventRegistry, isEventKey } from './notification-events';
import { MailTransport } from './mail-transport';
import type { createNotificationTemplate } from './notification-templates.contracts';
import { sentCountKey, sentCountsSince } from './notification.repository';
import {
  type TemplateSortField,
  TEMPLATE_UNIQUE,
  deleteTemplate,
  findTemplate,
  insertTemplate,
  listTemplateRows,
  templateExists,
  updateTemplate,
} from './notification-template.repository';
import { checkLocale, checkTemplateFields, placeholdersOf, renderMessage } from './template-rules';

/** A template on the wire. */
export interface WireTemplate {
  readonly id: number;
  readonly event: string;
  readonly channel: NotificationChannel;
  readonly audience: NotificationAudience;
  readonly locale: string;
  readonly subject: string;
  readonly body: string;
  readonly isActive: boolean;
  readonly sentLast30Days: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The body of a create, as the contract parses it. */
export type CreateTemplateInput = z.output<(typeof createNotificationTemplate)['body']>;

/** The fields a change may carry. */
export interface UpdateTemplateInput {
  readonly event?: string;
  readonly channel?: NotificationChannel;
  readonly audience?: NotificationAudience;
  readonly locale?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly isActive?: boolean;
}

/** A rendered preview. */
export interface TemplatePreview {
  readonly subject: string;
  readonly body: string;
  readonly format: 'text' | 'html';
  readonly from: string;
  readonly note: string;
}

const DAY_MS = 86_400_000;
const refuse = (...errors: FieldError[]) => new AppError('VALIDATION_FAILED', { errors });
const notFound = () => new AppError('NOT_FOUND', { detail: 'No notification template with this id.' });
const FIXED_FIELDS = ['event', 'channel', 'audience', 'locale'] as const;

/** The recipient type a template audience matches (identity-platform-11). */
function recipientTypeOf(audience: NotificationAudience): NotificationRecipientType {
  return audience === 'merchant' ? 'client' : audience;
}

/** The audit snapshot of a template: what staff can change. */
function snapshotOf(row: NotificationTemplate): Record<string, unknown> {
  return {
    event: row.event,
    channel: row.channel,
    audience: row.audience,
    locale: row.locale,
    subject: row.subject,
    body: row.body,
    isActive: row.isActive,
  };
}

/** The label the audit log shows. */
const labelOf = (row: NotificationTemplate) => `${row.event} (${row.channel}, ${row.audience}, ${row.locale})`;

/**
 * Reads and changes notification templates.
 *
 * Why: RULES settings 10: staff write the texts the system sends. A template exists only for an event of the registry, uses only that
 * event's placeholders, is unique per event, channel, audience and language, and fixes those four fields at create. Turning one off
 * means "send nothing" (the delivery honours it). Every write is audited with before and after (RULES settings 12).
 *
 * Side effects: writes `notification_templates` and one `audit_logs` row per write.
 */
@Injectable()
export class NotificationTemplateAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly registry: NotificationEventRegistry,
    private readonly mail: MailTransport,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists templates with their 30-day counts.
   *
   * @param query the parsed list request
   * @returns the page and the exact total for the filter
   */
  async list(query: ParsedListQuery<TemplateSortField>): Promise<{ rows: WireTemplate[]; total: number }> {
    const { rows, total } = await listTemplateRows(this.db.db, query);
    const counts = await sentCountsSince(this.db.db, new Date(this.clock.nowMs() - 30 * DAY_MS), [
      ...new Set(rows.map((row) => row.event)),
    ]);
    return { rows: rows.map((row) => toWire(row, counts.get(keyOf(row)) ?? 0)), total };
  }

  /**
   * Reads one template.
   *
   * @param id the template id
   * @returns the template
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<WireTemplate> {
    const row = await findTemplate(this.db.db, id);
    if (!row) throw notFound();
    return this.withCount(row);
  }

  /**
   * Adds a template.
   *
   * @param input the event, channel, audience, language, texts and switch
   * @returns the stored template
   * @throws {AppError} `VALIDATION_FAILED` for an unknown event (on `event`), an event not sent to the audience (on `audience`) or by the channel
   *   (on `channel`), a bad language, an email without a subject, an empty body, a placeholder the event does not offer, or a second template for
   *   the same event, channel, audience and language (on `event`)
   */
  async create(input: CreateTemplateInput): Promise<WireTemplate> {
    const resolved = this.definitionFor(input.event, input.audience, input.channel);
    const localeProblem = checkLocale(input.locale);
    // A bad event hides which placeholders are fine, so the texts are checked only against a real event.
    if ('errors' in resolved) throw refuse(...resolved.errors, ...(localeProblem ? [localeProblem] : []));
    const subject = input.channel === 'email' ? input.subject : '';
    const errors = [
      ...(localeProblem ? [localeProblem] : []),
      ...checkTemplateFields({ channel: input.channel, subject, body: input.body }, resolved.definition.variables),
    ];
    if (errors.length > 0) throw refuse(...errors);

    const duplicate = refuse({
      field: 'event',
      code: 'duplicate',
      message: 'A template for this event, channel and language already exists.',
    });
    try {
      return await this.db.runInTransaction(async ({ tx }) => {
        const key = { event: input.event, channel: input.channel, audience: input.audience, locale: input.locale };
        if (await templateExists(tx, key)) throw duplicate;
        const now = this.clock.now();
        const row = await insertTemplate(tx, {
          ...key,
          subject,
          body: input.body,
          isActive: input.isActive,
          createdAt: now,
          updatedAt: now,
        });
        await this.audit.record(tx, {
          action: 'created notification template',
          entityType: 'notification_template',
          entityId: row.id,
          entityLabel: labelOf(row),
          after: snapshotOf(row),
        });
        return toWire(row, 0);
      });
    } catch (error) {
      // Two requests can pass the pre-check together; the unique constraint is the final word.
      if (isUniqueViolation(error, TEMPLATE_UNIQUE)) throw duplicate;
      throw error;
    }
  }

  /**
   * Changes a template.
   *
   * @param id the template id
   * @param input the fields to change
   * @returns the stored template
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` for a change of event, channel, audience or language (on that field), an email without a
   *   subject, an empty body, or a placeholder the event does not offer
   */
  async update(id: number, input: UpdateTemplateInput): Promise<WireTemplate> {
    return this.db.runInTransaction(async ({ tx }) => {
      const current = await findTemplate(tx, id, true);
      if (!current) throw notFound();
      const errors: FieldError[] = [];
      for (const field of FIXED_FIELDS) {
        const sent = input[field];
        if (sent !== undefined && sent !== current[field]) {
          errors.push({
            field,
            code: 'immutable',
            message: `The ${field} of a template cannot change after it is created; add a new template.`,
          });
        }
      }
      const subject = current.channel === 'email' ? (input.subject ?? current.subject) : '';
      const body = input.body ?? current.body;
      // The texts are checked when they are part of the change: switching a template off must not fail on an old placeholder.
      if (input.subject !== undefined || input.body !== undefined) {
        const definition = this.registry.get(current.event, current.audience);
        errors.push(
          ...checkTemplateFields(
            { channel: current.channel, subject, body },
            definition?.variables ?? placeholdersOf(`${subject}\n${body}`),
          ),
        );
      }
      if (errors.length > 0) throw refuse(...errors);

      const isActive = input.isActive ?? current.isActive;
      const changed = subject !== current.subject || body !== current.body || isActive !== current.isActive;
      const row = changed
        ? await updateTemplate(tx, id, { subject, body, isActive, updatedAt: this.clock.now() })
        : current;
      // The Send switch sends only `{ isActive }`: its entry uses the demo's phrases 'turned on/off notification'
      // (ANSWERS audit Q3). A request that changes nothing is still a staff write, so it is audited too.
      const switchOnly = input.isActive !== undefined && input.subject === undefined && input.body === undefined;
      await this.audit.record(tx, {
        action: switchOnly
          ? isActive
            ? 'turned on notification'
            : 'turned off notification'
          : 'edited notification template',
        entityType: 'notification_template',
        entityId: id,
        entityLabel: labelOf(row),
        before: snapshotOf(current),
        after: snapshotOf(row),
      });
      return this.withCount(row, tx);
    });
  }

  /**
   * Deletes a template.
   *
   * @param id the template id
   * @throws {AppError} `NOT_FOUND`
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const current = await findTemplate(tx, id, true);
      if (!current) throw notFound();
      await deleteTemplate(tx, id);
      await this.audit.record(tx, {
        action: 'deleted notification template',
        entityType: 'notification_template',
        entityId: id,
        entityLabel: labelOf(current),
        before: snapshotOf(current),
      });
    });
  }

  /**
   * Renders a template with sample data; nothing is sent.
   *
   * @param id the template id
   * @param input unsaved text to preview instead of the saved one
   * @returns the subject, the body, its format, the sender and a note
   * @throws {AppError} `NOT_FOUND`
   */
  async preview(
    id: number,
    input: { subject?: string | undefined; body?: string | undefined },
  ): Promise<TemplatePreview> {
    const row = await findTemplate(this.db.db, id);
    if (!row) throw notFound();
    const definition = this.registry.get(row.event, row.audience);
    const message = renderMessage(
      {
        channel: row.channel,
        subject: row.channel === 'email' ? (input.subject ?? row.subject) : '',
        body: input.body ?? row.body,
      },
      definition?.sample ?? {},
    );
    return {
      subject: message.subject,
      body: message.html ?? message.text,
      format: message.format,
      from:
        row.channel === 'email'
          ? this.mail.from
          : this.config.telegram.botUsername
            ? `@${this.config.telegram.botUsername}`
            : 'Telegram bot',
      note: 'A sample with made-up details.',
    };
  }

  /** Finds the event of a new template or says why there is none. */
  private definitionFor(
    event: string,
    audience: NotificationAudience,
    channel: NotificationChannel,
  ): { definition: NotificationEventDefinition } | { errors: FieldError[] } {
    if (!isEventKey(event)) {
      return { errors: [{ field: 'event', code: 'invalid', message: 'Use the event key, such as order.completed.' }] };
    }
    const definition = this.registry.get(event, audience);
    if (!definition) {
      return this.registry.has(event)
        ? {
            errors: [
              {
                field: 'audience',
                code: 'not_for_audience',
                message: `The event ${event} is not sent to ${audience}.`,
              },
            ],
          }
        : {
            errors: [{ field: 'event', code: 'unknown_event', message: `${event} is not an event the system sends.` }],
          };
    }
    if (!definition.channels.includes(channel)) {
      return {
        errors: [
          { field: 'channel', code: 'not_for_channel', message: `The event ${event} cannot be sent by ${channel}.` },
        ],
      };
    }
    return { definition };
  }

  private async withCount(row: NotificationTemplate, db: DbExecutor = this.db.db): Promise<WireTemplate> {
    const counts = await sentCountsSince(db, new Date(this.clock.nowMs() - 30 * DAY_MS), [row.event]);
    return toWire(row, counts.get(keyOf(row)) ?? 0);
  }
}

const keyOf = (row: NotificationTemplate): string =>
  sentCountKey({ event: row.event, channel: row.channel, recipientType: recipientTypeOf(row.audience) });

/** A row on the wire: dates as ISO instants. */
function toWire(row: NotificationTemplate, sentLast30Days: number): WireTemplate {
  return {
    id: row.id,
    event: row.event,
    channel: row.channel,
    audience: row.audience,
    locale: row.locale,
    subject: row.subject,
    body: row.body,
    isActive: row.isActive,
    sentLast30Days,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
