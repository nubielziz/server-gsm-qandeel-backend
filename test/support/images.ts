// Small, valid test pictures built in code (feature 22, the public service images): a flat grey baseline JPEG, a flat PNG and a flat
// lossless WebP of any size, with optional metadata, animation markers and tails, so no binary fixture has to be kept in the repository.
import { deflateSync } from 'node:zlib';

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

function concat(parts: readonly (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : new Uint8Array(part)));
  const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of arrays) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

const segment = (marker: number, payload: Uint8Array | number[]) =>
  concat([[0xff, marker, ...be16(payload.length + 2)], payload]);

/** An `APP1` EXIF payload with IFD0 holding the orientation and a GPS-like ASCII tag (what must never reach the public). */
function exifPayload(orientation: number): Uint8Array {
  const text = ascii('GPS 31.95N 35.91E\0');
  // TIFF big endian: header (8), IFD0 at 8 with 2 entries (2 + 24 + 4), then the ASCII value.
  const valueOffset = 8 + 2 + 2 * 12 + 4;
  return concat([
    ascii('Exif\0\0'),
    ascii('MM'),
    [0x00, 0x2a],
    be32(8),
    be16(2),
    [...be16(0x0112), ...be16(3), ...be32(1), ...be16(orientation), 0, 0],
    [...be16(0x010e), ...be16(2), ...be32(text.length), ...be32(valueOffset)],
    be32(0),
    text,
  ]);
}

/** Options of {@link jpegImage}. */
export interface JpegOptions {
  /** Adds an EXIF segment with this orientation (and a GPS-like text). */
  readonly exifOrientation?: number;
  /** Adds an XMP `APP1` segment. */
  readonly xmp?: boolean;
  /** Adds a `COM` comment. */
  readonly comment?: string;
  /** Bytes appended after the end of image. */
  readonly tail?: Uint8Array;
}

/**
 * A flat grey baseline JPEG: one component, a quantisation table of ones, one-code Huffman tables (DC difference 0, end of block), so
 * every 8x8 block is two bits.
 *
 * @param width the width in pixels
 * @param height the height in pixels
 * @param options metadata and a tail to add
 * @returns the file bytes
 */
export function jpegImage(width: number, height: number, options: JpegOptions = {}): Uint8Array {
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = blocks * 2;
  const data = new Uint8Array(Math.ceil(bits / 8));
  // Pad the last byte with ones, as the standard asks.
  const padBits = data.length * 8 - bits;
  if (padBits > 0) data[data.length - 1] = (1 << padBits) - 1;
  const counts = (n: number) => [1, ...Array<number>(15).fill(0), n];
  return concat([
    [0xff, 0xd8],
    segment(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    options.exifOrientation === undefined ? [] : segment(0xe1, exifPayload(options.exifOrientation)),
    options.xmp ? segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>author</x:xmpmeta>')) : [],
    options.comment === undefined ? [] : segment(0xfe, ascii(options.comment)),
    segment(0xdb, [0x00, ...Array<number>(64).fill(1)]),
    segment(0xc0, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]),
    segment(0xc4, [0x00, ...counts(0)]),
    segment(0xc4, [0x10, ...counts(0)]),
    segment(0xda, [1, 1, 0x00, 0, 63, 0]),
    data,
    [0xff, 0xd9],
    options.tail ?? [],
  ]);
}

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk with its CRC. */
export function pngChunk(type: string, data: Uint8Array | number[] = []): Uint8Array {
  const body = concat([ascii(type), data]);
  return concat([be32(body.length - 4), body, be32(crc32(body))]);
}

/** Options of {@link pngImage}. */
export interface PngOptions {
  /** Adds a `tEXt` chunk with this text. */
  readonly text?: string;
  /** Adds an `eXIf` and a `tIME` chunk. */
  readonly exif?: boolean;
  /** Adds an `acTL` chunk (an animated PNG). */
  readonly animated?: boolean;
  /** Bytes appended after `IEND`. */
  readonly tail?: Uint8Array;
}

