// Unit tests of the stream wire format and writer (decision 037): frame text, the one-line data, the burst-aware slow-reader check.
import { describe, expect, it } from 'bun:test';
import { MAX_BUFFERED_BYTES, StreamWriter, frameData, frameText, retryText } from '@src/infra/realtime/stream-writer';

describe('frameText', () => {
  it('writes event and data, and an id only for a replayable frame', () => {
    expect(frameText('hb', '1731650000')).toBe('event: hb\ndata: 1731650000\n\n');
    expect(frameText('notification.created', '{"unread":3}', 'i9001-t5521')).toBe(
      'id: i9001-t5521\nevent: notification.created\ndata: {"unread":3}\n\n',
    );
  });

  it('refuses what would break the framing', () => {
    expect(() => frameText('bad\nevent', '{}')).toThrow('not a stream event name');
    expect(() => frameText('Upper', '{}')).toThrow('not a stream event name');
    expect(() => frameText('hb', '1', 'i1\nevent: x')).toThrow('not a stream cursor');
    expect(() => frameText('hb', '{\n}')).toThrow('one line');
  });
});

describe('frameData', () => {
  it('keeps line breaks of strings escaped, so the data stays on one line', () => {
    const json = frameData({ body: 'line one\nline two\r\n', title: 'x' });
    expect(json).not.toContain('\n');
    expect(JSON.parse(json)).toEqual({ body: 'line one\nline two\r\n', title: 'x' });
    expect(frameData(3)).toBe('3');
  });

  it('refuses a value without a JSON form', () => {
    expect(() => frameData(undefined)).toThrow(TypeError);
    expect(() => frameData(() => 1)).toThrow(TypeError);
    expect(() => frameData({ n: 1n })).toThrow(TypeError);
  });
});

describe('retryText', () => {
  it('sets the reconnect delay in whole milliseconds', () => {
    expect(retryText(3141.6)).toBe('retry: 3142\n\n');
  });
});

describe('StreamWriter', () => {
  /** A sink whose buffer only drains when the test says so. */
  function sink() {
    const written: string[] = [];
    let queued = 0;
    return {
      written,
      sink: {
        write: (chunk: string) => {
          written.push(chunk);
          queued += Buffer.byteLength(chunk);
          return true;
        },
        get writableLength() {
          return queued;
        },
      },
      drain: () => (queued = 0),
    };
  }

  it('lets one large burst through: only what earlier bursts left unread counts', () => {
    const { sink: target, written } = sink();
    const bursts: Array<() => void> = [];
    const writer = new StreamWriter(target, (fn) => bursts.push(fn));
    const big = 'x'.repeat(30_000);
    for (let i = 0; i < 20; i++) expect(writer.write(big)).toBe('ok');
    expect(written).toHaveLength(20);
    expect(writer.bytes).toBe(600_000);
    expect(bursts).toHaveLength(1);
  });

  it('calls a client slow once the backlog of earlier bursts passes the limit', () => {
    const { sink: target, drain } = sink();
    const bursts: Array<() => void> = [];
    const writer = new StreamWriter(target, (fn) => bursts.push(fn));
    const chunk = 'x'.repeat(100_000);
    expect(writer.write(chunk)).toBe('ok');
    bursts.shift()!(); // the burst ended; the client read nothing
    expect(writer.write(chunk)).toBe('ok');
    bursts.shift()!();
    expect(writer.write(chunk)).toBe('ok');
    bursts.shift()!();
    // 300 000 bytes from earlier bursts are still queued: more than MAX_BUFFERED_BYTES.
    expect(300_000).toBeGreaterThan(MAX_BUFFERED_BYTES);
    expect(writer.write('event: hb\ndata: 1\n\n')).toBe('slow');
    drain();
    bursts.shift()!();
    expect(writer.write('event: hb\ndata: 2\n\n')).toBe('ok');
  });

  it('reports a write that throws', () => {
    const writer = new StreamWriter(
      {
        write: () => {
          throw new Error('socket closed');
        },
        writableLength: 0,
      },
      () => undefined,
    );
    expect(writer.write('event: hb\ndata: 1\n\n')).toBe('error');
    expect(writer.bytes).toBe(0);
  });
});
