// Unit tests of the file name and media type clean-up of the merchants' uploads (B157).
import { describe, expect, it } from 'bun:test';
import { MAX_FILENAME_LENGTH, MAX_UPLOAD_BYTES, cleanMediaType, cleanUploadName } from './file-upload.service';

describe('cleanUploadName', () => {
  it('keeps the base name of a path of either kind', () => {
    expect(cleanUploadName('firmware.bin')).toBe('firmware.bin');
    expect(cleanUploadName('/etc/passwd')).toBe('passwd');
    expect(cleanUploadName('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
    expect(cleanUploadName('a/b\\c/d.txt')).toBe('d.txt');
  });

  it('drops control characters and trims the ends, keeping spaces and other scripts inside', () => {
    expect(cleanUploadName('  my\u0000 file\r\n.zip ')).toBe('my file.zip');
    expect(cleanUploadName('جهاز ٣.zip')).toBe('جهاز ٣.zip');
    expect(cleanUploadName('a\u007fb')).toBe('ab');
  });

  it('drops C1 controls, bidi overrides, zero-width characters and line separators', () => {
    // U+202E (right-to-left override) would make 'invoice\u202Efdp.exe' read as 'invoiceexe.pdf'.
    expect(cleanUploadName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(cleanUploadName('a\u0085b\u200Bc\u2028d\u2066e\uFEFF.txt')).toBe('abcde.txt');
  });

  it('answers `file` when nothing usable is left', () => {
    for (const bad of ['', '   ', '.', '..', 'dir/', '\u0000\u0001', 'x/..'])
      expect(cleanUploadName(bad), JSON.stringify(bad)).toBe('file');
  });

  it('cuts a long name to 200 characters (characters, not bytes)', () => {
    expect(cleanUploadName('a'.repeat(300))).toHaveLength(MAX_FILENAME_LENGTH);
    expect(Array.from(cleanUploadName('😀'.repeat(300)))).toHaveLength(MAX_FILENAME_LENGTH);
  });
});

describe('cleanMediaType', () => {
  it('lower-cases a type/subtype and drops its parameters', () => {
    expect(cleanMediaType('Application/PDF')).toBe('application/pdf');
    expect(cleanMediaType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(cleanMediaType('image/svg+xml')).toBe('image/svg+xml');
    expect(cleanMediaType('application/vnd.android.package-archive')).toBe('application/vnd.android.package-archive');
  });

  it('answers application/octet-stream for anything that is not a type/subtype', () => {
    for (const bad of ['', 'not a type', 'text', 'text/', '/plain', 'a/b/c', 'text/pl ain', '<script>/x']) {
      expect(cleanMediaType(bad), bad).toBe('application/octet-stream');
    }
  });
});

describe('the limits', () => {
  it('are the 25 MiB of B157', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});
