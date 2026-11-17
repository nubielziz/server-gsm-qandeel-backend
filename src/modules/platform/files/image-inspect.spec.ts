// Unit tests of the public picture check (feature 22): the three formats with their dimensions, every refusal with its code, the metadata
// and tails that are removed, and a deterministic output that passes the check again.
import { describe, expect, it } from 'bun:test';
import {
  containsText,
  jpegImage,
  lossyWebpHeader,
  pngChunk,
  pngImage,
  webpImage,
} from '../../../../test/support/images';
import { type InspectedImage, PUBLIC_IMAGE_MAX_BYTES, PUBLIC_LOGO_MIN_SIDE, inspectImage } from './image-inspect';

const accepted = (bytes: Uint8Array): InspectedImage => {
  const result = inspectImage(bytes);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result;
};
const codeOf = (bytes: Uint8Array) => {
  const result = inspectImage(bytes);
  return result.ok ? 'ok' : result.code;
};
const text = (value: string) => new TextEncoder().encode(value);

describe('inspectImage: accepted pictures', () => {
  it('reads a JPEG, a PNG and a lossless and lossy WebP with their exact dimensions', () => {
    expect(accepted(jpegImage(640, 480))).toMatchObject({
      format: 'jpeg',
      ext: 'jpg',
      mime: 'image/jpeg',
      width: 640,
      height: 480,
    });
    expect(accepted(pngImage(300, 200))).toMatchObject({
      format: 'png',
      ext: 'png',
      mime: 'image/png',
      width: 300,
      height: 200,
    });
    expect(accepted(webpImage(200, 4096))).toMatchObject({ format: 'webp', ext: 'webp', width: 200, height: 4096 });
    expect(accepted(lossyWebpHeader(1024, 768))).toMatchObject({ format: 'webp', width: 1024, height: 768 });
  });

  it('accepts the edges of the dimension range: 200 and 4096 pixels', () => {
    expect(codeOf(pngImage(200, 200))).toBe('ok');
    expect(codeOf(jpegImage(4096, 200))).toBe('ok');
  });

  it('keeps a picture without metadata byte for byte', () => {
    const jpeg = jpegImage(400, 300);
    expect(accepted(jpeg).bytes).toEqual(jpeg);
    const png = pngImage(400, 300);
    expect(accepted(png).bytes).toEqual(png);
    const webp = webpImage(400, 300);
    expect(accepted(webp).bytes).toEqual(webp);
  });

  it('accepts an upright EXIF orientation (1) and drops the EXIF', () => {
    const result = accepted(jpegImage(400, 300, { exifOrientation: 1 }));
    expect(containsText(result.bytes, 'Exif')).toBe(false);
    expect(containsText(result.bytes, 'GPS')).toBe(false);
  });
});

