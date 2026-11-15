// Unit test of the Arabic twins of the support templates (feature 23, plan section 9.4): the 5 Arabic rows live in the platform's list
// (`ARABIC_DEFAULT_TEMPLATES`, as migration 0027 shipped them) and, with the conversation link migration 0032 appends to the merchant's
// reply (feature 28), must match this module's English rows, event, channel, audience and placeholders.
import { describe, expect, it } from 'bun:test';
import { ARABIC_DEFAULT_TEMPLATES } from '../../platform';
import { SUPPORT_DEFAULT_TEMPLATES, withConversationLink } from './support-templates';

const keyOf = (t: { event: string; channel: string; audience: string }) => `${t.event}|${t.channel}|${t.audience}`;
const placeholders = (t: { subject: string; body: string }): string[] =>
  [
    ...new Set(
      [...`${t.subject}\n${t.body}`.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]!),
    ),
  ].sort();

describe('the Arabic support templates', () => {
  it('give every English support template an Arabic twin with the same placeholders', () => {
    const arabic = new Map(ARABIC_DEFAULT_TEMPLATES.map((t) => [keyOf(t), withConversationLink(t)]));
    expect(SUPPORT_DEFAULT_TEMPLATES).toHaveLength(5);
    for (const english of SUPPORT_DEFAULT_TEMPLATES) {
      const twin = arabic.get(keyOf(english));
      expect(twin, keyOf(english)).toBeDefined();
      expect(placeholders(twin!), keyOf(english)).toEqual(placeholders(english));
    }
  });
});
