// Route contract of the landing-page generator (map stage 19, domain H): brand x model x network drafts for review. Shapes match the
// console's `GeneratePagesBody` and `GeneratePagesResult` (frontend src/features/storefront/types/content.ts).
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';
import { STOREFRONT_GENERATE_MAX_PER_RUN } from '../domain/page-generator';
import { ContentPageRow } from './content-pages.contracts';

/** One list of the request: names as typed; the server trims, splits on commas and new lines, and drops blanks and repeats. */
const NameList = (what: string, emptyMeans: string) =>
  z
    .array(z.string().max(60, 'Use at most 60 characters in each name.'))
    .max(100, 'Send at most 100 names.')
    .describe(`${what} Empty means ${emptyMeans}.`);

/** `POST /admin/content-pages/generate`: draft landing pages for brand x model x network. */
export const generateContentPages = defineRoute({
  key: 'POST /admin/content-pages/generate',
  summary: 'Generate landing page drafts',
  description:
    'Makes a draft for each model x network: title `Unlock <model> on <network>`, slug from the title, language `en`, kind `model`, ' +
    'status `draft`, `template_params` `{brand, model, network}` and a short body. Nothing is published. Empty lists mean everything the ' +
    'site knows: every brand of the TAC catalogue, every model (marketing name, else model) of those brands, every carrier of the service ' +
    'listings. A model that is not in the catalogue is generated when typed. Combinations that repeat an earlier one of the same run ' +
    '(the same slug) are merged; the distinct combinations whose slug already exists in `en`, or that a parallel run made first, are ' +
    'skipped and counted in `skipped`. A catalogue model with no Latin letter or digit cannot make a slug: it is left out and counted in ' +
    '`unusableModels` (present only when above 0), never a `422`; so is a listing carrier with no Latin letter or digit on a run with no ' +
    'networks typed, counted in `unusableNetworks` (present only when above 0). ' +
    `A run that would create more than ${STOREFRONT_GENERATE_MAX_PER_RUN} new drafts creates none: \`422\` with no field and the detail ` +
    '`This run would create N pages; the limit is 50 per run. Narrow the lists.`. A run over 20 000 combinations (a safety bound) is ' +
    'refused the same way, with N the number of combinations; so is a run with no models typed whose catalogue has more than 20 000 ' +
    'models (N is then 20001, where the read stops), whatever the networks. A typed model or network with no Latin letter or digit is `422` on ' +
    '`models` or `networks`. Needs `storefront:create` (B57). Audited as `generated landing pages`.',
  tags: ['content-pages'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  body: z.object({
    brands: NameList('The brands (TAC catalogue names, any case).', 'every brand of the TAC catalogue'),
    models: NameList(
      'The models; one that the catalogue does not know is generated as typed.',
      'every model of those brands',
    ),
    networks: NameList('The carriers, such as AT&T or Vodafone.', 'every carrier of the service listings'),
  }),
  success: {
    status: 200,
    schema: z.object({
      created: z.array(ContentPageRow).describe('The new drafts, by id.'),
      skipped: z.number().int().min(0).describe('Distinct combinations that already had a page.'),
      unusableModels: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Present only when it is above 0: the catalogue models left out because their name has no Latin letter or digit, so it cannot make a slug.',
        ),
      unusableNetworks: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Present only when it is above 0: the carriers of the listings left out because their name has no Latin letter or digit (a run with no networks typed).',
        ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { brands: ['Apple'], models: ['iPhone 13'], networks: ['AT&T', 'Vodafone'] },
    response: {
      created: [
        {
          id: 21,
          kind: 'model',
          slug: 'unlock-iphone-13-on-atandt',
          locale: 'en',
          title: 'Unlock iPhone 13 on AT&T',
          bodyMd: '# Unlock iPhone 13 on AT&T\n\nDraft for review.',
          seoTitle: '',
          seoDescription: '',
          status: 'draft',
          publishedAt: null,
          canonicalUrl: null,
          createdAt: '2026-11-07T12:00:00.000Z',
          updatedAt: '2026-11-07T12:00:00.000Z',
          visits30d: null,
          orders30d: null,
        },
      ],
      skipped: 1,
    },
  },
});
