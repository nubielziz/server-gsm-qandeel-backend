// Public API of the outbound HTTP infrastructure (decision 023): the request helper, the SSRF guard and the Nest service.
// `httpRequest` itself is internal: callers use OutboundHttp, which adds the duration metric and the log line.
export { DEFAULT_MAX_RESPONSE_BYTES, HttpRequestError, MAX_TIMEOUT_MS } from './http-request';
export type { HttpFailure, HttpMethod, HttpRequestOptions, HttpResult } from './http-request';
export { OutboundHttp } from './http.service';
export type { OutboundRequestOptions } from './http.service';
export { OutboundHttpModule } from './http.module';
export { isPublicAddress } from './ip-ranges';
export { UnsafeUrlError, assertPublicHttpUrl } from './public-url';
export type { HostLookup, PublicUrl, PublicUrlOptions, UnsafeUrlReason } from './public-url';
