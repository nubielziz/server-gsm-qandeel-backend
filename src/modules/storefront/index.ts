// Public API of the storefront module: the price quotes a checkout locks, the legal documents in force, the policy switches, the
// shared request schemas, the legal type words and names, then the modules. Other modules import only this file.
// Order matters (decision 032): the leaves other modules use come first.
export { StorefrontQuotes } from './application/storefront-quotes';
export type { PricedService, QuoteAmounts, QuoteContext, QuoteInput } from './application/storefront-quotes';
export { inCurrency } from './domain/retail-quote';
export type { Amounts } from './domain/retail-quote';
export { FALLBACK_LOCALE, CurrentLegalDocuments } from './application/legal-documents';
export type { LegalDocumentRef } from './application/legal-documents';
export { DEFAULT_POLICY_SWITCHES, StorefrontPolicies } from './application/storefront-policies';
export type { StorefrontPolicySwitches } from './application/storefront-policies';
export { STOREFRONT_LOCALES, zCountryCode, zCurrencyCode, zLocale } from './contracts/storefront-public.contracts';
export { LEGAL_DOCUMENT_TYPES } from './db/schema';
export type { LegalDocumentType } from './db/schema';
export { LEGAL_TYPE_LABEL } from './domain/legal';
export { StorefrontPublicModule } from './storefront-public.module';
export { StorefrontAdminModule } from './storefront-admin.module';
export { StorefrontModule } from './storefront.module';
export { StorefrontContentModule } from './storefront-content.module';
// The popularity job (worker only). It reads the order counts through this module's foreign-read file, never the orders barrel.
export { PopularityRefresh, POPULARITY_WINDOW_DAYS } from './jobs/popularity';
export type { PopularityResult } from './jobs/popularity';
export { STOREFRONT_POPULARITY_JOB } from './jobs/popularity.processor';
export { STOREFRONT_POPULARITY_SCHEDULER, StorefrontPopularityModule } from './jobs/popularity.module';
