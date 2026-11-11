// The content check of a public service picture (feature 22): type from the magic bytes only, a walk of the container without decoding
// pixels, the size and dimension limits, and a rewrite that drops metadata (EXIF, XMP, IPTC, text chunks) and anything after the end marker.

/** The largest picture accepted: 2 MiB. */
export const PUBLIC_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** The smallest width and height accepted, in pixels. */
export const PUBLIC_IMAGE_MIN_SIDE = 200;
/** The largest width and height accepted, in pixels. */
export const PUBLIC_IMAGE_MAX_SIDE = 4096;

/** The three raster formats a public picture may have. */
export type PublicImageFormat = 'jpeg' | 'png' | 'webp';

/**
 * Why a picture was refused; the code of the `422` field error on `file` (`too_large` becomes `413`).
 *
 * Why: the console shows the server's message under the file control, and the codes let a client tell the cases apart.
 */
export type ImageRefusalCode =
  | 'empty'
  | 'too_large'
  | 'unsupported_type'
  | 'corrupt'
  | 'animated'
  | 'too_small'
  | 'too_large_dimensions'
  | 'rotated';

/** An accepted picture: its format, dimensions and the cleaned bytes to store. */
export interface InspectedImage {
  readonly ok: true;
  readonly format: PublicImageFormat;
  readonly ext: 'jpg' | 'png' | 'webp';
  readonly mime: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly width: number;
  readonly height: number;
  /** The picture without its metadata and without bytes after the end marker. */
  readonly bytes: Uint8Array;
}

/** A refused picture. */
export interface RefusedImage {
  readonly ok: false;
  readonly code: ImageRefusalCode;
  readonly message: string;
}

const MESSAGES: Record<ImageRefusalCode, string> = {
  empty: 'The file is empty.',
  too_large: 'The picture is larger than 2 MiB.',
  unsupported_type: 'Upload a JPEG, PNG or WebP picture.',
  corrupt: 'The picture is damaged or incomplete. Save it again and upload it.',
  animated: 'Upload a still picture, not an animation.',
  too_small: `The picture must be at least ${PUBLIC_IMAGE_MIN_SIDE} x ${PUBLIC_IMAGE_MIN_SIDE} pixels.`,
  too_large_dimensions: `The picture must be at most ${PUBLIC_IMAGE_MAX_SIDE} x ${PUBLIC_IMAGE_MAX_SIDE} pixels.`,
  rotated: 'Save the picture upright and upload it again.',
};

const refuse = (code: ImageRefusalCode): RefusedImage => ({ ok: false, code, message: MESSAGES[code] });

/** Thrown inside a walk when the structure is truncated or inconsistent; turned into `corrupt`. */
class Corrupt extends Error {}
/** Thrown inside a walk for an animation; turned into `animated`. */
class Animated extends Error {}

/** A walked picture before the dimension checks. */
interface Walked {
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  /** The EXIF orientation of a JPEG (1 when none). */
  readonly orientation: number;
}

/**
 * Checks a picture a staff member uploads for a public service page and returns it without its metadata.
 *
 * Why: feature 22 (§2.6 of its plan): the picture is served to everyone from the API under its SHA-256, so it must be what it claims and
 * carry nothing private. The type comes from the magic bytes only (the declared type and the name are ignored), so an SVG, an HTML page or a
 * polyglot never passes as a picture; the container is walked without decoding pixels (no memory bomb), the metadata segments that hold
 * GPS positions, camera serials and authors are removed, and the bytes after the end marker are cut. A JPEG with an EXIF rotation is
 * refused, because dropping the EXIF would show it turned. The rules apply in this order: size, type, structure (and animation),
 * dimensions, rotation. The output is a pure function of the input.
 *
 * @param input the uploaded bytes
 * @returns the accepted picture with its cleaned bytes, or the refusal with its code and message
 */
