// Minimal types for the OpenAPI 3.1 documents the platform module builds (decision 017). They describe only what the
// builder reads or writes; everything else stays free-form JSON.

/**
 * A free-form JSON object (a schema, an example, a response).
 *
 * Why: schemas, examples and responses are free-form JSON; typing them fully would only duplicate the OpenAPI
 * specification.
 */
export type PlainObject = Record<string, unknown>;

/**
 * One OpenAPI operation as the builder sees it.
 *
 * Why: the builder filters and groups operations by the `x-gsm-*` extensions that `@Route` writes (decision 008).
 */
export interface OpenApiOperation extends PlainObject {
  tags?: string[];
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  /** Surface of the route (`admin`, `client`, `v1`, `store`, `dhru`, `hooks`, `system`; `events` for webhooks). */
  'x-gsm-surface'?: string;
}

/**
 * A path item: operations under their lower-case method names, plus any shared members.
 *
 * Why: the builder only reads the operations in it; staying free-form lets it pass through whatever @nestjs/swagger
 * wrote.
 */
export type OpenApiPathItem = PlainObject;

/**
 * A tag entry of the document.
 *
 * Why: Scalar builds its sidebar from the tags of the document.
 */
export interface OpenApiTag {
  name: string;
  description?: string;
}

/**
 * A sidebar group of tags (`x-tagGroups`, understood by Scalar and Redoc).
 *
 * Why: the sidebar groups tags by surface, so a reader finds the public, merchant and staff operations apart (decision
 * 017).
 */
export interface OpenApiTagGroup {
  name: string;
  tags: string[];
}

/**
 * An OpenAPI 3.1 document as plain JSON.
 *
 * Why: the documents are committed (decision 009) and served by Scalar (decision 017), so they are handled as data.
 */
export interface OpenApiDocument extends PlainObject {
  openapi: string;
  info: { title: string; version: string; description?: string } & PlainObject;
  tags?: OpenApiTag[];
  'x-tagGroups'?: OpenApiTagGroup[];
  paths: Record<string, OpenApiPathItem>;
  webhooks?: Record<string, OpenApiPathItem>;
  components?: Record<string, Record<string, unknown>>;
}
