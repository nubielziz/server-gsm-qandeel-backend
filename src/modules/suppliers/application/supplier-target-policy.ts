// The seam that decides how a supplier address is resolved and called (decision 023), like the webhook target policy: production leaves
// it unset; tests provide it to reach a local fake supplier over plain http.
import type { HostLookup } from '../../../infra/http';

/**
 * How the address of a supplier is judged and called.
 *
 * Why: decision 023: a supplier address must be `https` with a public host in production (the setting
 * `suppliers.allowPlainHttp` is the admin-visible opt-out for a supplier on plain http). A test of the real send needs a local
 * server (a private address over plain `http`), so it provides this token. Nothing in production provides it.
 */
export interface SupplierTargetPolicy {
  /** The DNS resolver of the public-address check; the system resolver when missing. */
  readonly lookup?: HostLookup;
  /** Let a call reach private and loopback addresses (a local test server). Default `false`. */
  readonly allowPrivateNetwork?: boolean;
  /** Refuse plain `http`. Default: the production rule of `OutboundHttp`. */
  readonly httpsOnly?: boolean;
}

/** The injection token of {@link SupplierTargetPolicy}; always injected as optional. */
export const SUPPLIER_TARGET_POLICY = Symbol.for('gsm.SUPPLIER_TARGET_POLICY');

/** The setting that lets suppliers be called over plain `http` in production. */
export const SUPPLIER_PLAIN_HTTP_KEY = 'suppliers.allowPlainHttp';
