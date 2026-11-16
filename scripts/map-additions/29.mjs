// Feature 29 (public storefront search on Typesense, decision 038, plan docs/briefs/29-search-typesense.md section 5): the routes beyond
// the map (decision 035): the two public search routes and the console's search tools. The spec ids are
// (B221 public, B222 admin; B223 is the `q` path of GET /store/v1/services). English only: the engine holds English listings.
import { R } from '../lib/map-additions.mjs';

const PUBLIC = 'B221';
const ADMIN = 'B222';
const SETTINGS = ['search_synonyms', 'search_pins', 'search_hidden_terms', 'audit_logs'];

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
    '/admin/search/synonyms',
    'قائمة مرادفات البحث',
    'storefront:read',
    ['search_synonyms'],
    'List the search synonyms.',
    200,
  ),
  admin(
    'POST',
    '/admin/search/synonyms',
    'إضافة مرادف بحث',
    'storefront:update',
    SETTINGS,
    'Create a search synonym.',
    201,
  ),
  admin(
    'PATCH',
    '/admin/search/synonyms/:id',
    'تعديل مرادف بحث',
    'storefront:update',
    SETTINGS,
    'Change a search synonym.',
    200,
  ),
  admin(
    'DELETE',
    '/admin/search/synonyms/:id',
    'حذف مرادف بحث',
    'storefront:update',
    SETTINGS,
    'Delete a search synonym.',
    204,
  ),

  admin(
    'GET',
    '/admin/search/pins',
    'قائمة النتائج المثبّتة في البحث',
    'storefront:read',
    ['search_pins', 'service_listings'],
    'List the pinned search results.',
    200,
  ),
  admin(
    'POST',
    '/admin/search/pins',
    'تثبيت نتائج لعبارة بحث',
    'storefront:update',
    [...SETTINGS, 'service_listings'],
    'Create a pinned search result.',
    201,
  ),
  admin(
    'PATCH',
    '/admin/search/pins/:id',
    'تعديل نتيجة مثبّتة',
    'storefront:update',
    [...SETTINGS, 'service_listings'],
    'Change a pinned search result.',
    200,
  ),
  admin(
    'DELETE',
    '/admin/search/pins/:id',
    'حذف نتيجة مثبّتة',
    'storefront:update',
    SETTINGS,
    'Delete a pinned search result.',
    204,
  ),

  admin(
    'GET',
    '/admin/search/hidden-terms',
    'قائمة العبارات المخفية من البحث الرائج',
    'storefront:read',
    ['search_hidden_terms'],
    'List the hidden popular searches.',
    200,
  ),
  admin(
    'POST',
    '/admin/search/hidden-terms',
    'إخفاء عبارة من البحث الرائج',
    'storefront:update',
    SETTINGS,
    'Hide a term from the popular searches.',
    201,
  ),
  admin(
    'DELETE',
    '/admin/search/hidden-terms/:id',
    'إظهار عبارة مخفية من جديد',
    'storefront:update',
    SETTINGS,
    'Show a hidden term again.',
    204,
  ),

  admin(
    'GET',
    '/admin/search/report',
    'تقرير البحث: الأكثر بحثاً وما لم يُعثر عليه',
    'storefront:read',
    ['search_terms_daily'],
    'The search report: top terms and terms with no results.',
    200,
  ),
  admin(
    'GET',
    '/admin/search/preview',
    'معاينة نتائج البحث مع القواعد المطبّقة',
    'storefront:read',
    ['search_pins', 'service_listings'],
    'Preview a search with the pin rules applied.',
    200,
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
