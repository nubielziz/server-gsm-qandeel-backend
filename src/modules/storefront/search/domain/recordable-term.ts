// What the search statistics may keep (feature 29, plan section 5.6): which terms are counted at all, and which requests are not a
// visitor searching (bots, prefetches). Pure; no personal data is ever stored, so what could be personal is not counted.

/** The shortest and longest term counted. */
export const MIN_TERM_LENGTH = 2;
/** The longest term counted (the `search_terms_daily.term` check). */
export const MAX_TERM_LENGTH = 64;
/** The most digits a counted term may hold in all. */
export const MAX_TERM_DIGITS = 5;

const DIGIT_RUN = /\d{5,}/;

/**
 * Tells whether a normalised search term may be counted.
 *
 * Why: plan section 5.6 and owner question 8: the daily counts never hold an IMEI, a phone number, an email address, an order number
 * or a link, because the typed text of a visitor is not ours to keep. 2-64 characters, at most 5 digits in all, no `@`, no `http` or
 * `www.`, not starting with `+`, no run of 5 or more digits. A model code such as `a525f` (3 digits) stays countable.
 *
 * @param term the normalised term (`normaliseText`)
 * @returns true when the term may be counted
 */
export function isRecordableTerm(term: string): boolean {
  if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) return false;
  if (term.includes('@') || term.startsWith('+')) return false;
  if (term.includes('http') || term.includes('www.')) return false;
  if (DIGIT_RUN.test(term)) return false;
  let digits = 0;
  for (const character of term) if (character >= '0' && character <= '9') digits += 1;
  return digits <= MAX_TERM_DIGITS;
}

const BOT_AGENT =
  /bot\b|bots\b|crawl|spider|slurp|preview|headless|lighthouse|pingdom|monitor|uptime|curl\/|wget|python-requests|go-http-client|java\/|httpclient|facebookexternalhit|scrapy|phantomjs/i;

/**
 * Tells whether a User-Agent is a program and not a visitor.
 *
 * Why: plan section 5.6: crawlers and monitors would feed the counts and the popular searches. A request with no User-Agent is no
 * browser either.
 *
 * @param userAgent the `User-Agent` header, if any
 * @returns true for bots, crawlers, previews, headless browsers, monitors and a missing agent
 */
export function isBotUserAgent(userAgent: string | undefined): boolean {
  if (userAgent === undefined || userAgent.trim() === '') return true;
  return BOT_AGENT.test(userAgent);
}

/** The request headers the prefetch rule reads (lower-cased names, as Fastify gives them). */
export type PrefetchHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Tells whether a request is a browser's or Next.js's prefetch and not a visitor searching.
 *
 * Why: plan section 5.6: hovering a link prefetches its page, which would count a search nobody made. Not counted: a request with
 * `Next-Router-Prefetch`, `Purpose: prefetch` or `Sec-Purpose: prefetch`.
 *
 * @param headers the request headers
 * @returns true for a prefetch
 */
export function isPrefetchRequest(headers: PrefetchHeaders): boolean {
  if (headers['next-router-prefetch'] !== undefined) return true;
  const text = (name: string): string => {
    const value = headers[name];
    return (Array.isArray(value) ? value.join(',') : (value ?? '')).toLowerCase();
  };
  return text('purpose').includes('prefetch') || text('sec-purpose').includes('prefetch');
}
