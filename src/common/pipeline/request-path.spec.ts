// Unit tests of requestPath: the route template wins, an unknown route is judged by its decoded path, never by its raw
// spelling.
import { describe, expect, it } from 'bun:test';
import { requestPath } from './request-path';

describe('requestPath', () => {
  it('uses the route template of a matched route', () => {
    expect(requestPath({ url: '/admin/staff/12?x=1', routeOptions: { url: '/admin/staff/:id' } })).toBe(
      '/admin/staff/:id',
    );
  });

  it('uses the decoded path of an unknown route, without query string or fragment', () => {
    expect(requestPath({ url: '/store/v1/nope?a=b' })).toBe('/store/v1/nope');
    expect(requestPath({ url: '/store/v1/nope#frag', routeOptions: {} })).toBe('/store/v1/nope');
    expect(requestPath({ url: '/health', routeOptions: { url: undefined } })).toBe('/health');
    expect(requestPath({ url: '/x/y', routeOptions: { url: '' } })).toBe('/x/y');
    expect(requestPath({ url: '/x/y', routeOptions: { url: '*' } })).toBe('/x/y');
  });

  it('decodes percent-escapes the way the router does, so an escaped spelling cannot hide a surface', () => {
    expect(requestPath({ url: '/%61dmin/staff' })).toBe('/admin/staff');
    expect(requestPath({ url: '/st%6Fre/v1/me' })).toBe('/store/v1/me');
  });

  it('leaves an escaped slash alone and survives a malformed escape', () => {
    expect(requestPath({ url: '/admin%2Fstaff' })).toBe('/admin%2Fstaff');
    expect(requestPath({ url: '/admin/%E0%A4%A' })).toBe('/admin/%E0%A4%A');
  });
});
