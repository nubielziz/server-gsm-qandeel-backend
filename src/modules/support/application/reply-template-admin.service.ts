// ReplyTemplateAdminService: the use cases behind `/admin/reply-templates*` (feature 17): list, read, create, change and delete the canned
// replies, each write audited. The shortcut is trimmed, stored as null when empty and unique ignoring case (RESOLUTIONS b2c-9).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { ReplyTemplate, TicketCategory } from '../db/schema';
import { shortcutToStored, shortcutToWire } from '../domain/template-rules';
import {
  SHORTCUT_UNIQUE,
  type TemplateSortField,
  deleteTemplate,
  findShortcutOwner,
  findTemplate,
  insertTemplate,
  listTemplateRows,
  lockTemplate,
  updateTemplate,
} from '../infra/template.repository';

/** A template on the wire. */
export interface WireTemplate {
  readonly id: number;
  readonly title: string;
  readonly category: TicketCategory;
  readonly locale: string;
  readonly body: string;
  readonly shortcut: string;
  readonly createdBy: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The five fields of a template, as the contract parses them. */
export interface TemplateInput {
  readonly title: string;
  readonly category: TicketCategory;
  readonly locale: string;
  readonly body: string;
  readonly shortcut: string;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No reply template has this id.' });

/** The 409 for a shortcut another template has; the title names the owner when the pre-check found it (a race cannot look it up). */
const taken = (shortcut: string, title?: string) =>
  new AppError('SHORTCUT_TAKEN', {
    detail:
      title === undefined
        ? `${shortcut} is already used by another template.`
        : `${shortcut} already belongs to “${title}”.`,
  });

function toWire(row: ReplyTemplate): WireTemplate {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    locale: row.locale,
    body: row.body,
    shortcut: shortcutToWire(row.shortcut),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The audit snapshot of a template: what staff can change. */
const snapshotOf = (row: ReplyTemplate) => ({
  title: row.title,
  category: row.category,
  locale: row.locale,
  body: row.body,
  shortcut: shortcutToWire(row.shortcut),
});

/**
 * Reads and changes reply templates.
 *
 * Why: RULES support 7: the canned replies of the composer. Title, category, language and text are required; the shortcut is optional
 * and unique among the non-empty ones (`409 SHORTCUT_TAKEN`, checked before the write and again from the unique index, so two requests
 * at once never answer 500). The server stores the text raw: the console fills `{{name}}`, `{{order}}` and `{{eta}}`. Replies already
 * sent keep their text, so a delete is a hard delete. Every write is audited.
 *
 * Side effects: writes `reply_templates` and one `audit_logs` row per write.
 */
@Injectable()
export class ReplyTemplateAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists templates.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async list(query: ParsedListQuery<TemplateSortField>): Promise<{ rows: WireTemplate[]; total: number }> {
    const { rows, total } = await listTemplateRows(this.db.db, query);
    return { rows: rows.map(toWire), total };
  }

  /**
   * Reads one template.
   *
   * @param id the template id
   * @returns the template
   * @throws {AppError} `NOT_FOUND`
   */
  async show(id: number): Promise<WireTemplate> {
    const row = await findTemplate(this.db.db, id);
    if (!row) throw notFound();
    return toWire(row);
  }

  /**
   * Creates a template.
   *
   * @param input the five fields
   * @param staffId the author (`created_by`)
   * @returns the new template
   * @throws {AppError} `SHORTCUT_TAKEN` (409) when another template has the shortcut
   */
  async create(input: TemplateInput, staffId: number): Promise<WireTemplate> {
    return this.db.runInTransaction(async ({ tx }) => {
      const shortcut = shortcutToStored(input.shortcut);
      if (shortcut !== null) {
        const owner = await findShortcutOwner(tx, shortcut);
        if (owner) throw taken(shortcut, owner.title);
      }
      const now = this.clock.now();
      let row: ReplyTemplate;
      try {
        row = await insertTemplate(tx, {
          title: input.title,
          category: input.category,
          locale: input.locale,
          body: input.body,
          shortcut,
          createdBy: staffId,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (shortcut !== null && isUniqueViolation(error, SHORTCUT_UNIQUE)) throw taken(shortcut);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'created reply template',
        entityType: 'reply_template',
        entityId: row.id,
        entityLabel: row.title,
        after: snapshotOf(row),
      });
      return toWire(row);
    });
  }

  /**
   * Changes a template.
   *
   * @param id the template id
   * @param changes the keys to change
   * @returns the updated template
   * @throws {AppError} `NOT_FOUND`; `SHORTCUT_TAKEN` (409) when another template has the new shortcut
   */
  async update(id: number, changes: Partial<TemplateInput>): Promise<WireTemplate> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await lockTemplate(tx, id);
      if (!before) throw notFound();
      const shortcut = changes.shortcut === undefined ? undefined : shortcutToStored(changes.shortcut);
      if (shortcut !== undefined && shortcut !== null) {
        const owner = await findShortcutOwner(tx, shortcut, id);
        if (owner) throw taken(shortcut, owner.title);
      }
      let row: ReplyTemplate;
      try {
        row = await updateTemplate(tx, id, {
          ...(changes.title === undefined ? {} : { title: changes.title }),
          ...(changes.category === undefined ? {} : { category: changes.category }),
          ...(changes.locale === undefined ? {} : { locale: changes.locale }),
          ...(changes.body === undefined ? {} : { body: changes.body }),
          ...(shortcut === undefined ? {} : { shortcut }),
          updatedAt: this.clock.now(),
        });
      } catch (error) {
        if (shortcut != null && isUniqueViolation(error, SHORTCUT_UNIQUE)) throw taken(shortcut);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'edited reply template',
        entityType: 'reply_template',
        entityId: id,
        entityLabel: row.title,
        before: snapshotOf(before),
        after: snapshotOf(row),
      });
      return toWire(row);
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
      const before = await lockTemplate(tx, id);
      if (!before) throw notFound();
      await deleteTemplate(tx, id);
      await this.audit.record(tx, {
        action: 'deleted reply template',
        entityType: 'reply_template',
        entityId: id,
        entityLabel: before.title,
        before: snapshotOf(before),
      });
    });
  }
}
