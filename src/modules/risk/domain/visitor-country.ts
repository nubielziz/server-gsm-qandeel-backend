// The visitor's country from a trusted proxy header (decision 050: the country of the visit is one piece of evidence for the payment
// screening). Pure, no database.

/**
 * Reads the country a trusted proxy reports for the visitor.
 *
 * Why: decision 050: the checkout keeps the visitor's country (`checkout_sessions.ip_country`) only when the proxy header named by the
 * optional config `GEOIP_COUNTRY_HEADER` carries one; the payment screening compares it with the card's country. Only a two-letter value
 * counts (Cloudflare writes `XX` and `T1` for unknown and Tor: `XX` and `T1` are refused).
 *
 * @param value the header value, if the header is configured and present
 * @returns the upper-case ISO-2 country, or `null`
 */
export function countryFromHeader(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  const country = text?.trim().toUpperCase();
  if (country === undefined || !/^[A-Z]{2}$/.test(country) || country === 'XX' || country === 'T1') return null;
  return country;
}
