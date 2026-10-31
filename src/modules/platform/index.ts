// Public API of the platform module: the module itself and what the bootstrap, the generator script and the
// contract tests need from its documentation routes.
export { PlatformModule } from './platform.module';
export { DOCUMENTATION_ROUTES } from './docs/docs.controller';
export {
  API_VERSION,
  buildInternalDocument,
  buildOpenApiDocuments,
  buildPublicDocument,
  buildWebhooks,
  serializeOpenApiDocument,
  stripSchemaKeyword,
} from './docs/openapi-documents';
export type { BuildOptions, OpenApiDocuments } from './docs/openapi-documents';
export type { OpenApiDocument } from './docs/openapi-types';
export { OpenApiService } from './docs/openapi.service';
export type { PublishedDocs } from './docs/openapi.service';
export { REFERENCE_DOCS_GUARD } from './docs/reference-access.guard';
export { SCALAR_BUNDLE_URL, SCALAR_VERSION } from './docs/scalar-page';
