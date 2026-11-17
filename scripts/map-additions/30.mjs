// Feature 30 (English only, decision 039, plan docs/briefs/30-english-only.md section 4.5): the route beyond the map (decision 035).
// An old address of a service, page or help article that existed only in another language is remembered in `legacy_slugs`; the
// website asks where it leads now. Spec B224. Written in English only (decision 039): no Arabic sentence, the access name as auth text.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R(
    'store',
    'content',
    'GET',
    '/store/v1/legacy-slugs/:kind/:slug',
    undefined,
    'public',
    30,
    ['legacy_slugs', 'service_listings'],
    {
      en: 'Where an old address in another language leads now: the page of the same service, the service list, the home page or the help centre.',
      module: 'storefront',
      spec: 'B224',
      successStatus: 200,
    },
  ),
];