export function inspectImage(input: Uint8Array): InspectedImage | RefusedImage {
  if (input.length === 0) return refuse('empty');
  if (input.length > PUBLIC_IMAGE_MAX_BYTES) return refuse('too_large');
  const format = sniff(input);
  if (format === undefined) return refuse('unsupported_type');
  let walked: Walked;
  try {
    walked = format === 'jpeg' ? walkJpeg(input) : format === 'png' ? walkPng(input) : walkWebp(input);
  } catch (error) {
    if (error instanceof Animated) return refuse('animated');
    if (error instanceof Corrupt || error instanceof RangeError) return refuse('corrupt');
    throw error;
  }
  const { width, height } = walked;
  if (width < PUBLIC_IMAGE_MIN_SIDE || height < PUBLIC_IMAGE_MIN_SIDE) return refuse('too_small');
  if (width > PUBLIC_IMAGE_MAX_SIDE || height > PUBLIC_IMAGE_MAX_SIDE) return refuse('too_large_dimensions');
  if (walked.orientation >= 2 && walked.orientation <= 8) return refuse('rotated');
  const kind = KINDS[format];
  return { ok: true, format, ...kind, width, height, bytes: walked.bytes };
}

const KINDS = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
  webp: { ext: 'webp', mime: 'image/webp' },
} as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The format the first bytes name, or `undefined` for anything else. */
function sniff(b: Uint8Array): PublicImageFormat | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && PNG_SIGNATURE.every((value, i) => b[i] === value)) return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return undefined;
}

function ascii(b: Uint8Array, at: number, length: number): string {
  if (at + length > b.length) throw new Corrupt();
  return String.fromCharCode(...b.subarray(at, at + length));
}

function u16be(b: Uint8Array, at: number): number {
  if (at + 2 > b.length) throw new Corrupt();
  return (b[at]! << 8) | b[at + 1]!;
}

function u32be(b: Uint8Array, at: number): number {
  if (at + 4 > b.length) throw new Corrupt();
  return ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
}

function u24le(b: Uint8Array, at: number): number {
  if (at + 3 > b.length) throw new Corrupt();
  return b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
}

function u32le(b: Uint8Array, at: number): number {
  if (at + 4 > b.length) throw new Corrupt();
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + ((b[at + 3]! << 24) >>> 0);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---- JPEG ------------------------------------------------------------------------------------------------------------------------

/** Start-of-frame markers that carry the dimensions (every SOFn except DHT C4, JPG C8 and DAC CC). */
const SOF_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Walks the segments of a JPEG to the end of image, keeping what decoding needs.
 *
 * Kept: every non-APP segment, the `APP0` JFIF header (without its thumbnail), `APP2` only when it is an ICC profile and the `APP14`
 * Adobe colour transform header. Dropped: `APP1` (EXIF, XMP), `APP13` (IPTC), `COM` and every other `APPn` (maker data, JFXX
 * thumbnails; an `APP2` MPF index would point at images after the end marker, which are cut). The EXIF orientation is read before its
 * segment is dropped.
 */
function walkJpeg(b: Uint8Array): Walked {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2;
  let size: { width: number; height: number } | undefined;
  let orientation = 1;
  for (;;) {
    if (b[at] !== 0xff) throw new Corrupt();
    while (b[at] === 0xff) at++;
    if (at >= b.length) throw new Corrupt();
    const marker = b[at]!;
    const start = at - 1;
    at++;
    if (marker === 0xd9 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x00) {
      // An end of image before any scan, a second start, a restart marker outside a scan or a stuffed zero: not a picture.
      throw new Corrupt();
    }
    if (marker === 0x01) {
      parts.push(new Uint8Array([0xff, marker]));
      continue;
    }
    const length = u16be(b, at);
    if (length < 2 || at + length > b.length) throw new Corrupt();
    const payload = b.subarray(at + 2, at + length);
    const segment = b.subarray(start, at + length);
    at += length;
    if (SOF_MARKERS.has(marker)) {
      if (payload.length < 6) throw new Corrupt();
      const height = u16be(payload, 1);
      const width = u16be(payload, 3);
      // A height of 0 is given later by a DNL marker: not supported, and no camera writes it.
      if (width === 0 || height === 0) throw new Corrupt();
      size ??= { width, height };
    }
    if (marker === 0xe1) {
      orientation = exifOrientation(payload) ?? orientation;
      continue;
    }
    if (marker >= 0xe0 && marker <= 0xef) {
      // JFIF and Adobe headers are written again at their fixed length, so no thumbnail or trailing payload rides along.
      if (marker === 0xe0 && startsWith(payload, 'JFIF\0') && payload.length >= 14) {
        parts.push(segmentOf(0xe0, concat([payload.subarray(0, 12), new Uint8Array(2)])));
      } else if (marker === 0xee && startsWith(payload, 'Adobe') && payload.length >= 12) {
        parts.push(segmentOf(0xee, payload.subarray(0, 12)));
      } else if (marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) parts.push(segment);
      continue;
    }
    if (marker === 0xfe) continue;
    parts.push(segment);
    if (marker !== 0xda) continue;
    // A scan: entropy-coded data up to the next marker that is not a stuffed zero, a restart marker or a fill byte.
    if (!size) throw new Corrupt();
    const dataStart = at;
    for (;;) {
      if (at + 1 >= b.length) throw new Corrupt();
      if (b[at] !== 0xff) {
        at++;
        continue;
      }
      const next = b[at + 1]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        at += 2;
        continue;
      }
      if (next === 0xff) {
        at++;
        continue;
      }
      break;
    }
    parts.push(b.subarray(dataStart, at));
    if (b[at + 1] === 0xd9) {
      // The end of image: whatever follows (a second picture, an archive, a script) is cut.
      parts.push(new Uint8Array([0xff, 0xd9]));
      return { ...size, bytes: concat(parts), orientation };
    }
    // Another segment follows (the next scan of a progressive JPEG, a table): the loop reads it.
  }
}

