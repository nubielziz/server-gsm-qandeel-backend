// Pure rules of notification templates (platform module, feature 12a): placeholders, validation, rendering and the HTML/text split.
// Used by the template routes (validate, preview) and by the delivery worker (render); no database, no clock.
import type { FieldError } from '../../../common/errors';
import type { NotificationChannel } from '../db/schema';

/** Longest subject of an email template. */
export const MAX_SUBJECT_LENGTH = 200;
/** Longest template body. */
export const MAX_BODY_LENGTH = 20_000;
/** What one Telegram message can hold (Bot API `sendMessage`). */
export const TELEGRAM_MAX_TEXT = 4096;

/** `{{name}}` with optional spaces inside the braces; a name starts with a letter. */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;
const HTML_TAG = /<\/?(html|body|p|div|table|a|br|span|h[1-6]|ul|ol|li|strong|em|img)\b/i;

/**
 * Lists the placeholders of a text, once each, in the order they first appear.
 *
 * @param text a subject or a body
 * @returns the names, without braces
 */
export function placeholdersOf(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]!);
  return [...names];
}

/**
 * Lists the placeholders of a text that an event does not offer.
 *
 * Why: RULES settings 10: placeholders come only from the event's variables, so a typo is refused when the template is saved
 * instead of reaching a customer as `{{custmerName}}`.
 *
 * @param text a subject or a body
 * @param allowed the variables of the event
 * @returns the unknown names, in order of appearance
 */
export function unknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  return placeholdersOf(text).filter((name) => !allowed.includes(name));
}

/**
 * Escapes the five characters that matter in HTML text and in a quoted attribute.
 *
 * Why: a variable (a merchant's name, a carrier's comment) is data; inside an HTML template it must never become markup.
 *
 * @param text any text
 * @returns the text, safe inside HTML
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tells whether a template body is HTML, by its markup.
 *
 * Why: the table has no format column; a body with tags is sent as HTML (with a text part made from it) and previewed as
 * `format: 'html'` (M171).
 *
 * @param body the template body
 * @returns true when the body contains one of the common HTML tags
 */
export function looksLikeHtml(body: string): boolean {
  return HTML_TAG.test(body);
}

/**
 * Fills the placeholders of a text.
 *
 * Why: a known variable is replaced (escaped when the text is HTML, with line breaks as `<br>`); a placeholder the variables do
 * not know stays as typed, so a mistake is visible in a preview (RULES settings 10, ANSWERS settings preview).
 *
 * @param text the template text
 * @param variables name to value
 * @param mode `html` escapes the values; `text` inserts them as they are
 * @returns the filled text
 */
export function renderText(text: string, variables: Readonly<Record<string, string>>, mode: 'text' | 'html'): string {
  return text.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = variables[name];
    if (value === undefined) return placeholder;
    return mode === 'html' ? escapeHtml(value).replace(/\r?\n/g, '<br>') : value;
  });
}

/**
 * Fills the placeholders of a subject: values as they are, on one line.
 *
 * Why: a value with a line break would split the header (mail header injection), so breaks become spaces.
 *
 * @param subject the template subject
 * @param variables name to value
 * @returns the filled subject, trimmed
 */
export function renderSubject(subject: string, variables: Readonly<Record<string, string>>): string {
  return renderText(subject, variables, 'text')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Makes the text part of an HTML mail.
 *
 * Why: every message carries a text part (decision 033), so a client that does not show HTML still reads it. Links keep their
 * address in brackets, block tags become line breaks, the rest of the markup goes.
 *
 * @param html the rendered HTML body
 * @returns plain text
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, label: string) => {
      const text = label.replace(/<[^>]*>/g, '').trim();
      return text === '' || text === href ? href : `${text} (${href})`;
    })
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What the template routes validate: the fields a template carries. */
export interface TemplateFields {
  readonly channel: NotificationChannel;
  readonly subject: string;
  readonly body: string;
}

