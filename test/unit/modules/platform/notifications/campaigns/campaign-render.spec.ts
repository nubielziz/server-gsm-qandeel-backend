// Unit tests of the campaign renderer (feature 23, plan section 6): `{{name}}`, the link per audience, the HTML part,
// the marketing footer and one-click headers, and the escaping of stored text. English only (decision 039).
import { describe, expect, it } from 'bun:test';
import {
  type RenderableCampaign,
  linkFor,
  renderCampaign,
} from '@src/modules/platform/notifications/campaigns/campaign-render';

const campaign = (over: Partial<RenderableCampaign> = {}): RenderableCampaign => ({
  content: { title: 'Hello {{name}}', body: 'Maintenance on Friday.' },
  link: { customer: '/account/orders', merchant: '/merchant/wallet', staff: '/system' },
  purpose: 'service',
  ...over,
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
    const message = renderCampaign(campaign(), { ...base, channel: 'email' });
    expect(message.subject).toBe('Hello Daniel');
    expect(message.text).toBe('Maintenance on Friday.\n\nhttps://shop.example/account/orders');
    expect(message.html).toStartWith('<div dir="ltr" lang="en">');
    expect(message.headers).toBeUndefined();
  });

  it('gives a staff email no link (the console has no base address)', () => {
    const message = renderCampaign(campaign(), {
      name: 'Rami',
      audience: 'staff',
      channel: 'email',
      baseUrl: undefined,
    });
    expect(message.text).toBe('Maintenance on Friday.');
  });

  it('gives an in-app message the title and body only', () => {
    const message = renderCampaign(campaign(), { ...base, channel: 'in_app' });
    expect(message).toEqual({ subject: 'Hello Daniel', text: 'Maintenance on Friday.' });
  });

  it('adds the unsubscribe footer and both one-click headers to a marketing email for a customer', () => {
    const unsubscribe = {
      pageUrl: 'https://shop.example/unsubscribe?token=abc',
      oneClickUrl: 'https://shop.example/store/v1/marketing/unsubscribe/abc',
    };
    const message = renderCampaign(campaign({ purpose: 'marketing' }), { ...base, channel: 'email', unsubscribe });
    expect(message.text).toEndWith('Unsubscribe: https://shop.example/unsubscribe?token=abc');
    expect(message.headers).toEqual({
      'List-Unsubscribe': '<https://shop.example/store/v1/marketing/unsubscribe/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('adds the preferences footer, and no header, to a marketing email for a merchant', () => {
    const message = renderCampaign(campaign({ purpose: 'marketing' }), {
      ...base,
      audience: 'merchant',
      channel: 'email',
      preferencesUrl: 'https://shop.example/merchant/settings/notifications',
    });
    expect(message.text).toEndWith('Manage notifications: https://shop.example/merchant/settings/notifications');
    expect(message.headers).toBeUndefined();
  });

  it('adds no footer to a service email', () => {
    const message = renderCampaign(campaign(), {
      ...base,
      channel: 'email',
      unsubscribe: { pageUrl: 'p', oneClickUrl: 'o' },
    });
    expect(message.text).not.toContain('Unsubscribe');
    expect(message.headers).toBeUndefined();
  });

  it('escapes stored text in the HTML part, so it can never become markup', () => {
    const message = renderCampaign(campaign({ content: { title: 't', body: '<script>x</script>' } }), {
      ...base,
      name: '<b>',
      channel: 'email',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('turns line breaks into <br> in the HTML part', () => {
    const message = renderCampaign(campaign({ content: { title: 't', body: 'a\nb' } }), {
      ...base,
      baseUrl: undefined,
      channel: 'email',
    });
    expect(message.html).toBe('<div dir="ltr" lang="en">a<br>\nb</div>');
  });
});
