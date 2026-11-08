// PublicContentService: the use cases of the public content routes (map domain H, stage 15): a page by slug and language (a live
// content page or the legal document in force) and the help centre. Reads only; nothing here is a decision.
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { ContentPageKind, HelpArticle } from '../db/schema';
import { helpIdOfSlug, helpSlugOf } from '../domain/help-slug';
import { LEGAL_TYPE_LABEL, legalTypeOfSlug } from '../domain/legal';
import { findLivePage } from '../infra/content-page.repository';
import { findPublishedArticle, listArticles } from '../infra/help-article.repository';
import { CurrentLegalDocuments } from './legal-documents';

/** The version of a legal document a public page carries. */
export interface PublicPageLegal {
  readonly id: number;
  readonly type: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly requiresReacceptance: boolean;
}

/** A public page: a live content page, or the legal document in force. */
export interface PublicPageView {
  readonly kind: ContentPageKind | 'legal';
  readonly slug: string;
  readonly locale: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly canonicalUrl: string | null;
  readonly noindex: boolean;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
  readonly legal: PublicPageLegal | null;
}

/** A published help article as the storefront reads it. */
export interface PublicArticleView {
  readonly id: number;
  readonly slug: string;
  readonly category: string;
  readonly question: string;
  readonly answerMd: string;
  readonly locale: string;
  readonly helpfulYes: number;
  readonly helpfulNo: number;
  readonly sort: number;
  readonly updatedAt: string;
}

const pageNotFound = () => new AppError('NOT_FOUND', { detail: 'No page has this address.' });
const articleNotFound = () => new AppError('NOT_FOUND', { detail: 'No help article has this address.' });

function toArticleView(article: HelpArticle): PublicArticleView {
  return {
    id: article.id,
    slug: helpSlugOf(article),
    category: article.category,
    question: article.question,
    answerMd: article.answerMd,
    locale: article.locale,
    helpfulYes: article.helpfulYes,
    helpfulNo: article.helpfulNo,
    sort: article.sort,
    updatedAt: article.updatedAt.toISOString(),
  };
}

/**
 * Serves the public content of the storefront.
 *
 * Why: the storefront renders pages and the help centre from these routes. Only what staff published is public: a draft page,
 * an unpublished article and a legal version that is not in force are all a plain 404. HTML in a body is returned as stored
 * and rendered only by the storefront.
 *
 * Side effects: none (reads only).
 *
 * @see docs/contract/endpoints/storefront.md (the `/store/v1/pages` and `/store/v1/help` sections)
 */
@Injectable()
export class PublicContentService {
  constructor(
    private readonly db: DbService,
    private readonly legal: CurrentLegalDocuments,
  ) {}

  /**
   * Finds a page by slug and language.
   *
   * @param slug the slug; `terms`, `privacy`, `refund` and `cookies` name the legal document in force
   * @param locale the language
   * @returns the live content page, or the legal document in force
   * @throws {AppError} `NOT_FOUND` (404: unknown, a draft, or no legal version in force in that language)
   */
  async page(slug: string, locale: string): Promise<PublicPageView> {
    const type = legalTypeOfSlug(slug);
    if (type !== undefined) {
      const document = await this.legal.currentWithBody(this.db.db, type, locale);
      if (!document?.effectiveFrom) throw pageNotFound();
      const title = LEGAL_TYPE_LABEL[type];
      return {
        kind: 'legal',
        slug: type,
        locale: document.locale,
        title,
        bodyMd: document.bodyMd,
        seoTitle: title,
        seoDescription: '',
        canonicalUrl: null,
        noindex: false,
        publishedAt: document.effectiveFrom.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
        legal: {
          id: document.id,
          type: document.type,
          version: document.version,
          effectiveFrom: document.effectiveFrom.toISOString(),
          requiresReacceptance: document.requiresReacceptance,
        },
      };
    }
    const page = await findLivePage(this.db.db, slug, locale);
    if (!page) throw pageNotFound();
    return {
      kind: page.kind,
      slug: page.slug,
      locale: page.locale,
      title: page.title,
      bodyMd: page.bodyMd,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      canonicalUrl: page.canonicalUrl,
      noindex: page.status === 'noindex',
      publishedAt: page.publishedAt?.toISOString() ?? null,
      updatedAt: page.updatedAt.toISOString(),
      legal: null,
    };
  }

  /**
   * Lists the published help articles of a language.
   *
   * @param query the parsed list request (`q`, `category`, paging, `sort`)
   * @param locale the language
   * @returns the page of articles and the exact total
   */
  async helpList(
    query: ParsedListQuery<'sort' | 'question' | 'id', unknown>,
    locale: string,
  ): Promise<{ rows: PublicArticleView[]; total: number }> {
    const { rows, total } = await listArticles(this.db.db, query, locale);
    return { rows: rows.map(toArticleView), total };
  }

  /**
   * Finds one published help article by its slug.
   *
   * @param slug `<id>-<words>`; only the id counts
   * @returns the article
   * @throws {AppError} `NOT_FOUND` (404: no such id, or the article is not published)
   */
  async help(slug: string): Promise<PublicArticleView> {
    const id = helpIdOfSlug(slug);
    if (id === undefined) throw articleNotFound();
    const article = await findPublishedArticle(this.db.db, id);
    if (!article) throw articleNotFound();
    return toArticleView(article);
  }
}
