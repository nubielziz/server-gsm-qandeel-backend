// Route contracts of the content pages (map domain H, stage 15): landing pages, static pages and the blog, draft then publish.
// Shapes match the console's ContentPage (docs/contract/endpoints/storefront.md, ANSWERS storefront Q2, Q3, Q8 and Q9).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { CONTENT_PAGE_KINDS, CONTENT_PAGE_STATUSES } from '../db/schema';
import {
  BODY_MAX,
  LocaleField,
  STOREFRONT_LOCALES,
  SeoDescriptionField,
  SeoTitleField,
  SlugField,
  markdown,
  titleField,
} from './shared';

/** A page as the console reads it. */
export const ContentPageRow = z.object({
  id: zId,
  kind: z.enum(CONTENT_PAGE_KINDS),
  slug: z.string(),
  locale: z.string(),
  title: z.string(),
  bodyMd: z.string().describe('The full Markdown, as stored; the editors start from the row.'),
  seoTitle: z.string().describe("`''` when none."),
  seoDescription: z.string().describe("`''` when none."),
  status: z.enum(CONTENT_PAGE_STATUSES),
  publishedAt: zIsoDateTime
    .nullable()
    .describe('`null` until the first publish; the moment of the last publish after that.'),
  canonicalUrl: z
    .string()
    .nullable()
    .describe('The canonical address of the page, `null` when none is set (ANSWERS storefront Q8).'),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
  visits30d: z.number().int().nullable().describe('`null`: the map has no analytics source (B55).'),
  orders30d: z.number().int().nullable().describe('`null`: the map has no analytics source (B55).'),
});

const PAGE_EXAMPLE = {
  id: 1,
  kind: 'carrier',
  slug: 'unlock-iphone-on-atandt',
  locale: 'en',
  title: 'Unlock iPhone on AT&T',
  bodyMd: '# Unlock iPhone on AT&T\n\nHow the unlock works.',
  seoTitle: 'Unlock iPhone on AT&T',
  seoDescription: '',
  status: 'published',
  publishedAt: '2026-10-01T09:00:00.000Z',
  canonicalUrl: null,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  visits30d: null,
  orders30d: null,
} as const;

/** `GET /admin/content-pages`: the landing and content lists, with search, kind and status filters. */
export const listContentPages = defineRoute({
  key: 'GET /admin/content-pages',
  summary: 'List content pages',
  description:
    'Landing pages (`kind` carrier, model, tool, brand, country) and content pages (`static`, `blog`) in one table. `kind` may ' +
    'repeat (`kind=static&kind=blog`). `q` is a contains over the title and the slug. Default order: last change first. The ' +
    'stats above the tables ask with `_start=0&_end=1`. Rows carry the full Markdown body.',
  tags: ['content-pages'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: listQuery({
    sorts: ['updatedAt', 'title', 'status', 'createdAt', 'publishedAt', 'slug', 'id'],
    defaultSort: { field: 'updatedAt', order: 'desc' },
    filters: {
      kind: { type: 'enum', values: CONTENT_PAGE_KINDS },
      status: { type: 'enum', values: CONTENT_PAGE_STATUSES },
      locale: { type: 'enum', values: STOREFRONT_LOCALES },
    },
    search: ['title', 'slug'],
  }),
  success: { status: 200, schema: ContentPageRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [PAGE_EXAMPLE] },
});

/** `GET /admin/content-pages/:id`: one page. */
export const showContentPage = defineRoute({
  key: 'GET /admin/content-pages/:id',
  summary: 'Show a content page',
  tags: ['content-pages'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: ContentPageRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: PAGE_EXAMPLE },
});

/** `POST /admin/content-pages`: a new draft page. */
export const createContentPage = defineRoute({
  key: 'POST /admin/content-pages',
  summary: 'Create a content page',
  description:
    'Always a draft (`publishedAt` null) written by the signed-in staff member. Without `slug` the server makes one from the ' +
    'title; a typed slug must be lower-case words joined by hyphens, and `terms`, `privacy`, `refund` and `cookies` belong to ' +
    'the legal documents. A slug already used in that language is `409 SLUG_TAKEN` on `slug` (also when two requests race). ' +
    '`bodyMd` keeps its whitespace; HTML inside is stored as sent and rendered only by the storefront.',
  tags: ['content-pages'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  body: z.object({
    kind: z.enum(CONTENT_PAGE_KINDS),
    title: titleField('Enter a title.'),
    locale: LocaleField,
    slug: SlugField.optional(),
    bodyMd: markdown(BODY_MAX),
    seoTitle: SeoTitleField.optional(),
    seoDescription: SeoDescriptionField.optional(),
  }),
  success: { status: 201, schema: ContentPageRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'SLUG_TAKEN'],
  examples: {
    request: { kind: 'static', title: 'About us', locale: 'en', bodyMd: '# About us' },
    response: {
      ...PAGE_EXAMPLE,
      kind: 'static',
      slug: 'about-us',
      title: 'About us',
      status: 'draft',
      publishedAt: null,
    },
  },
});

/** `PATCH /admin/content-pages/:id`: change the text, slug, language or SEO of a page. */
export const updateContentPage = defineRoute({
  key: 'PATCH /admin/content-pages/:id',
  summary: 'Change a content page',
  description:
    'Only the keys sent change; never `kind` or `status` (the publish route changes the status). An empty title or slug is ' +
    '`422`; an empty SEO field clears it. The slug stays unique per language, judged against the new language when both change ' +
    '(`409 SLUG_TAKEN`). A page that is live stays live: its new text is public at once.',
  tags: ['content-pages'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      title: titleField('Enter a title.').optional(),
      slug: SlugField.min(1, 'Enter a slug.').optional(),
      locale: LocaleField.optional(),
      bodyMd: markdown(BODY_MAX).optional(),
      seoTitle: SeoTitleField.optional(),
      seoDescription: SeoDescriptionField.optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: ContentPageRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'SLUG_TAKEN'],
  examples: { request: { seoDescription: 'How the unlock works.' }, response: PAGE_EXAMPLE },
});

/** `POST /admin/content-pages/:id/publish`: publish a page or hide it. */
export const publishContentPage = defineRoute({
  key: 'POST /admin/content-pages/:id/publish',
  summary: 'Publish or hide a content page',
  description:
    '`published: true` makes the page live (`status` published; `publishedAt` is the moment of this publish, also for a page ' +
    'that is already live); `false` hides it (`status` draft, `publishedAt` kept). Works from any status, `noindex` ' +
    'included. Audited as `published page` or `unpublished page`.',
  tags: ['content-pages'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:publish',
  params: z.object({ id: zIdParam }),
  body: z.object({ published: z.boolean() }),
  success: { status: 200, schema: ContentPageRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { published: true }, response: PAGE_EXAMPLE },
});
