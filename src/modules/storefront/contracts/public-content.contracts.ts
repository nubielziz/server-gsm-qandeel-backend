// Route contracts of the public content of the storefront (map domain H, stage 15): content and legal pages and the help centre.
// Public reads on the `/store/v1` surface (ALIGNMENT § 7): no session, no Turnstile (reads), the per-IP limit applies. They serve
// only what staff published: no draft, and for legal documents only the version in force.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIsoDateTime } from '../../../common/contract';
import { CONTENT_PAGE_KINDS } from '../db/schema';
import { DEFAULT_LOCALE } from '../domain/locales';
import { LocaleField } from './shared';

/** The version of a legal document a page carries, so a checkout can reference it in a consent. */
const PageLegal = z.object({
  id: zId.describe('The `legal_document_id` a consent records.'),
  type: z.string().describe('`terms`, `privacy`, `refund` or `cookies`.'),
  version: z.string(),
  effectiveFrom: zIsoDateTime,
  requiresReacceptance: z.boolean(),
});

/** A public page: a published content page, or the legal document in force. */
const PublicPage = z.object({
  kind: z.enum([...CONTENT_PAGE_KINDS, 'legal']),
  slug: z.string(),
  locale: z.string(),
  title: z.string(),
  bodyMd: z.string().describe('Markdown as stored; HTML inside is rendered only by the storefront.'),
  seoTitle: z.string().describe("`''` when none; the storefront falls back to the title."),
  seoDescription: z.string(),
  canonicalUrl: z.string().nullable(),
  noindex: z.boolean().describe('The page is live but must stay out of search results (`noindex` status).'),
  publishedAt: zIsoDateTime.nullable(),
  updatedAt: zIsoDateTime,
  legal: PageLegal.nullable().describe('Set only for a legal document.'),
});

/** A published help article. */
const PublicArticle = z.object({
  id: zId,
  slug: z.string().describe('`<id>-<words of the question>`: only the id counts when it is read back.'),
  category: z.string(),
  question: z.string(),
  answerMd: z.string(),
  locale: z.string(),
  helpfulYes: z.number().int().min(0),
  helpfulNo: z.number().int().min(0),
  sort: z.number().int(),
  updatedAt: zIsoDateTime,
});

const PAGE_EXAMPLE = {
  kind: 'static',
  slug: 'about',
  locale: 'en',
  title: 'About us',
  bodyMd: '# About us',
  seoTitle: 'About us',
  seoDescription: '',
  canonicalUrl: null,
  noindex: false,
  publishedAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  legal: null,
} as const;

const ARTICLE_EXAMPLE = {
  id: 10,
  slug: '10-how-do-i-find-my-imei',
  category: 'IMEI',
  question: 'How do I find my IMEI?',
  answerMd: 'Dial *#06# on the phone.',
  locale: 'en',
  helpfulYes: 301,
  helpfulNo: 12,
  sort: 10,
  updatedAt: '2026-10-01T09:00:00.000Z',
} as const;

/** `GET /store/v1/pages/:slug`: a content, landing or legal page in its current version. */
export const getPublicPage = defineRoute({
  key: 'GET /store/v1/pages/:slug',
  summary: 'Get a public page',
  description:
    'A content or landing page by slug and language (`?locale=`, default `en`): only a `published` or `noindex` page (`noindex` ' +
    'is live with `noindex: true`); a draft is `404`. The slugs `terms`, `privacy`, `refund` and `cookies` answer the legal ' +
    'document of that type in force in that language (`kind: legal`, with `legal` naming the version); no version in force is `404`.',
  tags: ['storefront-public'],
  surface: 'store',
  access: 'public',
  params: z.object({ slug: z.string().min(1).max(120) }),
  query: z.object({ locale: LocaleField.default(DEFAULT_LOCALE) }),
  success: { status: 200, schema: PublicPage },
  errors: ['VALIDATION_FAILED', 'NOT_FOUND'],
  examples: { response: PAGE_EXAMPLE },
});

/** `GET /store/v1/help`: the published help articles, with search. */
export const listPublicHelp = defineRoute({
  key: 'GET /store/v1/help',
  summary: 'List help articles',
  description:
    'The published articles of one language (`?locale=`, default `en`), in the staff order (`sort`). `q` is a contains over the ' +
    'question, the answer and the topic; `category` filters by topic. Paged like every list (`x-total-count`).',
  tags: ['storefront-public'],
  surface: 'store',
  access: 'public',
  query: listQuery({
    sorts: ['sort', 'question', 'id'],
    defaultSort: { field: 'sort', order: 'asc' },
    filters: { category: { type: 'string', ops: ['eq'] } },
    search: ['question', 'answerMd', 'category'],
    extra: { locale: LocaleField.default(DEFAULT_LOCALE) },
  }),
  success: { status: 200, schema: PublicArticle },
  errors: ['VALIDATION_FAILED'],
  examples: { response: [ARTICLE_EXAMPLE] },
});

/** `GET /store/v1/help/:slug`: one published help article. */
export const getPublicHelp = defineRoute({
  key: 'GET /store/v1/help/:slug',
  summary: 'Get a help article',
  description:
    'The article whose id starts the slug; the words after the id are ignored, so a link survives an edited question. An ' +
    'unpublished or unknown article is `404`.',
  tags: ['storefront-public'],
  surface: 'store',
  access: 'public',
  params: z.object({ slug: z.string().min(1).max(200) }),
  success: { status: 200, schema: PublicArticle },
  errors: ['VALIDATION_FAILED', 'NOT_FOUND'],
  examples: { response: ARTICLE_EXAMPLE },
});
