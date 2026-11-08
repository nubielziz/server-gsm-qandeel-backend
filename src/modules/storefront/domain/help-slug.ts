// The public slug of a help article (feature 15): `<id>-<words of the question>`. The table has no slug column, so the slug is
// derived; the id in front keeps it unique and stable, and the words only make the address readable.
import { slugOf } from './slug';

/** How many characters of the question's words a help slug keeps. */
const HELP_SLUG_WORDS_MAX = 60;

/**
 * Builds the public slug of a help article.
 *
 * Why: `GET /store/v1/help/:slug` needs an address for one article, and `help_articles` has no slug column. The id makes the
 * slug unique without a column, a migration or a collision rule; the words come from the question and change when it is edited,
 * which {@link helpIdOfSlug} tolerates, so an old link keeps working.
 *
 * @param article the article's id and question
 * @returns for example `10-how-do-i-find-my-imei`; just the id when the question has no Latin letters
 */
export function helpSlugOf(article: { id: number; question: string }): string {
  const words = slugOf(article.question).slice(0, HELP_SLUG_WORDS_MAX).replace(/-$/, '');
  return words === '' ? String(article.id) : `${article.id}-${words}`;
}

/**
 * Reads the article id out of a public help slug; the words after the id are ignored.
 *
 * @param slug the slug of the request
 * @returns the id, or `undefined` when the slug does not start with a valid id
 */
export function helpIdOfSlug(slug: string): number | undefined {
  const match = /^([1-9]\d{0,15})(?:-[a-z0-9-]*)?$/.exec(slug);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}
