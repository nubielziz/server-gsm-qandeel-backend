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
 * address in brackets, block tags become line breaks, the rest of the markup goes. It reads an anchor written the way the check of a link
 * email accepts it (the address in double quotes, `</a>` closing it); the check refuses the shapes this function would read differently.
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
    .replace(/<br\b[^>]*>|<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, '\n')
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

/**
 * Wraps plain text into the HTML part of an email.
 *
 * Why: feature 23, plan 9.3 and decision 039 (English only): the text is escaped first, so stored text can never become markup,
 * and line breaks become `<br>`. Text that people typed (a name, a message) is carried as typed inside the left-to-right wrapper.
 *
 * @param text the plain text
 * @returns the HTML part: a `div` with `dir="ltr" lang="en"`
 */
export function emailHtml(text: string): string {
  const body = escapeHtml(text).replace(/\r?\n/g, '<br>\n');
  return `<div dir="ltr" lang="en">${body}</div>`;
}

/**
 * The tags a template of a link email may use.
 *
 * Why: decision 047: the `{{link}}` of these events is a one-time credential, so the template keeps it inside the message and away from
 * any other address; text formatting tags only (no image, form, style, script or other embedded content).
 */
export const LINK_MAIL_TAGS = [
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'br',
  'p',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'html',
  'body',
] as const;

/**
 * The attributes a tag of a link email may carry (`href` is allowed only on `a`, and only as the link).
 *
 * Why: decision 047: none of these loads a resource or runs a script; their values are checked for other addresses too. An email that
 * protects accounts may not use `style` at all: a style could make the text it must show disappear.
 */
export const LINK_MAIL_ATTRIBUTES = [
  'style',
  'class',
  'title',
  'dir',
  'lang',
  'align',
  'valign',
  'width',
  'height',
  'colspan',
  'rowspan',
  'border',
  'cellpadding',
  'cellspacing',
  'bgcolor',
  'role',
  'target',
  'rel',
] as const;

