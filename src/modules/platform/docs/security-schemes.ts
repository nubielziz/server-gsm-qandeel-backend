// The OpenAPI security schemes of the API (decisions 017, 018, 019): how each access kind of a route contract
// authenticates. `SECURITY_SCHEME` (src/common/contract/openapi.ts) maps an access kind to a name defined here.
import type { PlainObject } from './openapi-types';

/**
 * Name of the scheme that documents the signature header of outgoing webhook events.
 *
 * Why: events are sent by us, so the scheme is documentation for the receiver, not a way to call the API.
 */
export const WEBHOOK_SIGNATURE_SCHEME = 'webhookSignature';

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
      'Merchant portal session cookie, set by the sign-in routes under `/client/auth`. HttpOnly; carries the `__Host-` prefix in production. Requests that change data also send `X-CSRF-Token`.',
  },
  customerSession: {
    type: 'apiKey',
    in: 'cookie',
    name: 'gsm_store_session',
    description:
      'Storefront customer session cookie, set by the sign-in routes under `/store/v1/auth` (password or sign-in link). HttpOnly; carries the `__Host-` prefix in production. Requests that change data also send `X-CSRF-Token`.',
  },
  apiKey: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key',
    description:
      'Merchant API key sent as `Authorization: Bearer <key>`. A key has scopes (each operation names the one it needs), an optional list of allowed IP addresses and its own requests-per-minute limit.',
  },
  dhruCredentials: {
    type: 'http',
    scheme: 'dhru',
    description:
      'Dhru Fusion credentials are not an HTTP header: send `username` and `apiaccesskey` as form fields in the request body. The key must carry the `dhru` scope and passes the same IP and rate-limit checks as a REST v1 key.',
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
      'A secret path segment (for example `/webhooks/telegram/{secret}`) that only the provider knows; a wrong secret answers as if the route did not exist.',
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
  [WEBHOOK_SIGNATURE_SCHEME]: {
    type: 'apiKey',
    in: 'header',
    name: 'X-GSM-Signature',
    description:
      'Header we add to every outgoing webhook event: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, keyed with the secret of the webhook endpoint. Recompute it over the raw body and refuse deliveries older than 5 minutes. Documented for receivers; it cannot be used to call this API.',
  },
};
