// Unit tests of the SSRF guard assertPublicHttpUrl (decision 023): schemes, credentials, IP literals in every notation,
// host names that resolve to private addresses (fake resolver), mixed answers, DNS failures and the https-only switch.
import { describe, expect, it } from 'bun:test';
import { type HostLookup, UnsafeUrlError, type UnsafeUrlReason, assertPublicHttpUrl } from './public-url';
import { rejectionOf } from '../../../test/support/rejection';

const lookupTable =
  (table: Record<string, string[]>): HostLookup =>
  (hostname) =>
    table[hostname] ? Promise.resolve(table[hostname]) : Promise.reject(new Error('ENOTFOUND'));

const dns = lookupTable({
  'hooks.merchant.example': ['93.184.216.34'],
  'two-addresses.example': ['93.184.216.34', '2606:4700:4700::1111'],
  'evil.example': ['10.0.0.5'],
  'rebind.example': ['93.184.216.34', '127.0.0.1'],
  'metadata.example': ['169.254.169.254'],
  'v6-private.example': ['fd00::1'],
  'mapped.example': ['::ffff:127.0.0.1'],
  'empty.example': [],
});

async function reasonOf(url: string, httpsOnly = false): Promise<UnsafeUrlReason | 'allowed'> {
  try {
    await assertPublicHttpUrl(url, { httpsOnly, lookup: dns });
    return 'allowed';
  } catch (error) {
    if (error instanceof UnsafeUrlError) return error.reason;
    throw error;
  }
}

