// Renders the Scalar API reference page of an OpenAPI document (decision 017) and the Content-Security-Policy that
// page needs. Used by GET /docs (public document) and GET /reference (internal document).
import { createHash } from 'node:crypto';
import { apiReference } from '@scalar/nestjs-api-reference';
import type { OpenApiDocument } from './openapi-types';

/**
 * The Scalar release the pages load from the CDN.
 *
 * Why: an unpinned CDN URL would run whatever Scalar published last on staff browsers (decision 017 pins it). To bump:
 * change this, recompute {@link SCALAR_BUNDLE_INTEGRITY}, and open `/docs` and `/reference` in a browser.
 */
export const SCALAR_VERSION = '1.76.4';
/**
 * Base URL of the pinned release.
 *
 * Why: the Content-Security-Policy allows scripts from exactly this path of the CDN and from nowhere else.
 */
export const SCALAR_CDN_BASE = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/`;
/**
 * The single-file browser bundle of {@link SCALAR_VERSION}.
 *
 * Why: one file, pinned to an exact version, so a Scalar release cannot change what runs in staff browsers (decision
 * 017).
 */
export const SCALAR_BUNDLE_URL = `${SCALAR_CDN_BASE}dist/browser/standalone.js`;
/**
 * Subresource Integrity hash of {@link SCALAR_BUNDLE_URL}.
 *
 * Why: with the hash on the script tag a changed or tampered CDN file does not run (the reference page runs next to a
 * staff session). Recompute: `curl -s <SCALAR_BUNDLE_URL> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
export const SCALAR_BUNDLE_INTEGRITY = 'sha384-hwB9WroDTpZaI38gr+u9CXA6ksz5gUYgD2GxXazKl/agT1L2GWUiRFWGJYNiFu4Q';
/**
 * Where Scalar's default web fonts live.
 *
 * Why: it is the only host besides the pinned script path that the policy opens (for fonts only); keeping Scalar's own
 * fonts avoids maintaining a custom theme.
 */
export const SCALAR_FONT_HOST = 'https://fonts.scalar.com';

/**
 * Scalar options of both pages: no telemetry, no MCP promotion, no "Ask AI" agent (it calls Scalar's cloud, which the
 * Content-Security-Policy refuses anyway) and no developer tools.
 *
 * Why: the pages must not phone home. `agent` is read by the 1.76 bundle but is not in the typings of the NestJS
 * integration yet, hence a separate object (spread into the call, so it is not checked as a fresh literal).
 */
const SCALAR_OPTIONS = {
  telemetry: false,
  mcp: { disabled: true },
  agent: { disabled: true },
  showDeveloperTools: 'never',
} as const;

/**
 * A rendered documentation page and the policy that lets it run.
 *
 * Why: the page and its policy travel together, because the policy allows this page's inline script by hash.
 */
export interface DocsPage {
  readonly html: string;
  /** Value of the `Content-Security-Policy` header for this page only; every other route keeps `default-src 'none'`. */
  readonly contentSecurityPolicy: string;
}

/** The part of a Node response that Scalar's Fastify handler writes to. */
interface HtmlSink {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
}

/**
 * Builds the Content-Security-Policy of a documentation page.
 *
 * Why: the API sends `default-src 'none'` everywhere (JSON only). The Scalar page needs its pinned CDN script, the
 * inline starter script (allowed by its hash, not by `'unsafe-inline'`), inline styles that the bundle injects, Scalar's
 * fonts, data-URI icons and requests to this same origin ("Try it"). Nothing else. There is no `'unsafe-eval'`: the
 * bundle probes `Function('')` once (zod's JIT check) and falls back when refused, so a browser logs one harmless
 * violation per page load.
 *
 * @param scriptHashes base64 SHA-256 digests of the inline scripts in the page
 * @returns the header value
 */
export function docsContentSecurityPolicy(scriptHashes: readonly string[]): string {
  const hashSources = scriptHashes.map((hash) => `'sha256-${hash}'`);
  return [
    "default-src 'none'",
    `script-src ${[...hashSources, SCALAR_CDN_BASE].join(' ')}`,
    "style-src 'unsafe-inline'",
    `font-src ${SCALAR_FONT_HOST}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Finds the digests of the inline scripts of a page.
 *
 * Why: the Content-Security-Policy allows the inline starter script by hash instead of `'unsafe-inline'`.
 *
 * @param html the page
 * @returns one base64 SHA-256 digest per `<script>` without `src`
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.push(createHash('sha256').update(match[1] ?? '', 'utf8').digest('base64'));
  }
  return hashes;
}

/**
 * Renders the Scalar page of a document.
 *
 * Why: `apiReference({ content, withFastify: true })` is Scalar's supported entry point for Fastify. It writes the page
 * to a raw response, so the HTML is captured and served by a Nest controller instead: guards, headers and the
 * Content-Security-Policy stay under our control. The document is embedded in the page, so the page needs no second
 * request.
 *
 * @param document the OpenAPI document to show
 * @param pageTitle the browser title
 * @returns the page and its Content-Security-Policy
 * @throws {Error} when Scalar's page no longer has the script tag this code adds the integrity hash to
 */
export function renderDocsPage(document: OpenApiDocument, pageTitle: string): DocsPage {
  const handler = apiReference({
    content: document,
    withFastify: true,
    cdn: SCALAR_BUNDLE_URL,
    pageTitle,
    ...SCALAR_OPTIONS,
  }) as (request: unknown, response: HtmlSink) => void;
  const chunks: string[] = [];
  handler(undefined, { writeHead: () => undefined, write: (chunk) => chunks.push(chunk), end: () => undefined });

  const tag = `<script src="${SCALAR_BUNDLE_URL}">`;
  const page = chunks.join('');
  if (!page.includes(tag)) throw new Error('Scalar changed its page: the CDN script tag was not found');
  // A replacer function: a string replacement would give `$` sequences a meaning.
  const secured = `<script src="${SCALAR_BUNDLE_URL}" integrity="${SCALAR_BUNDLE_INTEGRITY}" crossorigin="anonymous">`;
  const html = page.replace(tag, () => secured);
  return { html, contentSecurityPolicy: docsContentSecurityPolicy(inlineScriptHashes(html)) };
}