/**
 * Checks the text fields of a template against its event.
 *
 * Why: RULES settings 10 and the endpoint docs: an email needs a subject, the message cannot be blank, and the placeholders must
 * come from the event. The field names are the request's, so the console puts each message on its input.
 *
 * @param fields the channel, subject and body
 * @param variables the variables of the template's event
 * @returns the problems, empty when the fields are valid
 */
export function checkTemplateFields(fields: TemplateFields, variables: readonly string[]): FieldError[] {
  const problems: FieldError[] = [];
  if (fields.body.trim() === '') {
    problems.push({ field: 'body', code: 'required', message: 'Write the message.' });
  } else if (fields.body.length > MAX_BODY_LENGTH) {
    problems.push({
      field: 'body',
      code: 'too_long',
      message: `The message can have at most ${MAX_BODY_LENGTH} characters.`,
    });
  } else if (fields.channel === 'telegram' && fields.body.length > TELEGRAM_MAX_TEXT) {
    problems.push({
      field: 'body',
      code: 'too_long',
      message: `A Telegram message can have at most ${TELEGRAM_MAX_TEXT} characters.`,
    });
  }
  if (fields.channel === 'email') {
    if (fields.subject.trim() === '') {
      problems.push({ field: 'subject', code: 'required', message: 'An email needs a subject.' });
    } else if (fields.subject.length > MAX_SUBJECT_LENGTH) {
      problems.push({
        field: 'subject',
        code: 'too_long',
        message: `The subject can have at most ${MAX_SUBJECT_LENGTH} characters.`,
      });
    }
  }
  const offered =
    variables.length === 0
      ? 'This event has no placeholders.'
      : `This event offers ${variables.map((name) => `{{${name}}}`).join(', ')}.`;
  for (const [field, text] of [
    ['subject', fields.channel === 'email' ? fields.subject : ''],
    ['body', fields.body],
  ] as const) {
    const unknown = unknownPlaceholders(text, variables);
    if (unknown.length > 0) {
      problems.push({
        field,
        code: 'unknown_placeholder',
        message: `Unknown placeholder ${unknown.map((name) => `{{${name}}}`).join(', ')}. ${offered}`,
      });
    }
  }
  return problems;
}

/**
 * Checks a template language code.
 *
 * @param locale the code as sent
 * @returns the problem, or `undefined` when it looks like `en` or `en-GB`
 */
export function checkLocale(locale: string): FieldError | undefined {
  return LOCALE.test(locale)
    ? undefined
    : { field: 'locale', code: 'invalid', message: 'Use a language code such as en or en-GB.' };
}

/** A rendered message, ready for a channel. */
export interface RenderedMessage {
  readonly subject: string;
  /** The text part (for Telegram the whole message). */
  readonly text: string;
  /** The HTML part, only when the template is HTML. */
  readonly html?: string;
  readonly format: 'text' | 'html';
}

/**
 * Renders a template for sending or previewing.
 *
 * Why: one function makes the message for both: the preview shows what the worker sends. An HTML body gets escaped values and a
 * generated text part; Telegram has no HTML (the message goes out as plain text, so values are never read as markup) and is cut at
 * the Bot API's limit.
 *
 * @param template the channel, subject and body
 * @param variables name to value
 * @returns the subject, the text part, the HTML part when there is one, and the format
 */
export function renderMessage(template: TemplateFields, variables: Readonly<Record<string, string>>): RenderedMessage {
  const subject = template.channel === 'email' ? renderSubject(template.subject, variables) : '';
  if (template.channel === 'email' && looksLikeHtml(template.body)) {
    const html = renderText(template.body, variables, 'html');
    return { subject, text: htmlToText(html), html, format: 'html' };
  }
  const text = renderText(template.body, variables, 'text');
  return {
    subject,
    text: template.channel === 'telegram' ? text.slice(0, TELEGRAM_MAX_TEXT) : text,
    format: 'text',
  };
}
