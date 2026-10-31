// Unit tests of the IP audience mapping: which rule scopes reach which path, and the probe paths nothing judges.
import { describe, expect, it } from 'bun:test';
import { ipAudienceOf } from './ip-audience';

describe('ipAudienceOf', () => {
  it('maps each surface to the audience of the rule scopes', () => {
    expect(ipAudienceOf('/admin/staff/:id')).toBe('admin');
    expect(ipAudienceOf('/admin')).toBe('admin');
    expect(ipAudienceOf('/store/v1/checkout-sessions/:token/pay')).toBe('store');
    expect(ipAudienceOf('/v1/orders')).toBe('api');
    expect(ipAudienceOf('/api/index.php')).toBe('api');
  });

  it('leaves the merchant portal, incoming webhooks and the documentation to the "all" rules', () => {
    expect(ipAudienceOf('/client/orders')).toBe('other');
    expect(ipAudienceOf('/webhooks/payments/:gateway')).toBe('other');
    expect(ipAudienceOf('/docs')).toBe('other');
    expect(ipAudienceOf('/openapi.json')).toBe('other');
    expect(ipAudienceOf('/reference/openapi.json')).toBe('other');
    expect(ipAudienceOf('/nope')).toBe('other');
  });

  it('does not mistake a longer name for a surface', () => {
    expect(ipAudienceOf('/administrator')).toBe('other');
    expect(ipAudienceOf('/store/v10/x')).toBe('other');
    expect(ipAudienceOf('/v1x/orders')).toBe('other');
  });

  it('never judges the probes', () => {
    expect(ipAudienceOf('/health')).toBeUndefined();
    expect(ipAudienceOf('/metrics')).toBeUndefined();
    expect(ipAudienceOf('/health/deep')).toBe('other');
  });
});
