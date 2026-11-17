// Reads the default templates that applied migrations insert or update (feature 30, decision 039). An applied file is never edited
// (decision 027): it keeps the shape it shipped with (a `locale` column, rows in other languages), so the specs of the default templates
// check that every row of the code is found in the file that shipped it, instead of comparing the code's SQL with the file's text.
import { readFileSync } from 'node:fs';

/** One template row as an applied migration inserts it. */
export interface AppliedTemplate {
  readonly event: string;
  readonly channel: string;
  readonly audience: string;
  readonly locale: string;
  readonly subject: string;
  readonly body: string;
}

/** One guarded body change of an applied migration: `SET "body" = to WHERE <key> AND "body" = from`. */
export interface AppliedBodyUpdate {
  readonly event: string;
  readonly channel: string;
  readonly audience: string;
  readonly locale: string;
  /** The body the row must still have (the text an earlier migration shipped). */
  readonly from: string;
  /** The body it gets. */
  readonly to: string;
}

/** A single-quoted SQL literal, `''` standing for one quote. */
const LITERAL = String.raw`'((?:[^']|'')*)'`;
const unquote = (text: string): string => text.replace(/''/g, "'");

/**
 * Reads an applied migration.
 *
 * @param file the file name in `drizzle/`, such as `0016_support_tickets.sql`
 * @returns its text
 */
export function appliedMigration(file: string): string {
  return readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8');
}

/** The statements of a migration that touch `notification_templates` with the given verb. */
function templateStatements(file: string, verb: 'INSERT INTO' | 'UPDATE'): string[] {
  return appliedMigration(file)
    .split('--> statement-breakpoint')
    .filter((statement) => statement.includes(`${verb} "notification_templates"`));
}

/**
 * Lists the template rows the `INSERT INTO "notification_templates"` statements of an applied migration hold.
 *
 * Why: every applied insert names the columns `event, channel, audience, locale, subject, body, is_active` in that order and writes one
 * `('…', '…', '…', '…', '…', '…', true)` row per template (migrations 0011 to 0027).
 *
 * @param file the file name in `drizzle/`
 * @returns the rows in file order (an empty list when the file inserts no template)
 * @throws {Error} when an insert names other columns, or holds a row the pattern cannot read (the parser would misread or skip it)
 */
export function insertedTemplates(file: string): AppliedTemplate[] {
  const row = new RegExp(
    String.raw`\(${Array(6)
      .fill(LITERAL)
      .join(String.raw`,\s*`)},\s*true\)`,
    'g',
  );
  return templateStatements(file, 'INSERT INTO').flatMap((statement) => {
    if (!statement.includes('("event", "channel", "audience", "locale", "subject", "body", "is_active")'))
      throw new Error(`${file}: an insert of notification_templates with other columns.`);
    const matches = [...statement.matchAll(row)];
    // Every row starts a line with two spaces and a bracket: a row the pattern cannot read must fail here, not go missing.
    const lines = statement.match(/^ {2}\('/gm)?.length ?? 0;
    if (matches.length !== lines)
      throw new Error(`${file}: ${lines} template rows, ${matches.length} of them readable.`);
    return matches.map((match) => {
      const [event, channel, audience, locale, subject, body] = match.slice(1, 7).map((value) => unquote(value));
      return { event: event!, channel: channel!, audience: audience!, locale: locale!, subject: subject!, body: body! };
    });
  });
}

/**
 * Lists the guarded body changes the `UPDATE "notification_templates"` statements of an applied migration hold.
 *
 * Why: migration 0032 appends the conversation link to the merchant's reply only where the body is still the shipped one; its
 * statements read `SET "body" = … WHERE "event" = … AND "channel" = … AND "audience" = … AND "locale" = … AND "body" = …;`.
 *
 * @param file the file name in `drizzle/`
 * @returns the changes in file order
 * @throws {Error} when an update has another shape
 */
export function bodyUpdates(file: string): AppliedBodyUpdate[] {
  const update = new RegExp(
    String.raw`SET "body" = ${LITERAL}\s+WHERE "event" = ${LITERAL} AND "channel" = ${LITERAL} AND "audience" = ${LITERAL} ` +
      String.raw`AND "locale" = ${LITERAL} AND "body" = ${LITERAL};`,
  );
  return templateStatements(file, 'UPDATE').map((statement) => {
    const match = update.exec(statement);
    if (!match) throw new Error(`${file}: an update of notification_templates of another shape.`);
    const [to, event, channel, audience, locale, from] = match.slice(1, 7).map((value) => unquote(value));
    return { event: event!, channel: channel!, audience: audience!, locale: locale!, from: from!, to: to! };
  });
}