/** A JPEG marker segment: `FF`, the marker, the length (payload + 2) and the payload. */
function segmentOf(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  out.set(payload, 4);
  return out;
}

function startsWith(b: Uint8Array, text: string): boolean {
  if (b.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[i] !== text.charCodeAt(i)) return false;
  return true;
}

/**
 * Reads the orientation tag (0x0112) of IFD0 from an `APP1` EXIF payload.
 *
 * @returns the orientation, or `undefined` when the payload is not EXIF or has no readable tag (it is dropped anyway)
 */
function exifOrientation(payload: Uint8Array): number | undefined {
  if (!startsWith(payload, 'Exif\0\0')) return undefined;
  const tiff = payload.subarray(6);
  if (tiff.length < 8) return undefined;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return undefined;
  const u16 = (at: number) => (at + 2 > tiff.length ? -1 : little ? tiff[at]! | (tiff[at + 1]! << 8) : u16be(tiff, at));
  const u32 = (at: number) => (at + 4 > tiff.length ? -1 : little ? u32le(tiff, at) : u32be(tiff, at));
  const ifd = u32(4);
  const count = ifd < 0 ? -1 : u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return undefined;
}

// ---- PNG -------------------------------------------------------------------------------------------------------------------------

/**
 * The chunks a PNG keeps: the critical ones and the ancillary ones that change how the pixels look. Every other chunk is dropped:
 * the text chunks (`tEXt`, `zTXt`, `iTXt`), `eXIf`, `tIME` and any private chunk a polyglot could hide a payload in.
 */
const PNG_KEPT: ReadonlySet<string> = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'cHRM',
  'gAMA',
  'iCCP',
  'sBIT',
  'sRGB',
  'cICP',
  'mDCV',
  'cLLI',
  'bKGD',
  'pHYs',
]);

