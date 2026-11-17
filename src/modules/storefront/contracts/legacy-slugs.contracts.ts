// Route contract of the old storefront addresses (feature 30, English only, decision 039, plan section 4.5): where an address of a
// service, page or help article that only existed in another language leads now. A route beyond the map (scripts/map-additions/30.mjs,
// spec B224); public, on the `/store/v1` surface, so the per-IP `ip` limit applies (decision 021).
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';
import { LEGACY_SLUG_KINDS } from '../db/schema';

/** Where an old address leads: a path of the site without a language prefix, and the service page's slug when there is one. */
const LegacyAddress = z.object({
  path: z
    .string()
    .describe(
      'The path of the site to send the reader on to, without a language prefix (like notification links): `/services/<slug>`, ' +
        '`/services`, `/` or `/help`.',
    ),
  slug: z
    .string()
    .nullable()
    .describe(
      "The slug of the service's page on sale now (the same rule as `GET /store/v1/services/:slug`); `null` when the address is " +
        'not a service page that is on sale.',
    ),
});

/** `GET /store/v1/legacy-slugs/:kind/:slug`: where an old address in another language leads now. */
export const getLegacySlug = defineRoute({
  key: 'GET /store/v1/legacy-slugs/:kind/:slug',
  summary: 'Resolve an old address',
  description:
    'English only (decision 039): the addresses of service pages, pages and help articles that existed only in another language ' +
    'were remembered when that content was removed. The website asks here after its own lookup of a slug found nothing. `service`: ' +
    'when the service has a page on sale now (switched on, sellable and priced: the rule of `GET /store/v1/services/:slug`), ' +
    '`{ path: "/services/<slug>", slug }`; otherwise `{ path: "/services", slug: null }`. `page`: `{ path: "/", slug: null }` (the ' +
    'old page has no English twin). `help`: `{ path: "/help", slug: null }`; only the id that starts the slug counts, as on ' +
    '`GET /store/v1/help/:slug`. An address that was never retired is `404`; an unknown `kind` and any query parameter are `422`. ' +
    'Public.',
  tags: ['storefront-public'],
  surface: 'store',
  access: 'public',
  params: z.object({
    kind: z.enum(LEGACY_SLUG_KINDS),
    slug: z.string().min(1).max(200),
  }),
  query: z.object({}).strict(),
  success: { status: 200, schema: LegacyAddress },
  errors: ['VALIDATION_FAILED', 'NOT_FOUND'],
  examples: { response: { path: '/services/icloud-clean-lost-check', slug: 'icloud-clean-lost-check' } },
});
