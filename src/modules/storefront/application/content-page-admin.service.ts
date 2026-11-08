// ContentPageAdminService: the use cases of the content page routes (map domain H, stage 15): list, show, create a draft, change,
// and publish or hide. Rules: a slug is unique per language and never one of the legal document words; a new page is a draft;
// the status changes only through the publish route.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import { isReservedSlug } from '../domain/legal';
import { SLUG_FORM_MESSAGE, chooseSlug, isSlug } from '../domain/slug';
import type { ContentPage, ContentPageKind } from '../db/schema';
import {
  type ContentPageSort,
  findPage,
  insertPage,
  listPages,
  pageSlugTaken,
  updatePage,
} from '../infra/content-page.repository';

/** A page as the console reads it. */
export interface ContentPageView {
  readonly id: number;
  readonly kind: ContentPageKind;
  readonly slug: string;
  readonly locale: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly status: ContentPage['status'];
  readonly publishedAt: string | null;
  /** The page's own canonical address, `null` when none is set (ANSWERS storefront Q8). */
  readonly canonicalUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly visits30d: null;
  readonly orders30d: null;
}

/** The fields of `POST /admin/content-pages`. */
export interface CreateContentPageInput {
  readonly kind: ContentPageKind;
  readonly title: string;
  readonly locale: string;
  readonly slug?: string | undefined;
  readonly bodyMd: string;
  readonly seoTitle?: string | undefined;
  readonly seoDescription?: string | undefined;
}

/** The fields `PATCH /admin/content-pages/:id` may change (never `kind` or `status`). */
export interface UpdateContentPageInput {
  readonly title?: string | undefined;
  readonly slug?: string | undefined;
  readonly locale?: string | undefined;
  readonly bodyMd?: string | undefined;
  readonly seoTitle?: string | undefined;
  readonly seoDescription?: string | undefined;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No page has this id.' });

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code: 'invalid', message }] });
}

/** The 409 answer for a slug that is taken, naming the field the console highlights. */
function slugTaken(slug: string, reserved: boolean): AppError {
  const message = reserved
    ? `The slug ${slug} is reserved for the legal documents.`
    : `The slug ${slug} is already used by another page.`;
  return new AppError('SLUG_TAKEN', { detail: message, errors: [{ field: 'slug', code: 'duplicate', message }] });
}

/**
 * Turns a page row into what the console reads; the 30-day figures have no source in the map (B55).
 *
 * @param page the stored page
 * @returns the wire row
 */
export function toContentPageView(page: ContentPage): ContentPageView {
  return {
    id: page.id,
    kind: page.kind,
    slug: page.slug,
    locale: page.locale,
    title: page.title,
    bodyMd: page.bodyMd,
    seoTitle: page.seoTitle,
    seoDescription: page.seoDescription,
    status: page.status,
    publishedAt: page.publishedAt?.toISOString() ?? null,
    canonicalUrl: page.canonicalUrl,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
    visits30d: null,
    orders30d: null,
  };
}

const snapshot = (page: ContentPage) => ({
  kind: page.kind,
  slug: page.slug,
  locale: page.locale,
  title: page.title,
  seoTitle: page.seoTitle,
  seoDescription: page.seoDescription,
  status: page.status,
});

/**
 * Manages landing pages, static pages and the blog.
 *
 * Why: the console's Landing pages and Content tabs write the pages the public storefront serves (`GET /store/v1/pages/:slug`).
 * A slug is unique per language (checked before the write and again from the unique index, so a race answers 409, never 500)
 * and may not be one of the four legal document words, which the same public route serves.
 *
 * Side effects: writes `content_pages` and `audit_logs` (entity `content_page`).
 *
 * @see docs/contract/endpoints/storefront.md (the `/admin/content-pages` sections)
 */