describe('inspectImage: metadata and tails are removed', () => {
  it('drops EXIF, XMP and comments from a JPEG and cuts the bytes after the end of image', () => {
    const input = jpegImage(400, 300, {
      exifOrientation: 1,
      xmp: true,
      comment: 'shot by Rami',
      tail: text('<script>alert(1)</script>'),
    });
    const { bytes } = accepted(input);
    for (const needle of ['Exif', 'GPS', 'xmpmeta', 'shot by Rami', 'script'])
      expect(containsText(bytes, needle)).toBe(false);
    expect(bytes).toEqual(jpegImage(400, 300));
    expect(bytes.subarray(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
  });

  it('drops text, eXIf and tIME chunks and any private chunk from a PNG and cuts the bytes after IEND', () => {
    const plain = pngImage(300, 300);
    const iend = plain.length - 12;
    const withPrivate = new Uint8Array([
      ...plain.subarray(0, iend),
      ...pngChunk('prVt', text('payload')),
      ...plain.subarray(iend),
    ]);
    expect(accepted(withPrivate).bytes).toEqual(plain);
    const { bytes } = accepted(pngImage(300, 300, { text: 'Rami K.', exif: true, tail: text('PK\u0003\u0004zip') }));
    for (const needle of ['tEXt', 'Rami', 'eXIf', 'tIME', 'GPS', 'PK']) expect(containsText(bytes, needle)).toBe(false);
    expect(bytes).toEqual(plain);
  });

  it('drops EXIF and XMP chunks from a WebP, clears their flags, writes the RIFF size again and cuts the tail', () => {
    const { bytes, width, height } = accepted(webpImage(300, 250, { metadata: true, tail: text('trailing') }));
    expect([width, height]).toEqual([300, 250]);
    for (const needle of ['EXIF', 'XMP ', 'GPS', 'xmpmeta', 'trailing'])
      expect(containsText(bytes, needle)).toBe(false);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    // The VP8X flags byte (after RIFF, size, WEBP, the chunk id and its size) no longer names EXIF (0x08) or XMP (0x04).
    expect(bytes[20]! & 0x0c).toBe(0);
  });

  it('gives the same output for the same input, and the output passes the check again unchanged', () => {
    for (const input of [
      jpegImage(400, 300, { exifOrientation: 1, comment: 'x' }),
      pngImage(300, 300, { text: 'x' }),
      webpImage(300, 300, { metadata: true }),
    ]) {
      const first = accepted(input).bytes;
      expect(accepted(input).bytes).toEqual(first);
      expect(accepted(first).bytes).toEqual(first);
    }
  });
});

describe('inspectImage: refusals', () => {
  it('refuses an empty file and one over 2 MiB', () => {
    expect(codeOf(new Uint8Array())).toBe('empty');
    const big = new Uint8Array(PUBLIC_IMAGE_MAX_BYTES + 1);
    big.set(jpegImage(400, 300));
    expect(codeOf(big)).toBe('too_large');
  });

  it('refuses SVG, GIF, HTML, PDF, BMP and AVIF whatever the name or declared type', () => {
    const others = [
      text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      text('GIF89a\u0001\u0000\u0001\u0000'),
      text('<!doctype html><html><script>alert(1)</script>'),
      text('%PDF-1.7\n'),
      text('BM6\u0000\u0000\u0000'),
      new Uint8Array([0, 0, 0, 0x1c, ...text('ftypavif')]),
    ];
    for (const bytes of others) expect(codeOf(bytes)).toBe('unsupported_type');
  });

  it('refuses truncated and inconsistent files as corrupt', () => {
    const jpeg = jpegImage(400, 300);
    expect(codeOf(jpeg.subarray(0, jpeg.length - 2))).toBe('corrupt');
    expect(codeOf(jpeg.subarray(0, 40))).toBe('corrupt');
    const png = pngImage(300, 300);
    expect(codeOf(png.subarray(0, png.length - 12))).toBe('corrupt');
    const flipped = new Uint8Array(png);
    flipped[40] = flipped[40]! ^ 0xff;
    expect(codeOf(flipped)).toBe('corrupt');
    const webp = webpImage(300, 300);
    expect(codeOf(webp.subarray(0, webp.length - 4))).toBe('corrupt');
    // A RIFF/WEBP header with an unknown first chunk.
    expect(codeOf(new Uint8Array([...text('RIFF'), 12, 0, 0, 0, ...text('WEBPJUNK'), 0, 0, 0, 0]))).toBe('corrupt');
  });

  it('refuses animated PNG and WebP', () => {
    expect(codeOf(pngImage(300, 300, { animated: true }))).toBe('animated');
    expect(codeOf(webpImage(300, 300, { animated: true }))).toBe('animated');
  });

  it('refuses pictures under 200 or over 4096 pixels on a side', () => {
    expect(codeOf(pngImage(199, 300))).toBe('too_small');
    expect(codeOf(jpegImage(300, 199))).toBe('too_small');
    expect(codeOf(webpImage(4097, 300))).toBe('too_large_dimensions');
    expect(codeOf(jpegImage(300, 4097))).toBe('too_large_dimensions');
  });

  it('takes a smaller minimum for a logo: 64 pixels on each side, and says that size when it refuses one', () => {
    const logo = { minSide: PUBLIC_LOGO_MIN_SIDE };
    expect(PUBLIC_LOGO_MIN_SIDE).toBe(64);
    // A square mark and a wide, short wordmark: both too small for a service picture, both fine as a logo.
    for (const picture of [pngImage(128, 128), webpImage(300, 64), jpegImage(64, 64)]) {
      expect(inspectImage(picture)).toMatchObject({ ok: false, code: 'too_small' });
      expect(inspectImage(picture, logo)).toMatchObject({ ok: true });
    }
    expect(inspectImage(pngImage(63, 300), logo)).toEqual({
      ok: false,
      code: 'too_small',
      message: 'The picture must be at least 64 x 64 pixels.',
    });
    expect(inspectImage(pngImage(199, 300))).toMatchObject({
      message: 'The picture must be at least 200 x 200 pixels.',
    });
    // The other limits do not move.
    expect(inspectImage(webpImage(4097, 300), logo)).toMatchObject({ ok: false, code: 'too_large_dimensions' });
  });

  it('refuses a JPEG whose EXIF turns it (orientation 2 to 8), with the message to save it upright', () => {
    for (const orientation of [2, 3, 6, 8])
      expect(codeOf(jpegImage(400, 300, { exifOrientation: orientation }))).toBe('rotated');
    const result = inspectImage(jpegImage(400, 300, { exifOrientation: 6 }));
    expect(result).toEqual({ ok: false, code: 'rotated', message: 'Save the picture upright and upload it again.' });
  });
});
