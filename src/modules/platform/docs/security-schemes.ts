// The OpenAPI security schemes of the API (decisions 017, 018, 019): how each access kind of a route contract
// authenticates. `SECURITY_SCHEME` (src/common/contract/openapi.ts) maps an access kind to a name defined here.
import type { PlainObject } from './openapi-types';

/**
 * Every security scheme of the documents, by name.
 *
 * Why: operations only name a scheme (`security: [{ staffSession: [] }]`); the document must define each name, with the
 * cookie names of decision 018 and the signature format of decision 019, so readers know how to authenticate.
 * Schemes that OpenAPI cannot express as a header or cookie (Dhru form fields, secrets in the path) use a custom HTTP
 * scheme name and say so in the description.
 */
export const SECURITY_SCHEMES: Readonly<Record<string, PlainObject>> = {
  staffSession: {
    type: 'apiKey',
    in: 'cookie',
    name: 'gsm_admin_session',
    description:
      'Staff session cookie, set by the sign-in steps under `/admin/auth` (password, then the 2FA code). HttpOnly; carries the `__Host-` prefix in production. Requests that change data also send the `X-CSRF-Token` header returned by sign-in. The permission a route needs is shown in `x-gsm-permission`.',
  },
  merchantSession: {
    type: 'apiKey',
    in: 'cookie',
    name: 'gsm_client_session',
    description:
      'Session cookie of an account of a merchant rank, set by the sign-in routes under `/client/auth`. It is the one session cookie of every account: the same cookie opens a retail account (see `customerSession`), and the rank of the account decides which routes it may call (`403 RANK_NOT_ALLOWED` on the others). HttpOnly; carries the `__Host-` prefix in production. Requests that change data also send `X-CSRF-Token`.',
  },
  customerSession: {
    type: 'apiKey',
    in: 'cookie',
    name: 'gsm_client_session',
    description:
      'Session cookie of an account of the retail rank (a shop account), set by the sign-in routes under `/client/auth` (password) or `/store/v1/auth` (sign-in link). It is the same cookie as `merchantSession`, because there is one session cookie for every account; the older `gsm_store_session` is never read. HttpOnly; carries the `__Host-` prefix in production. Requests that change data also send `X-CSRF-Token`, whose readable cookie is `csrf_token_store` for the retail rank and `csrf_token_client` for a merchant rank.',
  },
  dhruCredentials: {
    type: 'http',
    scheme: 'dhru',
    description:
      'Dhru Fusion credentials are not an HTTP header: send `username` and `apiaccesskey` as form fields in the request body. The key has an optional list of allowed IP addresses and its own requests-per-minute limit.',
  },
  gatewaySignature: {
    type: 'http',
    scheme: 'gateway-signature',
    description:
      'Payment gateway webhook, verified per gateway with its signing secret. Deliveries outside a 5-minute window are refused and events are de-duplicated by the gateway event id.',
  },
  urlSecret: {
    type: 'http',
    scheme: 'url-secret',
    description:
      'A secret path segment (for example `/webhooks/{provider}/{secret}`) that only the provider knows; a wrong secret answers as if the route did not exist.',
  },
  capabilityToken: {
    type: 'http',
    scheme: 'capability-token',
    description:
      'An unguessable token in the path (checkout, order tracking, support ticket or sign-in link) that authorises exactly one record. Sent by email or shown once; stored only as a hash.',
  },
  metricsAccess: {
    type: 'http',
    scheme: 'bearer',
    description:
      'Prometheus scrape access: loopback and private networks, or `Authorization: Bearer <METRICS_TOKEN>`. When a token is configured it is required from every caller.',
  },
};
