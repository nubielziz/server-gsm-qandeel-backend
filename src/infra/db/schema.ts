// The whole Drizzle schema in one place (decision 027): drizzle-kit reads this file, and the runtime types the
// database client with it. Each module owns its tables in src/modules/<id>/db/schema.ts; this barrel only re-exports.
export * from '../../modules/identity/db/schema';
export * from '../../modules/platform/db/schema';
export * from '../../modules/money/db/schema';
export * from '../../modules/catalog/db/schema';
export * from '../../modules/orders/db/schema';
export * from '../../modules/suppliers/db/schema';
export * from '../../modules/health/db/schema';
export * from '../../modules/commissions/db/schema';
export * from '../../modules/customers/db/schema';
export * from '../../modules/storefront/db/schema';
export * from '../../modules/support/db/schema';
export * from '../../modules/risk/db/schema';
