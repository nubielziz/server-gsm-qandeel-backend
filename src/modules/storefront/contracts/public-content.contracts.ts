// Route contracts of the public content of the storefront (map domain H, stage 15): content and legal pages and the help centre.
// Public reads on the `/store/v1` surface (ALIGNMENT § 7): no session, no Turnstile (reads), the per-IP limit applies. They serve
// only what staff published: no draft, and for legal documents only the version in force.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIsoDateTime } from '../../../common/contract';
import { CONTENT_PAGE_KINDS } from '../db/schema';

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
  helpfulYes: z.number().int().min(0),
  helpfulNo: z.number().int().min(0),
  sort: z.number().int(),
  updatedAt: zIsoDateTime,
});

/** A live page as the public list shows it: no body. */
const PageListItem = z.object({
  kind: z.enum(CONTENT_PAGE_KINDS),
  slug: z.string(),
  title: z.string(),
  seoDescription: z.string().describe("`''` when none."),
  noindex: z.boolean().describe('The page is live but must stay out of search results and sitemaps.'),
  publishedAt: zIsoDateTime.nullable(),
  updatedAt: zIsoDateTime,
});

const PAGE_EXAMPLE = {
  kind: 'static',
  slug: 'about',
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
    'A content or landing page by slug: only a `published` or `noindex` page (`noindex` is live with `noindex: true`); a draft is ' +
    '`404`. The slugs `terms`, `privacy`, `refund` and `cookies` answer the legal document of that type in force (`kind: legal`, ' +
    'with `legal` naming the version); no version in force is `404`.',
  tags: ['storefront-public'],
  surface: 'store',
  access: 'public',
  params: z.object({ slug: z.string().min(1).max(120) }),
  success: { status: 200, schema: PublicPage },
  errors: ['VALIDATION_FAILED', 'NOT_FOUND'],
  examples: { response: PAGE_EXAMPLE },
});

/** `GET /store/v1/help`: the published help articles, with search. */
export const listPublicHelp = defineRoute({
  key: 'GET /store/v1/help',
  summary: 'List help articles',
  description:
    'The published articles, in the staff order (`sort`). `q` is a contains over the ' +
    'question, the answer and the topic; `category` filters by topic. Paged like every list (`x-total-count`).',
  tags: ['storefront-public'],
  surface: 'store',
  access: 'public',
  query: listQuery({
    sorts: ['sort', 'question', 'id'],
    defaultSort: { field: 'sort', order: 'asc' },
    filters: { category: { type: 'string', ops: ['eq'] } },
    search: ['question', 'answerMd', 'category'],
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

/** `GET /store/v1/pages`: the live content pages, without their bodies. */
export const listPublicPages = defineRoute({
  key: 'GET /store/v1/pages',
  summary: 'List the published pages',
  description:
    'The live content pages: status `published`, or `noindex` (live, flagged ' +
    '`noindex: true`: leave those out of a sitemap). Drafts are never listed, and neither are the legal documents (read them by ' +
    'slug at `GET /store/v1/pages/:slug`). Filter by `kind`; `q` is a contains over the title; sort by `publishedAt` (default, newest ' +
    'first) or `title`; pages of up to 100 rows with `x-total-count`. Bodies are not included: fetch a page by slug. Public; ' +
    'cacheable for 30 seconds.',
  tags: ['storefront-public'],
  surface: 'store',
  access: 'public',
  query: listQuery({
    sorts: ['publishedAt', 'title', 'id'],
    defaultSort: { field: 'publishedAt', order: 'desc' },
    filters: { kind: { type: 'enum', values: CONTENT_PAGE_KINDS, ops: ['eq'] } },
    search: ['title'],
    maxPage: 100,
  }),
  success: { status: 200, schema: PageListItem },
  errors: ['VALIDATION_FAILED'],
  examples: {
    response: [
      {
        kind: 'blog',
        slug: 'how-to-find-your-imei',
        title: 'How to find your IMEI',
        seoDescription: 'Three ways to find the IMEI of a phone.',
        noindex: false,
        publishedAt: '2026-10-01T09:00:00.000Z',
        updatedAt: '2026-10-02T09:00:00.000Z',
      },
    ],
  },
});

/** `POST /store/v1/help/:slug/vote`: the "was this helpful?" vote. */
export const voteHelpArticle = defineRoute({
  key: 'POST /store/v1/help/:slug/vote',
  summary: 'Vote on a help article',
  description:
    'Counts one "helpful" (`true`) or "not helpful" (`false`) vote on a published article, found by the id that starts the slug (as ' +
    '`GET /store/v1/help/:slug`). One vote per visitor address and article per day counts; a repeat is accepted and ignored with the ' +
    "same `204`, so the answer never tells whether it counted. Voting does not change the article's `updatedAt`. An unknown or " +
    'unpublished article is `404`.',
  tags: ['storefront-public'],
  surface: 'store',
  access: 'public',
  params: z.object({ slug: z.string().min(1).max(200) }),
  body: z.object({ helpful: z.boolean().describe('`true` for "yes, it helped", `false` for "no".') }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'NOT_FOUND'],
  examples: { request: { helpful: true } },
});
