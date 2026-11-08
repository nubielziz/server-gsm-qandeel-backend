// Unit test of the notification-template contract text: what the `isActive` switch promises must match the delivery's English fallback.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { listNotificationTemplates } from './notification-templates.contracts';

/** The `isActive` description of the template row, as it reaches the OpenAPI document. */
function isActiveText(): string {
  const row = listNotificationTemplates.success.schema as z.ZodObject<{ isActive: z.ZodBoolean }>;
  return row.shape.isActive.description ?? '';
}

describe('notification template contract', () => {
  it('says that a template that is off falls back to the English one, not that the message is not sent', () => {
    const text = isActiveText();
    expect(text).toContain('English');
    expect(text).not.toContain('Off means the message is not sent');
  });

  it('says the message is not sent only when neither this language nor English is on', () => {
    const text = isActiveText();
    expect(text).toContain('is not sent (`template_off`) when neither is on');
    expect(text).toContain('Turning the English template off also stops English messages');
    // The old claim, that any other switched-on template of the event keeps the message going, is wrong.
    expect(text).not.toContain('only when no template of the event, channel and audience is on');
  });
});
