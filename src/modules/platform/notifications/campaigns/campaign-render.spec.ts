// Unit tests of the campaign renderer (feature 23, plan section 6): language pick and fallback, `{{name}}`, the link per audience,
// the RTL HTML part, the Telegram cut, the marketing footer and one-click headers, and the escaping of stored text.
import { describe, expect, it } from 'bun:test';
import { TELEGRAM_MAX_TEXT } from '../template-rules';
import { type RenderableCampaign, linkFor, pickText, renderCampaign } from './campaign-render';

const campaign = (over: Partial<RenderableCampaign> = {}): RenderableCampaign => ({
  content: {
    en: { title: 'Hello {{name}}', body: 'Maintenance on Friday.' },
    ar: { title: 'مرحباً {{name}}', body: 'صيانة يوم الجمعة.' },
  },
  link: { customer: '/account/orders', merchant: '/merchant/wallet', staff: '/system' },
  purpose: 'service',
  ...over,
});

describe('pickText', () => {
  it('picks Arabic for any ar locale and English otherwise', () => {
    expect(pickText(campaign().content, 'ar').locale).toBe('ar');
    expect(pickText(campaign().content, 'ar-JO').locale).toBe('ar');
    expect(pickText(campaign().content, 'en').locale).toBe('en');
    expect(pickText(campaign().content, 'fr').locale).toBe('en');
  });

  it('falls back to English when the campaign has no Arabic', () => {
    const content = { en: { title: 't', body: 'b' }, ar: null };
    expect(pickText(content, 'ar')).toEqual({ text: { title: 't', body: 'b' }, locale: 'en' });
  });
});

describe('linkFor', () => {
  it('joins the base address and the audience path, without a double slash', () => {
    expect(linkFor(campaign().link, 'customer', 'https://shop.example/')).toBe('https://shop.example/account/orders');
    expect(linkFor(campaign().link, 'merchant', 'https://shop.example')).toBe('https://shop.example/merchant/wallet');
  });

  it('answers the path alone without a base, and nothing without a link', () => {
    expect(linkFor(campaign().link, 'customer')).toBe('/account/orders');
    expect(linkFor(null, 'customer', 'https://shop.example')).toBeUndefined();
    expect(linkFor({ merchant: '/merchant' }, 'customer', 'https://shop.example')).toBeUndefined();
  });
});

describe('renderCampaign', () => {
  const base = { name: 'Daniel', audience: 'customer' as const, baseUrl: 'https://shop.example' };

  it('renders an English email with the name, the link and an LTR HTML part', () => {
    const message = renderCampaign(campaign(), { ...base, locale: 'en', channel: 'email' });
    expect(message.subject).toBe('Hello Daniel');
    expect(message.text).toBe('Maintenance on Friday.\n\nhttps://shop.example/account/orders');
    expect(message.html).toStartWith('<div dir="ltr" lang="en">');
    expect(message.headers).toBeUndefined();
    expect(message.locale).toBe('en');
  });

  it('renders an Arabic email right to left', () => {
    const message = renderCampaign(campaign(), { ...base, locale: 'ar', channel: 'email' });
    expect(message.subject).toBe('مرحباً Daniel');
    expect(message.html).toStartWith('<div dir="rtl" lang="ar" style="text-align:right">');
    expect(message.locale).toBe('ar');
  });

  it('gives a staff email no link (the console has no base address)', () => {
    const message = renderCampaign(campaign(), {
      locale: 'en',
      name: 'Rami',
      audience: 'staff',
      channel: 'email',
      baseUrl: undefined,
    });
    expect(message.text).toBe('Maintenance on Friday.');
  });

  it('gives an in-app message the title and body only', () => {
    const message = renderCampaign(campaign(), { ...base, locale: 'en', channel: 'in_app' });
    expect(message).toEqual({ subject: 'Hello Daniel', text: 'Maintenance on Friday.', locale: 'en' });
  });

  it('joins title and body for Telegram and cuts at the Bot API limit', () => {
    const short = renderCampaign(campaign(), { ...base, audience: 'merchant', locale: 'en', channel: 'telegram' });
    expect(short.text).toBe('Hello Daniel\n\nMaintenance on Friday.\nhttps://shop.example/merchant/wallet');
    expect(short.html).toBeUndefined();
    const long = renderCampaign(campaign({ content: { en: { title: 'T', body: 'x'.repeat(5000) } } }), {
      ...base,
      locale: 'en',
      channel: 'telegram',
    });
    expect(long.text).toHaveLength(TELEGRAM_MAX_TEXT);
  });

  it('adds the unsubscribe footer and both one-click headers to a marketing email for a customer', () => {
    const unsubscribe = {
      pageUrl: 'https://shop.example/unsubscribe?token=abc',
      oneClickUrl: 'https://shop.example/store/v1/marketing/unsubscribe/abc',
    };
    const en = renderCampaign(campaign({ purpose: 'marketing' }), {
      ...base,
      locale: 'en',
      channel: 'email',
      unsubscribe,
    });
    expect(en.text).toEndWith('Unsubscribe: https://shop.example/unsubscribe?token=abc');
    expect(en.headers).toEqual({
      'List-Unsubscribe': '<https://shop.example/store/v1/marketing/unsubscribe/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    const ar = renderCampaign(campaign({ purpose: 'marketing' }), {
      ...base,
      locale: 'ar',
      channel: 'email',
      unsubscribe,
    });
    expect(ar.text).toEndWith('لإلغاء الاشتراك: https://shop.example/unsubscribe?token=abc');
  });

  it('adds the preferences footer, and no header, to a marketing email for a merchant', () => {
    const message = renderCampaign(campaign({ purpose: 'marketing' }), {
      ...base,
      audience: 'merchant',
      locale: 'en',
      channel: 'email',
      preferencesUrl: 'https://shop.example/merchant/settings/notifications',
    });
    expect(message.text).toEndWith('Manage notifications: https://shop.example/merchant/settings/notifications');
    expect(message.headers).toBeUndefined();
  });

  it('adds no footer to a service email', () => {
    const message = renderCampaign(campaign(), {
      ...base,
      locale: 'en',
      channel: 'email',
      unsubscribe: { pageUrl: 'p', oneClickUrl: 'o' },
    });
    expect(message.text).not.toContain('Unsubscribe');
    expect(message.headers).toBeUndefined();
  });

  it('escapes stored text in the HTML part, so it can never become markup', () => {
    const message = renderCampaign(campaign({ content: { en: { title: 't', body: '<script>x</script>' } } }), {
      ...base,
      name: '<b>',
      locale: 'en',
      channel: 'email',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('turns line breaks into <br> in the HTML part', () => {
    const message = renderCampaign(campaign({ content: { en: { title: 't', body: 'a\nb' } } }), {
      ...base,
      baseUrl: undefined,
      locale: 'en',
      channel: 'email',
    });
    expect(message.html).toBe('<div dir="ltr" lang="en">a<br>\nb</div>');
  });
});
