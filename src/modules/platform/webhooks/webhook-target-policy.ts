// The seam that decides how a webhook address is resolved and called (decision 023). Production leaves it unset; tests provide
// it to reach a local server and to stand in for DNS.
import type { HostLookup } from '../../../infra/http';

/**
 * How the address of a merchant's endpoint is judged and called.
 *
 * Why: decision 023 and B156: an address must be `https` with a public host, at save time and again at every send. A test of the
 * real send needs a local server (a private address over plain `http`) and a test of the save-time check needs a resolver that
 * does not depend on the network, so both are provided through this token. Nothing in production provides it.
 */
export interface WebhookTargetPolicy {
  /** The DNS resolver of the public-address check; the system resolver when missing. */
  readonly lookup?: HostLookup;
  /** Let a call reach private and loopback addresses (a local test server). Default `false`. */
  readonly allowPrivateNetwork?: boolean;
  /** Refuse plain `http`. Default `true`. */
  readonly httpsOnly?: boolean;
}

/** The injection token of {@link WebhookTargetPolicy}; always injected as optional. */
export const WEBHOOK_TARGET_POLICY = Symbol.for('gsm.WEBHOOK_TARGET_POLICY');
