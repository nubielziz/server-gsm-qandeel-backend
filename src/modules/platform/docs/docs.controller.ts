// HTTP controllers of the documentation routes (decision 017): the public pair (map routes) and the internal pair.
import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Route } from '../../../common/contract';
import { docsPageContract, openApiJsonContract } from './docs.contracts';
import { OpenApiService } from './openapi.service';
import type { DocsPage } from './scalar-page';
import { ReferenceAccessGuard } from './reference-access.guard';

/**
 * The documentation routes that are not map routes: they have no contract, so the route-parity test (decision 009)
 * allows exactly these in addition to the registry.
 *
 * Why: `/reference` is the staff-only internal reference of decision 017; the map lists only the public pair.
 */
export const DOCUMENTATION_ROUTES = ['GET /reference', 'GET /reference/openapi.json'] as const;

/** Sends a Scalar page with its own policy: the one place where the API relaxes `default-src 'none'`. */
function sendPage(reply: FastifyReply, page: DocsPage): string {
  void reply.header('content-security-policy', page.contentSecurityPolicy).type('text/html; charset=utf-8');
  return page.html;
}

/**
 * Serves the public OpenAPI document and its Scalar page.
 *
 * Why: merchants import the document and read the page without signing in (decision 017). Both are generated at
 * start-up, so a request only copies a string.
 *
 * @route GET /openapi.json
 * @route GET /docs
 */
@Controller()
export class DocsController {
  constructor(private readonly docs: OpenApiService) {}

  /**
   * Returns the public OpenAPI document.
   *
   * @returns the JSON text of the document
   */
  @Route(openApiJsonContract)
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  publicDocument(): string {
    return this.docs.documents().publicJson;
  }

  /**
   * Returns the Scalar page of the public document.
   *
   * @param reply the reply, to set the page's Content-Security-Policy
   * @returns the HTML of the page
   */
  @Route(docsPageContract)
  @Header('Cache-Control', 'public, max-age=300')
  publicPage(@Res({ passthrough: true }) reply: FastifyReply): string {
    return sendPage(reply, this.docs.documents().publicPage);
  }
}

/**
 * Serves the internal OpenAPI document and its Scalar page, behind `REFERENCE_DOCS`.
 *
 * Why: staff and developers need every route, permission and error in one place (decision 017). The guard decides per
 * mode; responses are never cached by shared caches because they describe the whole API. The routes are not part of
 * the documents they serve (they have no contract), hence `ApiExcludeController`.
 *
 * @route GET /reference
 * @route GET /reference/openapi.json
 */
@Controller()
@ApiExcludeController()
@UseGuards(ReferenceAccessGuard)
export class ReferenceController {
  constructor(private readonly docs: OpenApiService) {}

  /**
   * Returns the internal OpenAPI document.
   *
   * @returns the JSON text of the document
   */
  @Get('reference/openapi.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'private, no-store')
  internalDocument(): string {
    return this.docs.documents().internalJson;
  }

  /**
   * Returns the Scalar page of the internal document.
   *
   * @param reply the reply, to set the page's Content-Security-Policy
   * @returns the HTML of the page
   */
  @Get('reference')
  @Header('Cache-Control', 'private, no-store')
  internalPage(@Res({ passthrough: true }) reply: FastifyReply): string {
    return sendPage(reply, this.docs.documents().internalPage);
  }
}
