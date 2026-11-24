// Feature 29 (public storefront search on Typesense, decision 038, plan docs/briefs/29-search-typesense.md section 5): the routes beyond
// the map (decision 035): the two public search routes and the console's index tools. The spec ids are
// (B221 public, B222 admin; B223 is the `q` path of GET /store/v1/services). English only: the engine holds English listings.
// Decision 068 retired the console's synonym, pin, hidden-term, report and preview routes: their rows are deleted here (an addition is
// deleted, not listed in test/contract/retired.ts; decision 062).
import { R } from '../lib/map-additions.mjs';

const PUBLIC = 'B221';
const ADMIN = 'B222';

/** One admin row: the Arabic sentence, the permission, the tables and the English sentence. */
const admin = (method, path, sentence, permission, tables, en, successStatus) =>
  R('admin', 'storefront', method, path, sentence, permission, 29, tables, {
    en,
    module: 'storefront',
    spec: ADMIN,
    successStatus,
  });

export const rows = [
  R(
    'store',
    'catalog',
    'GET',
    '/store/v1/search/suggest',
    'اقتراحات البحث أثناء الكتابة: إكمال الكلمات والخدمات الأقرب',
    'عام',
    29,
    ['service_listings', 'services', 'service_categories', 'currencies', 'search_terms_daily'],
    {
      en: 'Search as you type: word completions, nearby services and filter chips (English).',
      module: 'storefront',
      spec: PUBLIC,
      successStatus: 200,
    },
  ),
  R(
    'store',
    'catalog',
    'GET',
    '/store/v1/search',
    'صفحة نتائج البحث بالإنجليزية مع عدّ الفلاتر ونطاق السعر',
    'عام',
    29,
    ['service_listings', 'services', 'service_categories', 'currencies', 'search_terms_daily'],
    {
      en: 'The search results page with facet counts and the price span (English).',
      module: 'storefront',
      spec: PUBLIC,
      successStatus: 200,
    },
  ),

  admin(
    'GET',
    '/admin/search/index',
    'حالة فهرس البحث',
    'storefront:read',
    ['search_index_state', 'service_listings'],
    'The search index status.',
    200,
  ),
  admin(
    'POST',
    '/admin/search/index/rebuild',
    'إعادة بناء فهرس البحث',
    'storefront:publish',
    ['search_index_state', 'audit_logs'],
    'Rebuild the search index.',
    202,
  ),
];
