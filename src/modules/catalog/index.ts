// Public API of the catalog module: the module and the read-only directory of merchant groups. Services other modules may
// call are exported here.
export { CatalogModule } from './catalog.module';
export { ClientGroupDirectory, RETAIL_GROUP_KIND } from './application/client-group-directory';
export type { ClientGroupRef } from './application/client-group-directory';
