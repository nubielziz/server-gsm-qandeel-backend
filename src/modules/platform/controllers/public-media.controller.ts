// HTTP controller of the public service pictures (feature 22): serves the bytes PublicImages stored, with long-lived cache headers.
import { Controller, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type ParamsOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { showStoreMedia } from '../contracts/public-media.contracts';
import { PublicImages } from '../files/public-images';

/** One year in seconds: the picture behind a name never changes. */
const IMMUTABLE_MAX_AGE = 31_536_000;

/**
 * The public media route.
 *
 * Why: feature 22 (§2.6 of its plan): the bucket stays private and the API serves the storefront pictures itself. This is the one
 * exception to "the API never proxies file bytes" (which is about private files): the bytes are public, at most 2 MiB, and cached by
 * browsers, the proxy and a CDN for a year, so each picture leaves the API about once per cache.
 *
 * @route GET /store/v1/media/:name
 */
@Controller()
export class PublicMediaController {
  constructor(private readonly images: PublicImages) {}

  /**
   * Serves one picture.
   *
   * @param params the picture's name
   * @param reply the reply, for the file headers
   * @returns the bytes
   * @throws {AppError} `NOT_FOUND` for a name of another form or a missing picture; `UNAVAILABLE` when storage is down
   * @route GET /store/v1/media/:name
   */
  @Route(showStoreMedia)
  async show(
    @Param() params: ParamsOf<typeof showStoreMedia>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const image = await this.images.read(params.name);
    if (!image) throw new AppError('NOT_FOUND', { detail: 'There is no such picture.' });
    reply
      .header('content-type', image.mime)
      .header('cache-control', `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`)
      .header('etag', `"${image.sha256}"`)
      .header('content-disposition', 'inline')
      // helmet's default is same-origin; the site (another origin in some deployments) must be able to show it.
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('x-content-type-options', 'nosniff');
    return Buffer.from(image.bytes);
  }
}