const LINK_PLACEHOLDER = /\{\{\s*link\s*\}\}/;
const LINK_PLACEHOLDERS = /\{\{\s*link\s*\}\}/g;
const LINK_WHOLE = /^\{\{\s*link\s*\}\}$/;
const CHANGE_PLACEHOLDER = /\{\{\s*change\s*\}\}/;
// Characters that show nothing: they could hide a glued address or text from the placement rule.
const HIDDEN_CHARACTERS = /[\u200b-\u200f\u2060\ufeff]/;
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;
const ATTRIBUTE_NAME = /[^\s"'<>/=]+/y;
const UNQUOTED_VALUE = /[^\s>]*/y;
const WHITE_SPACE = /\s*/y;
const DOCTYPE = /<!doctype\s+html\s*>/iy;
// A reader's mail program reads a numeric reference with any number of digits, leading zeros included, so neither form has a length bound.
const REFERENCE = /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos|nbsp|sol|bsol|colon|period|tab|newline));?/gi;
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  sol: '/',
  bsol: '\\',
  colon: ':',
  period: '.',
  tab: '\t',
  newline: '\n',
};
const OTHER_ADDRESS = /[\\/]{2}|(?<![A-Za-z0-9+.-])(?:https?|ftps?|wss?|javascript|vbscript|mailto)\s*:/i;
const RISKY_ATTRIBUTE_VALUE = /\\|url\(|@import|expression\(|image-set\(/i;
// What is left of an ampersand that starts a name once the references the scan decodes are taken out: a reference the scan does not read.
const UNREAD_REFERENCE = /&[A-Za-z]/;
// What no attribute value may hold: the text part (htmlToText) ends a tag at the first ">" and finds a link's address by the word href
// and the double quotes of the tag, so a value with these could be read there differently from the scan.
const UNREADABLE_VALUE = /[<>"]|href/i;
const BLOCK_END_TAGS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol']);
const LINK_TAGS = new Set<string>(LINK_MAIL_TAGS);
const LINK_ATTRIBUTES = new Set<string>(LINK_MAIL_ATTRIBUTES);

const LINK_MESSAGES = {
  link_markup:
    'Write the message as text or simple HTML: close every tag with ">", close the link with </a>, and leave out comments and <!...> or <?...> blocks.',
  link_href: 'A link in this email can only lead to {{link}}: write <a href="{{link}}">.',
  link_anchors: 'Use {{link}} in one link only.',
  link_label: 'Give the link a text, such as <a href="{{link}}">Sign in</a>.',
  link_placement:
    'Put {{link}} on its own (at the start of a line or after a space) or as the whole href of one link: <a href="{{link}}">.',
  link_url: 'This email can hold no other web address: only {{link}} may lead somewhere.',
} as const;

const SECURITY_MESSAGES = {
  link_missing: 'This email protects accounts: keep {{link}} in the message.',
  change_missing: 'This email protects accounts: keep {{change}} in the message, it says what changed.',
  link_hidden:
    'This email protects accounts: {{link}} must stand in the text of the message or as the address of its link, not inside a comment or a tag.',
  change_hidden:
    'This email protects accounts: {{change}} must stand in the text of the message, not inside a comment or a tag.',
} as const;

function linkProblem(code: keyof typeof LINK_MESSAGES): FieldError {
  return { field: 'body', code, message: LINK_MESSAGES[code] };
}

function securityProblem(message: keyof typeof SECURITY_MESSAGES): FieldError {
  return { field: 'body', code: 'security_placeholder', message: SECURITY_MESSAGES[message] };
}

function isAsciiLetter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z]/.test(character);
}

/** Decodes the character references a browser would read, once, and drops the tab and line feed characters it ignores inside an address. */
function decodeReferences(text: string): string {
  return text
    .replace(REFERENCE, (whole, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_REFERENCES[name.toLowerCase()] ?? whole;
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal ?? '', 10);
      return code >= 1 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    })
    .replace(/[\t\r\n]/g, '');
}

/** Tells whether an attribute value holds a character reference that {@link decodeReferences} does not read (a named one outside its list). */
function hasUnreadReference(text: string): boolean {
  return UNREAD_REFERENCE.test(text.replace(REFERENCE, ''));
}

/** The entities `htmlToText` decodes, in its order: what a reader of the text part sees. */
function decodeShownText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** How a body is scanned. */
interface ScanMode {
  /** The event has no link to carry (a security notice): no `href` is accepted and the rules about the link are not asked. */
  readonly notice: boolean;
  /** The event protects accounts: the `style` attribute is refused, so no text can be made to disappear. */
  readonly security: boolean;
}

/** What the markup scan of a body found. */
interface BodyScan {
  /** The first thing to refuse, or `undefined` when the body holds nothing to refuse. */
  readonly problem: FieldError | undefined;
  /** The text of the message as the reader sees it (outside every tag, attribute and comment); empty when there is a problem. */
  readonly shown: string;
  /** An anchor whose `href` is the link is in the body. */
  readonly carried: boolean;
}

/** Scans a template body: its tags, attributes, character references and the text the reader sees. */
function scanBody(body: string, mode: ScanMode): BodyScan {
  const refuse = (problem: FieldError): BodyScan => ({ problem, shown: '', carried: false });
  if (HIDDEN_CHARACTERS.test(body)) return refuse(linkProblem('link_markup'));
  const html = looksLikeHtml(body);
  const length = body.length;
  let shown = '';
  let anchors = 0;
  let carrying = false;
  let labelStart = 0;
  let index = 0;
  const skipSpace = (from: number): number => {
    WHITE_SPACE.lastIndex = from;
    WHITE_SPACE.exec(body);
    return WHITE_SPACE.lastIndex;
  };
  while (index < length) {
    const open = body.indexOf('<', index);
    if (open < 0) {
      shown += body.slice(index);
      break;
    }
    shown += body.slice(index, open);
    const next = body[open + 1];
    if (isAsciiLetter(next)) {
      TAG_NAME.lastIndex = open + 1;
      const name = TAG_NAME.exec(body)![0].toLowerCase();
      if (!LINK_TAGS.has(name)) {
        return refuse({
          field: 'body',
          code: 'link_tag',
          message: `This email can use text formatting tags only: remove the <${name}> tag.`,
        });
      }
      let at = open + 1 + name.length;
      let hasHref = false;
      for (;;) {
        at = skipSpace(at);
        if (at >= length || body[at] === '<') return refuse(linkProblem('link_markup'));
        if (body[at] === '>') {
          at += 1;
          break;
        }
        if (body[at] === '/' && body[at + 1] === '>') {
          at += 2;
          break;
        }
        ATTRIBUTE_NAME.lastIndex = at;
        const found = ATTRIBUTE_NAME.exec(body);
        if (!found) return refuse(linkProblem('link_markup'));
        const attribute = found[0].toLowerCase();
        at = skipSpace(at + found[0].length);
        let value: { readonly text: string; readonly quote: string } | undefined;
        if (body[at] === '=') {
          at = skipSpace(at + 1);
          if (at >= length) return refuse(linkProblem('link_markup'));
          const quote = body[at]!;
          if (quote === '"' || quote === "'") {
            const close = body.indexOf(quote, at + 1);
            if (close < 0) return refuse(linkProblem('link_markup'));
            value = { text: body.slice(at + 1, close), quote };
            at = close + 1;
          } else {
            UNQUOTED_VALUE.lastIndex = at;
            const text = UNQUOTED_VALUE.exec(body)![0];
            if (/[<"'`]/.test(text)) return refuse(linkProblem('link_markup'));
            value = { text, quote: '' };
            at += text.length;
          }
          if (UNREADABLE_VALUE.test(value.text)) return refuse(linkProblem('link_markup'));
        }
        if (attribute === 'href') {
          if (name !== 'a' || mode.notice) {
            return refuse({
              field: 'body',
              code: 'link_attribute',
              message: `Remove the href attribute of the <${name}> tag.`,
            });
          }
          // The text part keeps an anchor's address only when it is written in double quotes (htmlToText), so only that form is allowed.
          if (value === undefined || value.quote !== '"' || !LINK_WHOLE.test(value.text) || hasHref) {
            return refuse(linkProblem('link_href'));
          }
          hasHref = true;
        } else if (!LINK_ATTRIBUTES.has(attribute) || (mode.security && attribute === 'style')) {
          return refuse({
            field: 'body',
            code: 'link_attribute',
            message: `Remove the ${attribute} attribute of the <${name}> tag.`,
          });
        } else if (value !== undefined) {
          if (mode.notice) {
            if (CHANGE_PLACEHOLDER.test(value.text)) return refuse(securityProblem('change_hidden'));
          } else if (LINK_PLACEHOLDER.test(value.text)) {
            return refuse(linkProblem('link_placement'));
          }
          // A reference the scan does not decode could spell what the scan looks for, so it is refused like the risky value itself.
          if (RISKY_ATTRIBUTE_VALUE.test(decodeReferences(value.text)) || hasUnreadReference(value.text)) {
            return refuse(
              mode.notice
                ? {
                    field: 'body',
                    code: 'link_url',
                    message:
                      'A tag of this email carries style code or a character reference that is not allowed: remove it.',
                  }
                : linkProblem('link_url'),
            );
          }
        }
      }
      if (name === 'br') shown += '\n';
      if (name === 'a' && hasHref) {
        anchors += 1;
        if (anchors > 1) return refuse(linkProblem('link_anchors'));
        carrying = true;
        labelStart = shown.length;
      }
      index = at;
    } else if (next === '/' && isAsciiLetter(body[open + 2])) {
      TAG_NAME.lastIndex = open + 2;
      const name = TAG_NAME.exec(body)![0].toLowerCase();
      if (!LINK_TAGS.has(name)) {
        return refuse({
          field: 'body',
          code: 'link_tag',
          message: `This email can use text formatting tags only: remove the <${name}> tag.`,
        });
      }
      // The text part reads an end tag only when ">" follows its name at once (htmlToText), so a space before it is refused.
      const at = open + 2 + name.length;
      if (body[at] !== '>') return refuse(linkProblem('link_markup'));
      if (BLOCK_END_TAGS.has(name)) shown += '\n';
      if (name === 'a' && carrying) {
        carrying = false;
        if (decodeShownText(shown.slice(labelStart)).trim() === '') return refuse(linkProblem('link_label'));
      }
      index = at + 1;
    } else if (next === '!') {
      DOCTYPE.lastIndex = open;
      if (!DOCTYPE.test(body)) return refuse(linkProblem('link_markup'));
      index = DOCTYPE.lastIndex;
    } else if (next === '?') {
      return refuse(linkProblem('link_markup'));
    } else {
      // In an HTML body the text part would read a lone "<" as the start of a tag and drop what follows it up to the next ">".
      if (html) {
        return refuse({
          field: 'body',
          code: 'link_markup',
          message: 'Write &lt; for a less-than sign in an HTML message: a lone < is read as the start of a tag.',
        });
      }
      shown += '<';
      index = open + 1;
    }
  }
  if (carrying) return refuse(linkProblem('link_markup'));
  // A body without the tags of the HTML detection is sent as plain text: what the reader sees is the body itself.
  const text = html ? decodeShownText(shown) : body;
  if (!mode.notice) {
    for (const match of text.matchAll(LINK_PLACEHOLDERS)) {
      const before = match.index > 0 ? text[match.index - 1]! : '';
      if (before !== '' && !' \t\n\r'.includes(before)) return refuse(linkProblem('link_placement'));
    }
    if (OTHER_ADDRESS.test(decodeReferences(body))) return refuse(linkProblem('link_url'));
  }
  return { problem: undefined, shown: text, carried: anchors > 0 };
}

/**
 * Checks that a template of a link email keeps its `{{link}}` inside the message and holds no other address.
 *
 * Why: decision 047: the `link` of these events is a one-time credential. The template may put `{{link}}` only where the reader meets it
 * as the link itself: on its own in the text (at the start, or after a space or a line break; in the text the message shows) or as the whole
 * `href` of one link that has a text, never in the subject. It holds no other web address (also when written with character references; a
 * reference the scan does not decode is refused inside a tag), only the tags and attributes of two short lists, and no comment or declaration.
 * The text part of the mail must read what the scan accepted, so a tag whose end the text part would find elsewhere (an end tag with a space
 * before `>`, a `<`, `>` or double quote inside an attribute value, a lone `<` in an HTML body) is refused. The scan walks indexes and
 * every pattern is anchored or linear, so a long hostile body is answered quickly.
 *
 * @param fields the channel, subject and body of the template (a shipped text passes too)
 * @param options `security`: the event also protects accounts, so the `style` attribute is refused too
 * @returns at most one problem for `subject` and one for `body`, in that order; empty when the template keeps the rules
 */
export function linkTemplateProblems(
  fields: TemplateFields,
  options: { readonly security?: boolean } = {},
): FieldError[] {
  const problems: FieldError[] = [];
  if (fields.channel === 'email' && LINK_PLACEHOLDER.test(fields.subject)) {
    problems.push({
      field: 'subject',
      code: 'link_in_subject',
      message: 'The subject cannot hold {{link}}: keep the link in the message.',
    });
  }
  const { problem } = scanBody(fields.body, { notice: false, security: options.security === true });
  if (problem) problems.push(problem);
  return problems;
}

/** The flags of an event that decide which rules its template keeps (the fields of a registered event definition). */
export interface TemplateEvent {
  /** An email that protects accounts: it keeps its placeholder where the reader sees it and has no `style` attribute. */
  readonly security?: boolean;
  /** Its `link` placeholder is a credential. */
  readonly secretLink?: boolean;
}

/** What the body of a security email does with the placeholder it must keep: it is missing, in the body but not shown, or shown. */
function securityVerdict(event: TemplateEvent, body: string): 'missing' | 'hidden' | 'shown' {
  const link = event.secretLink === true;
  const placeholder = link ? LINK_PLACEHOLDER : CHANGE_PLACEHOLDER;
  if (!placeholder.test(body)) return 'missing';
  const scan = scanBody(body, { notice: !link, security: true });
  // A body the scan refuses cannot be shown to stand anywhere; the scan's own problem is the one to fix first.
  return scan.problem === undefined && (placeholder.test(scan.shown) || (link && scan.carried)) ? 'shown' : 'hidden';
}

/**
 * Checks that the body of a security email keeps what the email protects, where the reader sees it.
 *
 * Why: decision 047: a sign-in, password, invitation or verification email without its link is useless, and a security notice without
 * `{{change}}` does not say what changed; the words around may change, these placeholders may not go. A placeholder inside a comment or a
 * tag, or one the body refuses, does not stand in the text the reader sees, so it does not count. A link mail may also carry its link as the
 * address of its one link.
 *
 * @param event what the event is: `security` and whether its `link` is a credential (`secretLink`)
 * @param fields the channel, subject and body of the template
 * @returns the problem of the `body`, or `undefined` when the event is no security event or the body shows the placeholder
 */
export function securityPlaceholderProblem(event: TemplateEvent, fields: TemplateFields): FieldError | undefined {
  if (event.security !== true) return undefined;
  const verdict = securityVerdict(event, fields.body);
  if (verdict === 'shown') return undefined;
  const link = event.secretLink === true;
  return securityProblem(
    link
      ? verdict === 'missing'
        ? 'link_missing'
        : 'link_hidden'
      : verdict === 'missing'
        ? 'change_missing'
        : 'change_hidden',
  );
}

/**
 * Checks the texts of a template by the flags of its event: the link rules, the notice rules and the placeholder it protects.
 *
 * Why: decision 047: the one check that the template routes (when a text is saved) and the delivery (when a mail is written from a stored
 * text) both make. A link email keeps `{{link}}` where the reader meets it ({@link linkTemplateProblems}); every security email, a notice
 * without a link included, is scanned for comments, declarations, tags outside the list and the `style` and `hidden` attributes, and
 * keeps its placeholder in the text the reader sees ({@link securityPlaceholderProblem}); a notice holds no `href`.
 *
 * @param event the flags of the event
 * @param fields the channel, subject and body of the template (a shipped text passes too)
 * @returns the problems for `subject` and `body`; at most one for the body unless the placeholder is missing as well; empty when the template is fine
 */
export function protectedTemplateProblems(event: TemplateEvent, fields: TemplateFields): FieldError[] {
  const security = event.security === true;
  let problems: FieldError[] = [];
  if (event.secretLink === true) {
    problems = linkTemplateProblems(fields, { security });
  } else if (security) {
    const { problem } = scanBody(fields.body, { notice: true, security: true });
    if (problem) problems = [problem];
  }
  if (!security) return problems;
  const verdict = securityVerdict(event, fields.body);
  if (verdict === 'shown') return problems;
  // A placeholder that is in the body but not shown follows from a body that is refused: one problem is enough.
  if (verdict === 'hidden' && problems.some((problem) => problem.field === 'body')) return problems;
  return [...problems, securityPlaceholderProblem(event, fields)!];
}
