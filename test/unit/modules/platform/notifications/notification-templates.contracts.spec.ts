// Unit test of the notification-template contract text: what the `isActive` switch promises must match the delivery, which reads the one
// template of an event, channel and audience and sends nothing while it is off (decision 039: templates have no language to fall back on).
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  createNotificationTemplate,
  listNotificationTemplates,
  updateNotificationTemplate,
} from '@src/modules/platform/notifications/notification-templates.contracts';

/** The `isActive` description of the template row, as it reaches the OpenAPI document. */
function isActiveText(): string {
  const row = listNotificationTemplates.success.schema as z.ZodObject<{ isActive: z.ZodBoolean }>;
  return row.shape.isActive.description ?? '';
}

describe('notification template contract', () => {
  it('says that a template that is off stops the message (`template_off`), with nothing standing in for it', () => {
    const text = isActiveText();
    expect(text).toContain('Off means the message is not sent (`template_off`)');
    expect(text).toContain('nothing stands in for it');
    // The fallback of the time of two languages is gone.
    expect(text).not.toContain('English');
  });

  it('has no language field on the row or in the create and change bodies', () => {
    const keysOf = (schema: unknown) => Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape);
    expect(keysOf(listNotificationTemplates.success.schema)).not.toContain('locale');
    expect(keysOf(createNotificationTemplate.body)).not.toContain('locale');
    expect(keysOf(updateNotificationTemplate.body)).not.toContain('locale');
  });
});