describe('assertPublicHttpUrl', () => {
  it('accepts a public https URL and returns the parsed URL and the addresses', async () => {
    const result = await assertPublicHttpUrl('https://hooks.merchant.example:8443/path?x=1', {
      httpsOnly: true,
      lookup: dns,
    });
    expect(result.url.href).toBe('https://hooks.merchant.example:8443/path?x=1');
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it('accepts a host with several public addresses, IPv4 and IPv6', async () => {
    expect(await reasonOf('https://two-addresses.example/')).toBe('allowed');
  });

  it('accepts public IP literals (IPv4 and IPv6) without asking DNS', async () => {
    const noDns: HostLookup = () => Promise.reject(new Error('DNS must not be used'));
    for (const url of ['https://93.184.216.34/', 'https://[2606:4700:4700::1111]/hook', 'http://8.8.8.8:8080/']) {
      expect(await assertPublicHttpUrl(url, { httpsOnly: false, lookup: noDns })).toBeDefined();
    }
  });

  describe('scheme', () => {
    it('allows http outside production and refuses it when httpsOnly is set', async () => {
      expect(await reasonOf('http://hooks.merchant.example/', false)).toBe('allowed');
      expect(await reasonOf('http://hooks.merchant.example/', true)).toBe('scheme_not_allowed');
      expect(await reasonOf('https://hooks.merchant.example/', true)).toBe('allowed');
    });

    it('refuses every other scheme', async () => {
      for (const url of [
        'ftp://hooks.merchant.example/',
        'file:///etc/passwd',
        'gopher://hooks.merchant.example/',
        'javascript:alert(1)',
        'data:text/plain,hi',
        'ws://hooks.merchant.example/',
      ]) {
        expect(await reasonOf(url), url).not.toBe('allowed');
      }
      expect(await reasonOf('ftp://hooks.merchant.example/')).toBe('scheme_not_allowed');
    });
  });

  describe('URLs that are not URLs, and credentials', () => {
    it('refuses text that does not parse', async () => {
      for (const url of ['', 'not a url', 'https://', '//no-scheme.example/']) {
        expect(await reasonOf(url), url).toBe('invalid_url');
      }
      // The URL parser reads "https:///path" as host "path": it parses, but nothing public resolves there.
      expect(await reasonOf('https:///path')).toBe('dns_failure');
    });

    it('refuses user names and passwords in the URL (they would end up in logs)', async () => {
      expect(await reasonOf('https://user:secret@hooks.merchant.example/')).toBe('credentials_in_url');
      expect(await reasonOf('https://user@hooks.merchant.example/')).toBe('credentials_in_url');
      expect(await reasonOf('https://:secret@hooks.merchant.example/')).toBe('credentials_in_url');
    });
  });

  describe('IP literals in every notation', () => {
    it('refuses private, loopback, link-local and metadata addresses', async () => {
      for (const url of [
        'http://127.0.0.1/',
        'http://127.1/',
        'http://10.0.0.1:6379/',
        'http://192.168.1.1/',
        'http://172.16.0.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://0.0.0.0/',
        'http://100.64.0.1/',
        'http://224.0.0.1/',
        'http://255.255.255.255/',
      ]) {
        expect(await reasonOf(url), url).toBe('non_public_address');
      }
    });

    it('refuses the alternative IPv4 spellings that the URL parser normalises (decimal, octal, hex, short)', async () => {
      for (const url of [
        'http://2130706433/',
        'http://017700000001/',
        'http://0x7f000001/',
        'http://0x7f.0.0.1/',
        'http://0177.0.0.1/',
        'http://127.0.1/',
        'http://3232235777/',
        'http://0xa9fea9fe/',
      ]) {
        expect(await reasonOf(url), url).toBe('non_public_address');
      }
    });

    it('refuses IPv6 loopback, unique-local, link-local and unspecified addresses', async () => {
      for (const url of [
        'http://[::1]/',
        'http://[::]/',
        'http://[fd00::1]/',
        'http://[fe80::1]/',
        'http://[ff02::1]/',
      ]) {
        expect(await reasonOf(url), url).toBe('non_public_address');
      }
    });

    it('refuses IPv4-mapped IPv6 literals in every spelling', async () => {
      for (const url of [
        'http://[::ffff:127.0.0.1]/',
        'http://[::ffff:7f00:1]/',
        'http://[0:0:0:0:0:ffff:7f00:1]/',
        'http://[::FFFF:10.0.0.1]/',
        'http://[::ffff:169.254.169.254]/',
      ]) {
        expect(await reasonOf(url), url).toBe('non_public_address');
      }
      expect(await reasonOf('http://[::ffff:8.8.8.8]/')).toBe('allowed');
    });
  });

  describe('host names resolved through DNS', () => {
    it('refuses a host name that resolves to a private address', async () => {
      expect(await reasonOf('https://evil.example/')).toBe('non_public_address');
      expect(await reasonOf('https://metadata.example/')).toBe('non_public_address');
      expect(await reasonOf('https://v6-private.example/')).toBe('non_public_address');
      expect(await reasonOf('https://mapped.example/')).toBe('non_public_address');
    });

    it('refuses a host when ANY of its addresses is not public (DNS rebinding with several records)', async () => {
      expect(await reasonOf('https://rebind.example/')).toBe('non_public_address');
    });

    it('refuses localhost through the real system resolver', async () => {
      for (const url of ['http://localhost/', 'http://localhost:6379/', 'https://LOCALHOST/']) {
        expect(await rejectionOf(assertPublicHttpUrl(url, { httpsOnly: false }))).toMatchObject({
          name: 'UnsafeUrlError',
          reason: 'non_public_address',
        });
      }
    });

    it('treats a name that does not resolve, or resolves to nothing, as a DNS failure', async () => {
      expect(await reasonOf('https://no-such-host.example/')).toBe('dns_failure');
      expect(await reasonOf('https://empty.example/')).toBe('dns_failure');
    });

    it('gives up when DNS is too slow', async () => {
      const slow: HostLookup = () => new Promise(() => undefined);
      const started = performance.now();
      expect(
        await rejectionOf(
          assertPublicHttpUrl('https://slow.example/', { httpsOnly: false, lookup: slow, dnsTimeoutMs: 50 }),
        ),
      ).toMatchObject({
        reason: 'dns_failure',
      });
      expect(performance.now() - started).toBeLessThan(500);
    });
  });

  it('puts the reason and the host, but never the path, query or credentials, in the error message', async () => {
    const error: unknown = await assertPublicHttpUrl(
      'https://user:topsecret@evil.example/bot123:SECRET-TOKEN/send?key=abc',
      {
        httpsOnly: false,
        lookup: dns,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeUrlError);
    for (const leak of ['topsecret', 'SECRET-TOKEN', 'key=abc', 'bot123']) {
      expect((error as UnsafeUrlError).message).not.toContain(leak);
    }
  });
});
