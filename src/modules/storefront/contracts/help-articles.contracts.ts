// Route contracts of the help articles (map domain H, stage 15): the console's Help centre tab. Shapes match the console's
// HelpArticle (docs/contract/endpoints/storefront.md, ANSWERS storefront Q2 and Q6, MISMATCHES B58).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { ANSWER_MAX, LocaleField, STOREFRONT_LOCALES, requiredMarkdown, titleField } from './shared';

/** An article as the console reads it. */
const ArticleRow = z.object({
  id: zId,
  category: z.string().describe('A free-text topic chosen by staff.'),
  question: z.string(),
  answerMd: z.string().describe('The full Markdown answer.'),
  locale: z.string(),
  isPublished: z.boolean(),
  helpfulYes: z.number().int().min(0).describe('Reader votes: helpful.'),
  helpfulNo: z.number().int().min(0).describe('Reader votes: not helpful.'),
  sort: z.number().int(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});

const ARTICLE_EXAMPLE = {
  id: 10,
  category: 'IMEI',
  question: 'How do I find my IMEI?',
  answerMd: 'Dial *#06# on the phone.',
  locale: 'en',
  isPublished: true,
  helpfulYes: 301,
  helpfulNo: 12,
  sort: 10,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
} as const;

/** The topic: trimmed, 1 to 80 characters. */
const Category = titleField('Enter a topic.').max(80, 'Use at most 80 characters.');

/** `GET /admin/help-articles`: the articles, with search and the publish filter. */
export const listHelpArticles = defineRoute({
  key: 'GET /admin/help-articles',
  summary: 'List help articles',
  description:
    'Filters: `isPublished`, `category` and `locale`. `q` is a contains over the question and the topic. Default order: `sort`. ' +
    'The stats above the table ask with `_start=0&_end=1`. Rows carry the full answer.',
  tags: ['help-articles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: listQuery({
    sorts: ['sort', 'question', 'category', 'isPublished', 'createdAt', 'id'],
    defaultSort: { field: 'sort', order: 'asc' },
    filters: {
      isPublished: { type: 'boolean' },
      category: { type: 'string' },
      locale: { type: 'enum', values: STOREFRONT_LOCALES },
    },
    search: ['question', 'category'],
  }),
  success: { status: 200, schema: ArticleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ARTICLE_EXAMPLE] },
});

/** `GET /admin/help-articles/:id`: one article. */
export const showHelpArticle = defineRoute({
  key: 'GET /admin/help-articles/:id',
  summary: 'Show a help article',
  tags: ['help-articles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: ArticleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: ARTICLE_EXAMPLE },
});

/** `POST /admin/help-articles`: a new article, last in the order. */
export const createHelpArticle = defineRoute({
  key: 'POST /admin/help-articles',
  summary: 'Create a help article',
  description:
    'The article goes last (`sort` is the largest plus one) with no votes; `isPublished` defaults to false. `answerMd` keeps ' +
    'its whitespace and may not be blank.',
  tags: ['help-articles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  body: z.object({
    category: Category,
    question: titleField('Enter the question.'),
    answerMd: requiredMarkdown(ANSWER_MAX, 'Enter the answer.'),
    locale: LocaleField,
    isPublished: z.boolean().optional(),
  }),
  success: { status: 201, schema: ArticleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { category: 'IMEI', question: 'How do I find my IMEI?', answerMd: 'Dial *#06#.', locale: 'en' },
    response: { ...ARTICLE_EXAMPLE, isPublished: false, helpfulYes: 0, helpfulNo: 0 },
  },
});

/** `PATCH /admin/help-articles/:id`: edit an article or switch it on or off. */
export const updateHelpArticle = defineRoute({
  key: 'PATCH /admin/help-articles/:id',
  summary: 'Change a help article',
  description:
    'Only the keys sent change. The publish switch sends only `isPublished` and needs `storefront:update` (B58: there is no ' +
    'publish route for articles). An empty topic, question or answer is `422`. Audited as `published help article`, ' +
    '`unpublished help article` and `edited help article`.',
  tags: ['help-articles'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      category: Category.optional(),
      question: titleField('Enter the question.').optional(),
      answerMd: requiredMarkdown(ANSWER_MAX, 'Enter the answer.').optional(),
      locale: LocaleField.optional(),
      isPublished: z.boolean().optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: ArticleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { isPublished: true }, response: ARTICLE_EXAMPLE },
});