/**
 * A flat grey 8-bit greyscale PNG.
 *
 * @param width the width in pixels
 * @param height the height in pixels
 * @param options metadata, animation and a tail to add
 * @returns the file bytes
 */
export function pngImage(width: number, height: number, options: PngOptions = {}): Uint8Array {
  const raw = new Uint8Array((width + 1) * height).fill(0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return concat([
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', [...be32(width), ...be32(height), 8, 0, 0, 0, 0]),
    options.animated ? pngChunk('acTL', [...be32(2), ...be32(0)]) : [],
    options.text === undefined ? [] : pngChunk('tEXt', ascii(`Author\0${options.text}`)),
    options.exif ? pngChunk('eXIf', exifPayload(1).subarray(6)) : [],
    options.exif ? pngChunk('tIME', [...be16(2026), 11, 10, 12, 0, 0]) : [],
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND'),
    options.tail ?? [],
  ]);
}

/** Options of {@link webpImage}. */
export interface WebpOptions {
  /** Wraps the bitstream in an extended file with `EXIF` and `XMP ` chunks (and their `VP8X` flags). */
  readonly metadata?: boolean;
  /** An extended file with the animation flag and an `ANIM` chunk. */
  readonly animated?: boolean;
  /** Bytes appended after the RIFF data. */
  readonly tail?: Uint8Array;
}

/** A flat lossless bitstream: five one-symbol prefix codes, so the pixels take no bits. */
function vp8l(width: number, height: number): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, count: number) => {
    for (let i = 0; i < count; i++) bits.push((value >>> i) & 1);
  };
  put(width - 1, 14);
  put(height - 1, 14);
  put(0, 1); // alpha not used
  put(0, 3); // version
  put(0, 1); // no transform
  put(0, 1); // no colour cache
  put(0, 1); // no meta prefix codes
  for (const symbol of [0x80, 0x80, 0x80, 0xff, 0]) {
    put(1, 1); // simple code
    put(0, 1); // one symbol
    put(1, 1); // eight-bit symbol
    put(symbol, 8);
  }
  const out = new Uint8Array(1 + Math.ceil(bits.length / 8));
  out[0] = 0x2f;
  bits.forEach((bit, i) => {
    out[1 + (i >> 3)]! |= bit << (i & 7);
  });
  return out;
}

const riffChunk = (id: string, data: Uint8Array | number[]) => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return concat([ascii(id), le32(bytes.length), bytes, bytes.length % 2 ? [0] : []]);
};

/**
 * A flat lossless WebP.
 *
 * @param width the width in pixels
 * @param height the height in pixels
 * @param options metadata, animation and a tail to add
 * @returns the file bytes
 */
export function webpImage(width: number, height: number, options: WebpOptions = {}): Uint8Array {
  const bitstream = riffChunk('VP8L', vp8l(width, height));
  let body: Uint8Array;
  if (options.metadata || options.animated) {
    const flags = (options.metadata ? 0x08 | 0x04 : 0) | (options.animated ? 0x02 : 0);
    body = concat([
      riffChunk('VP8X', [flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]),
      options.animated ? riffChunk('ANIM', [0, 0, 0, 0, ...le16(0)]) : [],
      bitstream,
      options.metadata ? riffChunk('EXIF', exifPayload(1).subarray(6)) : [],
      options.metadata ? riffChunk('XMP ', ascii('<x:xmpmeta>author</x:xmpmeta>')) : [],
    ]);
  } else body = bitstream;
  return concat([ascii('RIFF'), le32(body.length + 4), ascii('WEBP'), body, options.tail ?? []]);
}

/**
 * The header of a lossy (`VP8 `) WebP with a stub key frame: enough for the dimension check, not for a decoder.
 *
 * @param width the width in pixels
 * @param height the height in pixels
 * @returns the file bytes
 */
export function lossyWebpHeader(width: number, height: number): Uint8Array {
  const frame = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0, 0, 0];
  const body = riffChunk('VP8 ', frame);
  return concat([ascii('RIFF'), le32(body.length + 4), ascii('WEBP'), body]);
}

/** True when `needle` occurs in `haystack` (a metadata string that must be gone). */
export function containsText(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'latin1'));
}
