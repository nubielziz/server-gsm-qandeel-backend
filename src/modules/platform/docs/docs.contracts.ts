// Route contracts of the two public documentation routes the map lists under surface system: GET /openapi.json and
// GET /docs.
import { defineRoute } from '../../../common/contract';

/**
 * Contract of `GET /openapi.json`.
 *
 * Why: the map publishes the REST v1 specification at a fixed public URL (decision 017) so merchants and tools can
 * import it. The answer is the committed `docs/contract/openapi.public.json`, so it has a media type and no schema.
 *
 * @route GET /openapi.json
 */
export const openApiJsonContract = defineRoute({
  key: 'GET /openapi.json',
  summary: 'REST API v1 specification (OpenAPI 3.1)',
  description:
    'The public OpenAPI 3.1 document: the REST API v1 operations, the Dhru Fusion reference operation and the webhook events we send. Generated from the route contracts and committed as `docs/contract/openapi.public.json`.',
  tags: ['docs'],
  surface: 'system',
  access: 'public',
  success: { status: 200, contentType: 'application/json' },
  errors: [],
});

/**
 * Contract of `GET /docs`.
 *
 * Why: the map lists a documentation page for REST v1; decision 017 renders the public document with Scalar.
 *
 * @route GET /docs
 */
export const docsPageContract = defineRoute({
  key: 'GET /docs',
  summary: 'REST API v1 documentation page',
  description:
    'An HTML page (Scalar) that shows `/openapi.json`. It is served with its own Content-Security-Policy; every other route of the API keeps `default-src \'none\'`.',
  tags: ['docs'],
  surface: 'system',
  access: 'public',
  success: { status: 200, contentType: 'text/html' },
  errors: [],
});
