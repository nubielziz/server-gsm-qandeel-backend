// The in-app texts of event items (feature 23, plan section 9.2): per audience and event, a category, an optional site link and the
// title and body in English and Arabic, filled from the event's own variables at read time.
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { NotificationAudience, NotificationInboxCategory } from '../../db/schema';
import { NotificationEventRegistry } from '../notification-events';
import { placeholdersOf, renderText } from '../template-rules';
import { BUILT_IN_INBOX_TEXTS } from './built-in-inbox-texts';

/** The title and body of one language. */
export interface InboxText {
  readonly title: string;
  readonly body: string;
}

/** The in-app text of one event for one audience. */
export interface InboxTextDefinition {
  readonly audience: NotificationAudience;
  readonly event: string;
  readonly category: NotificationInboxCategory;
  /** A site-relative path (no language prefix), or none. */
  readonly link?: string;
  readonly texts: { readonly en: InboxText; readonly ar: InboxText };
}

/**
 * The registry of in-app texts.
 *
 * Why: S5 and S9: the in-app text of an event is defined in code next to the event, in both languages; an event without a text
 * makes no in-app item (events whose variables hold a secret, such as sign-in links, never register one). A text may use only its
 * event's variables: the check runs once every module registered its events (`onApplicationBootstrap`) and fails the boot.
 */
@Injectable()
export class InboxTextRegistry implements OnApplicationBootstrap {
  private readonly texts = new Map<string, InboxTextDefinition>();

  constructor(private readonly events: NotificationEventRegistry) {
    for (const definition of BUILT_IN_INBOX_TEXTS) this.register(definition);
  }

  /**
   * Adds a text.
   *
   * @param definition the audience, event, category, link and texts
   * @throws {Error} when the audience and event already have a text, or a text is empty (boot-time mistakes)
   */
  register(definition: InboxTextDefinition): void {
    const id = `${definition.audience}:${definition.event}`;
    if (this.texts.has(id))
      throw new Error(`An in-app text for "${definition.event}" (${definition.audience}) exists.`);
    for (const locale of ['en', 'ar'] as const) {
      const text = definition.texts[locale];
      if (text.title.trim() === '' || text.body.trim() === '')
        throw new Error(`The ${locale} in-app text of "${definition.event}" (${definition.audience}) is empty.`);
    }
    this.texts.set(id, definition);
  }

  /**
   * Finds the text of an event.
   *
   * @param audience who reads it
   * @param event the event key
   * @returns the definition, or `undefined` when the event makes no in-app item
   */
  get(audience: NotificationAudience, event: string): InboxTextDefinition | undefined {
    return this.texts.get(`${audience}:${event}`);
  }

  /**
   * Lists every text.
   *
   * @returns the definitions in registration order
   */
  list(): readonly InboxTextDefinition[] {
    return [...this.texts.values()];
  }

  /**
   * Checks every text against the event registry.
   *
   * @throws {Error} when a text's event is not registered for its audience, or a text uses a placeholder the event does not offer
   */
  onApplicationBootstrap(): void {
    for (const problem of inboxTextProblems(this.list(), this.events)) throw new Error(problem);
  }
}

/**
 * Lists what is wrong with a set of in-app texts.
 *
 * @param texts the texts
 * @param events the event registry
 * @returns one sentence per problem (empty when all is well)
 */
export function inboxTextProblems(texts: readonly InboxTextDefinition[], events: NotificationEventRegistry): string[] {
  const problems: string[] = [];
  for (const text of texts) {
    const definition = events.get(text.event, text.audience);
    if (!definition) {
      problems.push(`The in-app text of "${text.event}" names an event that ${text.audience} does not have.`);
      continue;
    }
    for (const locale of ['en', 'ar'] as const) {
      const used = placeholdersOf(`${text.texts[locale].title}\n${text.texts[locale].body}`);
      const unknown = used.filter((name) => !definition.variables.includes(name));
      if (unknown.length > 0)
        problems.push(
          `The ${locale} in-app text of "${text.event}" uses ${unknown.join(', ')}, which the event lacks.`,
        );
    }
  }
  return problems;
}

/**
 * Renders an event item's text.
 *
 * @param definition the registered text
 * @param locale the reader's language (`ar...` reads Arabic, anything else English)
 * @param variables the item's stored values
 * @returns the title, body and link (plain text; never HTML)
 */
export function renderInboxText(
  definition: InboxTextDefinition,
  locale: string,
  variables: Readonly<Record<string, string>>,
): { title: string; body: string; link: string | null; locale: 'en' | 'ar' } {
  const picked = locale.startsWith('ar') ? 'ar' : 'en';
  const text = definition.texts[picked];
  return {
    title: renderText(text.title, variables, 'text'),
    body: renderText(text.body, variables, 'text'),
    link: definition.link ?? null,
    locale: picked,
  };
}
