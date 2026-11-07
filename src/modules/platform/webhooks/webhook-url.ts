// The save-time check of a merchant's webhook address (decision 023, MISMATCHES B156): https only, no credentials, a public host.
import { UnsafeUrlError, assertPublicHttpUrl, type HostLookup } from '../../../infra/http';

/** The sentence for the `url` field of each reason the guard refuses an address. */
const MESSAGES: Readonly<Record<UnsafeUrlError['reason'], string>> = {
  invalid_url: 'Enter a full address like https://example.com/webhooks.',
  scheme_not_allowed: 'The address must start with https://.',
  credentials_in_url: 'Remove the user name and password from the address.',
  dns_failure: 'We could not find this host. Check the address.',
  non_public_address: 'The address must point to a public host, not to a private or local network.',
};

/**
 * Checks that an address may be saved as a webhook endpoint.
 *
 * Why: B156: the SSRF guard of decision 023 runs at save time (so a merchant learns at once) and again at every send (so a host
 * that starts to resolve to a private address later is still refused). The address is `https` whatever the environment.
 *
 * Side effects: one DNS lookup for a host name.
 *
 * @param url the address as sent
 * @param lookup the DNS resolver (the system resolver when missing; tests replace it)
 * @returns the sentence for the `url` field, or `undefined` when the address is acceptable
 */
export async function webhookUrlProblem(url: string, lookup?: HostLookup): Promise<string | undefined> {
  try {
    await assertPublicHttpUrl(url, { httpsOnly: true, ...(lookup === undefined ? {} : { lookup }) });
    return undefined;
  } catch (error) {
    if (error instanceof UnsafeUrlError) return MESSAGES[error.reason];
    throw error;
  }
}
