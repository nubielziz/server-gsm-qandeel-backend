// Route contract of the public service pictures (feature 22, a route beyond the map, scripts/map-additions/22.mjs): the bytes of a picture
// staff uploaded for a storefront service, by its content name, cached for a year.
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';

/** `GET /store/v1/media/:name`. */
export const showStoreMedia = defineRoute({
  key: 'GET /store/v1/media/:name',
  summary: 'Download a service picture',
  description:
    'The picture of a storefront service, as the `imageUrl` of a service card names it (`/store/v1/media/<sha256>.<jpg|png|webp>`). ' +
    'The name is the SHA-256 of the bytes, so the answer never changes: `Cache-Control: public, max-age=31536000, immutable`, ' +
    '`ETag` the SHA-256, `Content-Type` the real type of the picture (`image/jpeg`, `image/png` or `image/webp`), ' +
    '`Content-Disposition: inline` and `Cross-Origin-Resource-Policy: cross-origin` (the site may show it from another origin). The ' +
    'picture was checked and cleaned when it was uploaded (no metadata). A name of another form, or one that names no picture, is ' +
    '`404`. Public, no Turnstile; limited per address by its own budget (1200 a minute), apart from the API budget.',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  params: z.object({ name: z.string().min(1).max(200).describe('`<sha256>.<jpg|png|webp>`.') }),
  success: { status: 200, contentType: 'image/*' },
  errors: ['NOT_FOUND', 'UNAVAILABLE'],
});