/** Walks the chunks of a PNG from `IHDR` to `IEND`, checking every CRC. */
function walkPng(b: Uint8Array): Walked {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;
  let size: { width: number; height: number } | undefined;
  let images = 0;
  for (;;) {
    const length = u32be(b, at);
    if (length > 0x7fffffff || at + 12 + length > b.length) throw new Corrupt();
    const type = ascii(b, at + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Corrupt();
    const chunk = b.subarray(at, at + 12 + length);
    if (crc32(chunk.subarray(4, 8 + length)) !== u32be(chunk, 8 + length)) throw new Corrupt();
    at += 12 + length;
    if (!size) {
      if (type !== 'IHDR' || length !== 13) throw new Corrupt();
      size = { width: u32be(chunk, 8), height: u32be(chunk, 12) };
      if (size.width === 0 || size.height === 0) throw new Corrupt();
    } else if (type === 'IHDR') throw new Corrupt();
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Animated();
    if (type === 'IDAT') images++;
    if (PNG_KEPT.has(type)) parts.push(chunk);
    // An unknown critical chunk (upper-case first letter) cannot be skipped by a decoder.
    else if (type.charCodeAt(0) < 0x61) throw new Corrupt();
    if (type === 'IEND') {
      if (images === 0) throw new Corrupt();
      // Whatever follows IEND is cut.
      return { ...size, bytes: concat(parts), orientation: 1 };
    }
  }
}

let CRC_TABLE: Uint32Array | undefined;

/** CRC-32 (ISO 3309, the one PNG uses). */
function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- WebP ------------------------------------------------------------------------------------------------------------------------

/** The `VP8X` flags of the metadata chunks this walk drops. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;

/** One RIFF chunk: its four-character code and its data (without the pad byte). */
interface RiffChunk {
  readonly id: string;
  readonly data: Uint8Array;
}

/**
 * Walks the RIFF chunks of a WebP and rebuilds the file from the ones decoding needs: `VP8X`, `ICCP`, `ALPH` and the one `VP8 ` or `VP8L`
 * bitstream. `EXIF`, `XMP ` and unknown chunks are dropped, their `VP8X` flags cleared and the RIFF size written again; bytes after the
 * RIFF size are cut.
 */
function walkWebp(b: Uint8Array): Walked {
  const riffSize = u32le(b, 4);
  if (riffSize < 4 || 8 + riffSize > b.length) throw new Corrupt();
  const chunks: RiffChunk[] = [];
  let at = 12;
  const end = 8 + riffSize;
  while (at < end) {
    if (at + 8 > end) throw new Corrupt();
    const id = ascii(b, at, 4);
    const length = u32le(b, at + 4);
    if (at + 8 + length > end) throw new Corrupt();
    chunks.push({ id, data: b.subarray(at + 8, at + 8 + length) });
    at += 8 + length + (length % 2);
  }
  if (at > end + 1) throw new Corrupt();
  const first = chunks[0];
  if (!first) throw new Corrupt();
  if (chunks.some((chunk) => chunk.id === 'ANIM' || chunk.id === 'ANMF')) throw new Animated();

  let width: number;
  let height: number;
  let kept: RiffChunk[];
  if (first.id === 'VP8X') {
    if (first.data.length < 10) throw new Corrupt();
    const flags = first.data[0]!;
    if (flags & VP8X_ANIMATION) throw new Animated();
    width = u24le(first.data, 4) + 1;
    height = u24le(first.data, 7) + 1;
    const bitstreams = chunks.filter((chunk) => chunk.id === 'VP8 ' || chunk.id === 'VP8L');
    if (bitstreams.length !== 1) throw new Corrupt();
    const inner = bitstreamSize(bitstreams[0]!);
    if (inner.width !== width || inner.height !== height) throw new Corrupt();
    const header = new Uint8Array(first.data);
    header[0] = flags & ~(VP8X_EXIF | VP8X_XMP);
    kept = [
      { id: 'VP8X', data: header },
      ...chunks.slice(1).filter((chunk) => ['ICCP', 'ALPH', 'VP8 ', 'VP8L'].includes(chunk.id)),
    ];
  } else if (first.id === 'VP8 ' || first.id === 'VP8L') {
    ({ width, height } = bitstreamSize(first));
    // A simple file is one bitstream chunk; anything after it is dropped.
    kept = [first];
  } else {
    throw new Corrupt();
  }
  return { width, height, bytes: riff(kept), orientation: 1 };
}

/** The dimensions a `VP8 ` (key frame header) or `VP8L` (lossless header) bitstream declares. */
function bitstreamSize(chunk: RiffChunk): { width: number; height: number } {
  const d = chunk.data;
  if (chunk.id === 'VP8L') {
    if (d.length < 5 || d[0] !== 0x2f) throw new Corrupt();
    const bits = u32le(d, 1);
    // The 3 version bits must be 0.
    if (bits >>> 29 !== 0) throw new Corrupt();
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  // A key frame: bit 0 of the frame tag is 0, then the start code 9D 01 2A, then 14-bit width and height.
  if (d.length < 10 || (d[0]! & 1) !== 0 || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Corrupt();
  const width = (d[6]! | (d[7]! << 8)) & 0x3fff;
  const height = (d[8]! | (d[9]! << 8)) & 0x3fff;
  if (width === 0 || height === 0) throw new Corrupt();
  return { width, height };
}

/** Builds a RIFF WebP file from chunks (each padded to an even length). */
function riff(chunks: readonly RiffChunk[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    const header = new Uint8Array(8);
    header.set(Array.from(chunk.id, (c) => c.charCodeAt(0)));
    new DataView(header.buffer).setUint32(4, chunk.data.length, true);
    parts.push(header, chunk.data);
    if (chunk.data.length % 2) parts.push(new Uint8Array(1));
  }
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([head, body]);
}
