// Unit tests of the attachment rules of the support chat (feature 28, rule 8): the content is recognised by its first bytes, an upload is
// judged by size, declared type and content, and a file a message wants to carry must be the sender's own PDF, JPEG or PNG of 5 MiB.
import { describe, expect, it } from 'bun:test';
import {
  MAX_ATTACHMENT_BYTES,
  attachProblem,
  sniffAttachment,
  ticketUploadArea,
  uploadProblem,
} from '@src/modules/support/domain/attachment-rules';

const bytes = (...values: number[]) => new Uint8Array(values);
const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
/** The start of a Windows program (`MZ`), renamed by its sender. */
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00);

describe('sniffAttachment', () => {
  it('recognises a PDF, a JPEG and a PNG by their magic bytes', () => {
    expect(sniffAttachment(PDF)).toBe('application/pdf');
    expect(sniffAttachment(JPEG)).toBe('image/jpeg');
    expect(sniffAttachment(PNG)).toBe('image/png');
  });

  it('recognises nothing in a renamed program, an empty file or a signature cut short', () => {
    expect(sniffAttachment(EXE)).toBeUndefined();
    expect(sniffAttachment(new Uint8Array())).toBeUndefined();
    expect(sniffAttachment(bytes(0x25, 0x50, 0x44, 0x46))).toBeUndefined();
    expect(sniffAttachment(bytes(0x89, 0x50, 0x4e, 0x47))).toBeUndefined();
  });
});

describe('uploadProblem', () => {
  it('accepts a declared type that the content agrees with', () => {
    expect(uploadProblem('application/pdf', PDF)).toBeUndefined();
    expect(uploadProblem('image/jpeg', JPEG)).toBeUndefined();
    expect(uploadProblem('image/png', PNG)).toBeUndefined();
  });

  it('refuses an empty file, one over 5 MiB, another declared type and a content that disagrees', () => {
    expect(uploadProblem('application/pdf', new Uint8Array())).toBe('empty');
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(PDF);
    expect(uploadProblem('application/pdf', big)).toBe('too_large');
    expect(uploadProblem('application/x-msdownload', EXE)).toBe('type');
    // A program renamed to `invoice.pdf` and declared a PDF is refused by its content.
    expect(uploadProblem('application/pdf', EXE)).toBe('type');
    // A real PNG declared a JPEG is refused too: the two must agree.
    expect(uploadProblem('image/jpeg', PNG)).toBe('type');
  });

  it('takes a file of exactly 5 MiB', () => {
    const exact = new Uint8Array(MAX_ATTACHMENT_BYTES);
    exact.set(PNG);
    expect(uploadProblem('image/png', exact)).toBeUndefined();
  });
});

describe('attachProblem', () => {
  const customer = { type: 'customer', id: 7 } as const;
  const own = { ownerType: 'customer', ownerId: 7, area: 'tickets-42', mime: 'application/pdf', size: 1000 };

  it('accepts the sender’s own file of an allowed type and size', () => {
    expect(attachProblem(own, customer)).toBeUndefined();
  });

  it('refuses an unknown id, another owner’s file, another type and a file over 5 MiB', () => {
    expect(attachProblem(undefined, customer)).toBe('unknown_file');
    expect(attachProblem({ ...own, ownerId: 8 }, customer)).toBe('not_yours');
    expect(attachProblem({ ...own, ownerType: 'client' }, customer)).toBe('not_yours');
    expect(attachProblem({ ...own, mime: 'application/zip' }, customer)).toBe('type');
    expect(attachProblem({ ...own, size: MAX_ATTACHMENT_BYTES + 1 }, customer)).toBe('too_large');
  });

  it('with an area, accepts only the files of that area: another area of the same owner is not_yours', () => {
    const area = ticketUploadArea(42);
    expect(area).toBe('tickets-42');
    expect(attachProblem(own, customer, area)).toBeUndefined();
    expect(attachProblem({ ...own, area: 'receipts' }, customer, area)).toBe('not_yours');
    expect(attachProblem({ ...own, area: 'files' }, customer, area)).toBe('not_yours');
    expect(attachProblem({ ...own, area: 'tickets-43' }, customer, area)).toBe('not_yours');
    expect(attachProblem({ ...own, area: 'tickets' }, customer, area)).toBe('not_yours');
    // Without an area (a signed-in requester, staff) the owner alone decides.
    expect(attachProblem({ ...own, area: 'receipts' }, customer)).toBeUndefined();
    expect(attachProblem(undefined, customer, area)).toBe('unknown_file');
  });
});
