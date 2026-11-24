// Unit tests of whose session cookie a multipart request must carry before its body is read (decision 053).
import { describe, expect, it } from 'bun:test';
import { uploadSessionSubject } from '@src/modules/identity/security/upload-session.hook';
// Importing a contracts file registers its routes in the process-wide registry the hook reads.
import '@src/modules/platform/contracts/files.contracts';
import '@src/modules/support/contracts/ticket-live.contracts';
import '@src/modules/orders/contracts/dhru.contracts';
import '@src/modules/storefront/contracts/listings.contracts';
import '@src/modules/money/contracts/gateways.contracts';

const MULTIPART = 'multipart/form-data; boundary=x';

describe('uploadSessionSubject', () => {
  it('names the audience of each session-cookie upload route', () => {
    expect(uploadSessionSubject('/client/files', 'POST', MULTIPART)).toBe('client');
    expect(uploadSessionSubject('/store/v1/files', 'POST', MULTIPART)).toBe('customer');
    expect(uploadSessionSubject('/admin/service-listings/:id/image', 'POST', MULTIPART)).toBe('staff');
    expect(uploadSessionSubject('/admin/payment-gateways/:id/logo', 'POST', MULTIPART)).toBe('staff');
    expect(uploadSessionSubject('/admin/support-tickets/:id/files', 'POST', MULTIPART)).toBe('staff');
  });

  it('leaves the routes that sign in another way to their own bounds', () => {
    expect(uploadSessionSubject('/api/index.php', 'POST', MULTIPART)).toBeUndefined();
    expect(uploadSessionSubject('/api/index.php', 'POST', MULTIPART)).toBeUndefined();
    expect(uploadSessionSubject('/store/v1/tickets/:token/files', 'POST', MULTIPART)).toBeUndefined();
  });

  it('judges only a multipart body of a route that takes one', () => {
    expect(uploadSessionSubject('/client/files', 'POST', 'application/json')).toBeUndefined();
    expect(uploadSessionSubject('/client/files', 'POST', undefined)).toBeUndefined();
    expect(uploadSessionSubject('/admin/staff', 'POST', MULTIPART)).toBeUndefined();
    expect(uploadSessionSubject(undefined, 'POST', MULTIPART)).toBeUndefined();
    expect(uploadSessionSubject('/client/files', 'POST', 'Multipart/Form-Data; boundary=x')).toBe('client');
  });

  it('reads the media type the way the body parser does: leading whitespace does not skip the stage', () => {
    // Fastify drops leading whitespace before it picks the parser, so a type that starts with U+00A0 still reaches the multipart parser.
    expect(uploadSessionSubject('/client/files', 'POST', '\u00a0multipart/form-data; boundary=x')).toBe('client');
    expect(uploadSessionSubject('/store/v1/files', 'POST', '\u000bMultipart/Form-Data; boundary=x')).toBe('customer');
    expect(uploadSessionSubject('/admin/support-tickets/:id/files', 'POST', '\u00a0\u00a0multipart/form-data')).toBe(
      'staff',
    );
    expect(uploadSessionSubject('/client/files', 'POST', '\u00a0application/json')).toBeUndefined();
  });

  it('reads HEAD as GET, like the per-IP stage does', () => {
    // No GET contract exists on an upload route, so a HEAD request is not judged (and a POST is).
    expect(uploadSessionSubject('/client/files', 'HEAD', MULTIPART)).toBeUndefined();
    expect(uploadSessionSubject('/client/files', 'GET', MULTIPART)).toBeUndefined();
  });
});
