// Unit tests of the terminal prompter (P4b round 2) with fake streams, no terminal: the hidden reader echoes `*`, handles backspace,
// Enter, Ctrl+C, Ctrl+D, escape sequences and pasted chunks, and always gives raw mode back; the plain reader reads a line.
import { describe, expect, it } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { atTerminal, createTerminalPrompter, readHidden, readLine } from '../../scripts/lib/terminal-prompter';
import { expectRejection } from '../support/rejection';

/** A fake keyboard: a stream that records every `setRawMode` call, like a terminal's input. */
function keyboard(options: { failRawOn?: boolean } = {}) {
  const calls: boolean[] = [];
  const stream = Object.assign(new PassThrough(), {
    setRawMode(mode: boolean) {
      calls.push(mode);
      if (mode && options.failRawOn) throw new Error('raw mode refused');
      return stream;
    },
  });
  return { stream, calls };
}

/** A fake screen that keeps what was written. */
function screen() {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => written.join('') };
}

/** Types into the fake keyboard one chunk at a time, letting the reader run between chunks (as separate key reports would). */
async function type(stream: PassThrough, ...chunks: Array<string | Uint8Array>) {
  for (const chunk of chunks) {
    stream.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The raw-mode contract: switched on once, switched off again, and no listener left on the keyboard. */
function expectKeyboardGivenBack(keys: ReturnType<typeof keyboard>) {
  expect(keys.calls).toEqual([true, false]);
  for (const event of ['data', 'error', 'end', 'close']) expect(keys.stream.listenerCount(event)).toBe(0);
  expect(keys.stream.isPaused()).toBe(true);
}

describe('readHidden: what the person types', () => {
  it('shows one * per character and returns the text on Enter', async () => {
    const keys = keyboard();
    const out = screen();
    const answer = readHidden(keys.stream, out.stream, 'Password: ');
    await type(keys.stream, 'a', 'b', 'c', '\r');
    expect(await answer).toBe('abc');
    expect(out.text()).toBe('Password: ***\n');
    expectKeyboardGivenBack(keys);
  });

  it('removes one character and its * on backspace (DEL or ^H), and ignores backspace on an empty answer', async () => {
    const keys = keyboard();
    const out = screen();
    const answer = readHidden(keys.stream, out.stream, 'Password: ');
    await type(keys.stream, '\x7f', 'ab', '\x7f', 'c', '\b', 'd', '\r');
    expect(await answer).toBe('ad');
    // One erase for each backspace that had something to remove: the first (on an empty answer) writes nothing.
    expect(out.text()).toBe('Password: **\b \b*\b \b*\n');
    expectKeyboardGivenBack(keys);
  });

  it('ends on \\r, on \\n and on \\r\\n, and ignores what follows Enter in the same chunk', async () => {
    for (const enter of ['\r', '\n', '\r\n']) {
      const keys = keyboard();
      const answer = readHidden(keys.stream, screen().stream, 'Password: ');
      await type(keys.stream, `abc${enter}`);
      expect(await answer).toBe('abc');
      expectKeyboardGivenBack(keys);
    }
    const keys = keyboard();
    const answer = readHidden(keys.stream, screen().stream, 'Password: ');
    await type(keys.stream, 'abc\rdef');
    expect(await answer).toBe('abc');
  });

  it('takes a paste that arrives in one chunk, with spaces and symbols', async () => {
    const keys = keyboard();
    const out = screen();
    const answer = readHidden(keys.stream, out.stream, 'Password: ');
    await type(keys.stream, 'p@ss w0rd!#\r\n');
    expect(await answer).toBe('p@ss w0rd!#');
    expect(out.text()).toBe(`Password: ${'*'.repeat(11)}\n`);
  });

  it('counts a multi-byte character once, also when its bytes arrive in two chunks', async () => {
    const keys = keyboard();
    const out = screen();
    const answer = readHidden(keys.stream, out.stream, 'Password: ');
    const bytes = new TextEncoder().encode('é😀');
    await type(keys.stream, bytes.slice(0, 1), bytes.slice(1, 3), bytes.slice(3, 5), bytes.slice(5), '\r');
    expect(await answer).toBe('é😀');
    expect(out.text()).toBe('Password: **\n');
  });

  it('ignores arrow keys, other escape sequences (also split across chunks) and control characters', async () => {
    const keys = keyboard();
    const out = screen();
    const answer = readHidden(keys.stream, out.stream, 'Password: ');
    await type(keys.stream, '\x1b[A', 'a', '\x1b', '[', '1;5', 'C', 'b', '\x1bOA', 'c', '\x1bx', '\t', 'd\x01', '\r');
    expect(await answer).toBe('abcd');
    expect(out.text()).toBe('Password: ****\n');
  });
});

describe('readHidden: a lone Esc and the keys that end a question', () => {
  it('lets Enter end the question right after a lone Esc, and after the start of a control sequence', async () => {
    for (const keysTyped of [
      ['abc', '\x1b', '\r'],
      ['abc', '\x1b[', '\r'],
      ['abc', '\x1bO', '\n'],
    ]) {
      const keys = keyboard();
      const answer = readHidden(keys.stream, screen().stream, 'Password: ');
      await type(keys.stream, ...keysTyped);
      expect(await answer).toBe('abc');
      expectKeyboardGivenBack(keys);
    }
  });

  it('lets Ctrl+C and Ctrl+D cancel right after a lone Esc', async () => {
    for (const cancel of ['\x03', '\x04']) {
      const keys = keyboard();
      const answer = readHidden(keys.stream, screen().stream, 'Password: ');
      await type(keys.stream, 'abc', '\x1b', cancel);
      expect(await answer).toBeNull();
      expectKeyboardGivenBack(keys);
    }
  });

  it('lets backspace work right after a lone Esc, and still swallows the key an Alt-combination sends after it', async () => {
    const keys = keyboard();
    const out = screen();
    const answer = readHidden(keys.stream, out.stream, 'Password: ');
    await type(keys.stream, 'abc', '\x1b', '\x7f', 'd', '\x1b', 'x', 'e', '\r');
    expect(await answer).toBe('abde');
    expect(out.text()).toBe('Password: ***\b \b**\n');
  });
});

describe('readHidden: no key is echoed before raw mode is on', () => {
  it('switches raw mode on before it shows the question', async () => {
    const order: string[] = [];
    const stream = Object.assign(new PassThrough(), {
      setRawMode(mode: boolean) {
        order.push(`raw:${mode}`);
        return undefined;
      },
    });
    const out = new Writable({
      write(chunk, _encoding, done) {
        order.push(`write:${String(chunk)}`);
        done();
      },
    });
    const answer = readHidden(stream, out, 'Password: ');
    await type(stream, 'x\r');
    expect(await answer).toBe('x');
    // A key typed while the terminal was still in its normal mode would be shown on the screen: raw mode comes first.
    expect(order.slice(0, 2)).toEqual(['raw:true', 'write:Password: ']);
    expect(order.at(-1)).toBe('raw:false');
  });

  it('shows nothing when raw mode cannot be switched on', async () => {
    const keys = keyboard({ failRawOn: true });
    const out = screen();
    await expectRejection(readHidden(keys.stream, out.stream, 'Password: '), 'raw mode refused');
    expect(out.text()).toBe('');
  });
});

describe('readHidden: how it ends', () => {
  it('returns null on Ctrl+C, also after some characters, and writes a new line', async () => {
    for (const keysTyped of ['\x03', 'ab\x03', 'ab\x03cd\r']) {
      const keys = keyboard();
      const out = screen();
      const answer = readHidden(keys.stream, out.stream, 'Password: ');
      await type(keys.stream, keysTyped);
      expect(await answer).toBeNull();
      expect(out.text().endsWith('\n')).toBe(true);
      expectKeyboardGivenBack(keys);
    }
  });

  it('returns null on Ctrl+D', async () => {
    const keys = keyboard();
    const answer = readHidden(keys.stream, screen().stream, 'Password: ');
    await type(keys.stream, 'ab\x04');
    expect(await answer).toBeNull();
    expectKeyboardGivenBack(keys);
  });

  it('returns null when the input ends', async () => {
    const keys = keyboard();
    const answer = readHidden(keys.stream, screen().stream, 'Password: ');
    await type(keys.stream, 'ab');
    keys.stream.end();
    expect(await answer).toBeNull();
    expectKeyboardGivenBack(keys);
  });

  it('rejects when the stream fails, and still gives raw mode back', async () => {
    const keys = keyboard();
    const answer = readHidden(keys.stream, screen().stream, 'Password: ');
    const outcome = answer.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await type(keys.stream, 'ab');
    keys.stream.destroy(new Error('the terminal went away'));
    expect(await outcome).toBe('the terminal went away');
    expect(keys.calls).toEqual([true, false]);
    expect(keys.stream.listenerCount('data')).toBe(0);
    expect(keys.stream.listenerCount('error')).toBe(0);
  });

  it('rejects when raw mode cannot be switched on, and tries to switch it off', async () => {
    const keys = keyboard({ failRawOn: true });
    await expectRejection(readHidden(keys.stream, screen().stream, 'Password: '), 'raw mode refused');
    expect(keys.calls).toEqual([true, false]);
    expect(keys.stream.listenerCount('data')).toBe(0);
  });

  it('rejects when the input is not a terminal, without listening to it', async () => {
    const plain = new PassThrough();
    await expectRejection(readHidden(plain, screen().stream, 'Password: '), /not a terminal/);
    expect(plain.listenerCount('data')).toBe(0);
  });

  it('can ask twice on the same keyboard (password, then its repeat)', async () => {
    const keys = keyboard();
    const out = screen();
    const first = readHidden(keys.stream, out.stream, 'Password: ');
    await type(keys.stream, 'abc\r');
    expect(await first).toBe('abc');
    const second = readHidden(keys.stream, out.stream, 'Repeat password: ');
    await type(keys.stream, 'abd\r');
    expect(await second).toBe('abd');
    expect(keys.calls).toEqual([true, false, true, false]);
  });
});

describe('readLine and the terminal prompter', () => {
  it('returns the line that was typed, and asks on the screen', async () => {
    const input = new PassThrough();
    const out = screen();
    const answer = readLine(input, out.stream, '  Email: ');
    await type(input, 'layla@example.com\n');
    expect(await answer).toBe('layla@example.com');
    expect(out.text()).toContain('  Email: ');
  });

  it('returns an empty string for Enter alone', async () => {
    const input = new PassThrough();
    const answer = readLine(input, screen().stream, 'Create? [Y/n] ');
    await type(input, '\n');
    expect(await answer).toBe('');
  });

  it('returns null when the input ends before a line (Ctrl+D)', async () => {
    const input = new PassThrough();
    const answer = readLine(input, screen().stream, '  Email: ');
    input.end();
    expect(await answer).toBeNull();
  });

  it('works one question after another on the same input', async () => {
    const input = new PassThrough();
    const prompter = createTerminalPrompter(input, screen().stream);
    const first = prompter.ask('  Email: ');
    await type(input, 'a@b.co\n');
    expect(await first).toBe('a@b.co');
    const second = prompter.ask('  Full name: ');
    await type(input, 'Layla Haddad\n');
    expect(await second).toBe('Layla Haddad');
  });

  it('hides the answers of askHidden', async () => {
    const keys = keyboard();
    const out = screen();
    const prompter = createTerminalPrompter(keys.stream, out.stream);
    const answer = prompter.askHidden('  Password: ');
    await type(keys.stream, 'secret-pass\r');
    expect(await answer).toBe('secret-pass');
    expect(out.text()).not.toContain('secret');
  });
});

describe('atTerminal', () => {
  it('is true only when both standard streams are terminals', () => {
    expect(atTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    // A terminal on one side only: the questions would go where nobody reads them, or be answered from a pipe.
    expect(atTerminal({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(atTerminal({ isTTY: true }, {})).toBe(false);
    expect(atTerminal({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(atTerminal({}, { isTTY: true })).toBe(false);
    expect(atTerminal({}, {})).toBe(false);
  });
});