@Injectable()
export class ContentPageAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists pages.
   *
   * @param query the parsed list request
   * @returns the page of pages and the exact total
   */
  async list(query: ParsedListQuery<ContentPageSort>): Promise<{ rows: ContentPageView[]; total: number }> {
    const { rows, total } = await listPages(this.db.db, query);
    return { rows: rows.map(toContentPageView), total };
  }

  /**
   * Shows one page.
   *
   * @param id the page id
   * @returns the page
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<ContentPageView> {
    const page = await findPage(this.db.db, id);
    if (!page) throw notFound();
    return toContentPageView(page);
  }

  /**
   * Creates a draft page.
   *
   * @param input the page fields
   * @param staffId the signed-in staff member (`author_id`)
   * @returns the new draft
   * @throws {AppError} `VALIDATION_FAILED` (422 on `slug`); `SLUG_TAKEN` (409 on `slug`)
   */
  async create(input: CreateContentPageInput, staffId: number): Promise<ContentPageView> {
    const chosen = chooseSlug(input.slug, input.title);
    if (!chosen.ok) throw invalid('slug', chosen.message);
    return this.db.runInTransaction(async ({ tx }) => {
      if (isReservedSlug(chosen.slug)) throw slugTaken(chosen.slug, true);
      if (await pageSlugTaken(tx, input.locale, chosen.slug)) throw slugTaken(chosen.slug, false);
      let page;
      try {
        page = await insertPage(tx, {
          kind: input.kind,
          slug: chosen.slug,
          locale: input.locale,
          title: input.title,
          bodyMd: input.bodyMd,
          seoTitle: input.seoTitle ?? '',
          seoDescription: input.seoDescription ?? '',
          status: 'draft',
          authorId: staffId,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'content_pages_slug_uq')) throw slugTaken(chosen.slug, false);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'created page',
        entityType: 'content_page',
        entityId: page.id,
        entityLabel: page.title,
        after: snapshot(page),
      });
      return toContentPageView(page);
    });
  }

  /**
   * Changes a page.
   *
   * @param id the page id
   * @param changes the keys to change
   * @returns the updated page (`updatedAt` moves forward)
   * @throws {AppError} `NOT_FOUND` (404); `VALIDATION_FAILED` (422 on `slug`); `SLUG_TAKEN` (409 on `slug`, judged against
   *   the new language when both change)
   */
  async update(id: number, changes: UpdateContentPageInput): Promise<ContentPageView> {
    if (changes.slug !== undefined && !isSlug(changes.slug)) throw invalid('slug', SLUG_FORM_MESSAGE);
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await findPage(tx, id, true);
      if (!before) throw notFound();
      const slug = changes.slug ?? before.slug;
      const locale = changes.locale ?? before.locale;
      if ((slug !== before.slug || locale !== before.locale) && (await this.slugConflict(tx, locale, slug, id))) {
        throw slugTaken(slug, isReservedSlug(slug));
      }
      let page;
      try {
        page = await updatePage(tx, id, {
          ...(changes.title === undefined ? {} : { title: changes.title }),
          ...(changes.slug === undefined ? {} : { slug: changes.slug }),
          ...(changes.locale === undefined ? {} : { locale: changes.locale }),
          ...(changes.bodyMd === undefined ? {} : { bodyMd: changes.bodyMd }),
          ...(changes.seoTitle === undefined ? {} : { seoTitle: changes.seoTitle }),
          ...(changes.seoDescription === undefined ? {} : { seoDescription: changes.seoDescription }),
        });
      } catch (error) {
        if (isUniqueViolation(error, 'content_pages_slug_uq')) throw slugTaken(slug, false);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'edited page',
        entityType: 'content_page',
        entityId: id,
        entityLabel: page.title,
        before: snapshot(before),
        after: snapshot(page),
      });
      return toContentPageView(page);
    });
  }

  /**
   * Publishes a page or hides it.
   *
   * Why: B56 and ANSWERS storefront Q3: `published: true` makes it live; `false` hides it as a draft. `published_at` is the
   * moment of the last publish (endpoint doc: "published_at now"): set from the injected clock on every publish, including a
   * page that is already live, and kept when the page is hidden.
   *
   * @param id the page id
   * @param published true to publish, false to hide
   * @returns the updated page
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async publish(id: number, published: boolean): Promise<ContentPageView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await findPage(tx, id, true);
      if (!before) throw notFound();
      const page = await updatePage(tx, id, {
        status: published ? 'published' : 'draft',
        ...(published ? { publishedAt: this.clock.now() } : {}),
      });
      await this.audit.record(tx, {
        action: published ? 'published page' : 'unpublished page',
        entityType: 'content_page',
        entityId: id,
        entityLabel: page.title,
        before: { status: before.status },
        after: { status: page.status },
      });
      return toContentPageView(page);
    });
  }

  /** True when another page, or a legal document word, already holds the slug in the language. */
  private async slugConflict(tx: Parameters<typeof pageSlugTaken>[0], locale: string, slug: string, id: number) {
    return isReservedSlug(slug) || (await pageSlugTaken(tx, locale, slug, id));
  }
}
