// Holds the OpenAPI documents and the Scalar pages the platform module serves (GET /openapi.json, /docs, /reference).
// They are built once at start-up from the contracts of every registered controller (decision 017).
import { Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { type BuildOptions, type OpenApiDocuments, buildOpenApiDocuments, serializeOpenApiDocument } from './openapi-documents';
import { type DocsPage, renderDocsPage } from './scalar-page';

/**
 * Everything the documentation routes send, built once.
 *
 * Why: a request must only copy a string, so everything is built once at start-up (decision 017).
 */
export interface PublishedDocs extends OpenApiDocuments {
  /** The public document as the exact JSON text served at `/openapi.json`. */
  readonly publicJson: string;
  /** The internal document as the exact JSON text served at `/reference/openapi.json`. */
  readonly internalJson: string;
  /** The Scalar page of the public document (`/docs`). */
  readonly publicPage: DocsPage;
  /** The Scalar page of the internal document (`/reference`). */
  readonly internalPage: DocsPage;
}

/**
 * Builds and holds the documents behind the documentation routes.
 *
 * Why: decision 017 serves the same generated documents that are committed under `docs/contract/`; building them once
 * at start-up means a broken contract fails the boot, and every request is a string copy.
 */
@Injectable()
export class OpenApiService {
  private published: PublishedDocs | undefined;

  /**
   * Builds the documents and pages from the application's controllers.
   *
   * Why: called by `configureApp` (the shared bootstrap of `main.ts` and the tests), after every controller is
   * registered and before the app listens. It needs the application, which Nest does not inject.
   *
   * @param app the Nest application, created but not necessarily initialised
   * @param options the events to publish (defaults to the process-wide registry)
   * @returns the published documents
   * @throws {Error} when a contract's documentation is inconsistent (for example an undefined security scheme)
   */
  publish(app: INestApplication, options?: BuildOptions): PublishedDocs {
    const documents = buildOpenApiDocuments(app, options);
    this.published = {
      ...documents,
      publicJson: serializeOpenApiDocument(documents.public),
      internalJson: serializeOpenApiDocument(documents.internal),
      publicPage: renderDocsPage(documents.public, documents.public.info.title),
      internalPage: renderDocsPage(documents.internal, documents.internal.info.title),
    };
    return this.published;
  }

  /**
   * Returns the published documents.
   *
   * @returns the documents built by {@link publish}
   * @throws {Error} when `publish` has not run (the application was started without `configureApp`)
   */
  documents(): PublishedDocs {
    if (!this.published) throw new Error('The OpenAPI documents are not published: call configureApp(app, config)');
    return this.published;
  }
}
