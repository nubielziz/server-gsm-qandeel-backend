// HelpArticleAdminService: the use cases of the help article routes (map domain H, stage 15): list, show, create and change. The
// publish switch is a PATCH of `isPublished` under `storefront:update` (B58, ANSWERS storefront Q6).
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { HelpArticle } from '../db/schema';
import {
  type HelpArticleSort,
  findArticle,
  insertArticle,
  listArticles,
  updateArticle,
} from '../infra/help-article.repository';

/** An article as the console reads it. */
export interface HelpArticleView {
  readonly id: number;
  readonly category: string;
  readonly question: string;
  readonly answerMd: string;
  readonly locale: string;
  readonly isPublished: boolean;
  readonly helpfulYes: number;
  readonly helpfulNo: number;
  readonly sort: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The fields of `POST /admin/help-articles`. */
export interface CreateHelpArticleInput {
  readonly category: string;
  readonly question: string;
  readonly answerMd: string;
  readonly locale: string;
  readonly isPublished?: boolean | undefined;
}

/** The fields `PATCH /admin/help-articles/:id` may change. */
export type UpdateHelpArticleInput = Partial<CreateHelpArticleInput>;

const notFound = () => new AppError('NOT_FOUND', { detail: 'No article has this id.' });

/**
 * Turns an article row into what the console reads.
 *
 * @param article the stored article
 * @returns the wire row
 */
export function toHelpArticleView(article: HelpArticle): HelpArticleView {
  return {
    id: article.id,
    category: article.category,
    question: article.question,
    answerMd: article.answerMd,
    locale: article.locale,
    isPublished: article.isPublished,
    helpfulYes: article.helpfulYes,
    helpfulNo: article.helpfulNo,
    sort: article.sort,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
  };
}

const snapshot = (article: HelpArticle) => ({
  category: article.category,
  question: article.question,
  locale: article.locale,
  isPublished: article.isPublished,
});

/**
 * Manages help articles.
 *
 * Why: the console's Help centre tab writes the articles the public help routes serve. A new article goes last in the order and
 * starts with no votes. Only published articles are public; the switch is audited with the demo's phrases.
 *
 * Side effects: writes `help_articles` and `audit_logs` (entity `help_article`).
 *
 * @see docs/contract/endpoints/storefront.md (the `/admin/help-articles` sections)
 */
@Injectable()
export class HelpArticleAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists articles.
   *
   * @param query the parsed list request
   * @returns the page of articles and the exact total
   */
  async list(query: ParsedListQuery<HelpArticleSort>): Promise<{ rows: HelpArticleView[]; total: number }> {
    const { rows, total } = await listArticles(this.db.db, query);
    return { rows: rows.map(toHelpArticleView), total };
  }

  /**
   * Shows one article.
   *
   * @param id the article id
   * @returns the article
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<HelpArticleView> {
    const article = await findArticle(this.db.db, id);
    if (!article) throw notFound();
    return toHelpArticleView(article);
  }

  /**
   * Creates an article at the end of the order.
   *
   * @param input the article fields
   * @returns the new article (no votes)
   */
  async create(input: CreateHelpArticleInput): Promise<HelpArticleView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const article = await insertArticle(tx, {
        category: input.category,
        question: input.question,
        answerMd: input.answerMd,
        locale: input.locale,
        isPublished: input.isPublished ?? false,
      });
      await this.audit.record(tx, {
        action: 'created help article',
        entityType: 'help_article',
        entityId: article.id,
        entityLabel: article.question,
        after: snapshot(article),
      });
      return toHelpArticleView(article);
    });
  }

  /**
   * Changes an article: its text, topic or language, and/or the publish switch.
   *
   * @param id the article id
   * @param changes the keys to change
   * @returns the updated article
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async update(id: number, changes: UpdateHelpArticleInput): Promise<HelpArticleView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await findArticle(tx, id, true);
      if (!before) throw notFound();
      const article = await updateArticle(tx, id, {
        ...(changes.category === undefined ? {} : { category: changes.category }),
        ...(changes.question === undefined ? {} : { question: changes.question }),
        ...(changes.answerMd === undefined ? {} : { answerMd: changes.answerMd }),
        ...(changes.locale === undefined ? {} : { locale: changes.locale }),
        ...(changes.isPublished === undefined ? {} : { isPublished: changes.isPublished }),
      });
      const { isPublished, ...edits } = changes;
      if (Object.values(edits).some((value) => value !== undefined)) {
        await this.audit.record(tx, {
          action: 'edited help article',
          entityType: 'help_article',
          entityId: id,
          entityLabel: article.question,
          before: snapshot(before),
          after: snapshot(article),
        });
      }
      if (isPublished !== undefined) {
        await this.audit.record(tx, {
          action: article.isPublished ? 'published help article' : 'unpublished help article',
          entityType: 'help_article',
          entityId: id,
          entityLabel: article.question,
          before: { isPublished: before.isPublished },
          after: { isPublished: article.isPublished },
        });
      }
      return toHelpArticleView(article);
    });
  }
}
