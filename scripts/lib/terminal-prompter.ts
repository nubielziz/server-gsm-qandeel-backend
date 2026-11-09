// The terminal side of the first-admin questions (P4b round 2): plain questions with node:readline, hidden ones (the password) with
// the keyboard in raw mode, one `*` per character. The streams are parameters so a test feeds a fake one.
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import type { Prompter } from './first-admin-prompt';

/** The keyboard: a readable stream that may switch to raw mode (only a terminal can). */
export interface TerminalInput extends NodeJS.ReadableStream {
  setRawMode?(mode: boolean): unknown;
}

/** The screen. */
export type TerminalOutput = NodeJS.WritableStream;

/** The characters a hidden answer reacts to. */
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const BACKSPACE = ['\x7f', '\b'];
const ENTER = ['\r', '\n'];
const ESCAPE = '\x1b';

/**
 * Tells whether a person is at the keyboard and looking at the screen: both standard streams are terminals.
 *
 * Why: the first-admin questions need both. With a terminal on only one side (input piped, or output redirected to a file or a log)
 * a question would be written where nobody reads it, or answered from a pipe; the commands then ask nothing.
 *
 * @param input standard input (anything with an `isTTY` flag)
 * @param output standard output
 * @returns true only when both are terminals
 */
export function atTerminal(input: { readonly isTTY?: boolean }, output: { readonly isTTY?: boolean }): boolean {
  return input.isTTY === true && output.isTTY === true;
}

/**
 * Asks a plain question and returns the line.
 *
 * Why: readline gives the person line editing (arrows, Home/End). A fresh interface per question, closed at the end, hands the
 * keyboard back to the raw-mode reader of the next hidden question without readline holding on to it.
 *
 * @param input the keyboard
 * @param output the screen
 * @param question the text shown before the cursor
 * @returns the line, or `null` when the person pressed Ctrl+C or Ctrl+D on an empty line (or the input ended)
 */
export function readLine(input: TerminalInput, output: TerminalOutput, question: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    const settle = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    // Ctrl+C: readline would raise the process's SIGINT; here it only cancels the question.
    rl.once('SIGINT', () => {
      output.write('\n');
      settle(null);
    });
    // Ctrl+D on an empty line, or the end of the input. (Closing after an answer reaches here too, already settled.)
    rl.once('close', () => {
      if (!settled) output.write('\n');
      settle(null);
    });
    rl.question(question, settle);
  });
}

/**
 * Asks a secret question and returns what was typed, showing one `*` per character.
 *
 * Why: a password must not appear on the screen or in the scrollback. The keyboard is put in raw mode and read chunk by chunk (a
 * chunk may hold several characters, a paste, or `\r\n`): printable characters are added and echoed as `*`; backspace removes one
 * character and its `*`; Enter ends (text after it in the same chunk is dropped); Ctrl+C and Ctrl+D cancel; escape sequences
 * (arrow keys) are ignored, but Enter, Backspace, Ctrl+C and Ctrl+D still work right after a lone Esc. Raw mode is switched on
 * before the question is shown, so no key can be echoed. The terminal is always given back in its normal mode and the listeners
 * removed, whatever ends the question (Enter, cancel, an error, the end of input).
 *
 * @param input the keyboard; it must be a terminal (have `setRawMode`)
 * @param output the screen
 * @param question the text shown before the cursor
 * @returns the text, or `null` when the person cancelled or the input ended
 * @throws {Error} when the keyboard is not a terminal, or the stream fails
 */
export function readHidden(input: TerminalInput, output: TerminalOutput, question: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (typeof input.setRawMode !== 'function') {
      reject(new Error('Cannot hide the password: standard input is not a terminal.'));
      return;
    }
    const setRawMode = input.setRawMode.bind(input);
    const decoder = new StringDecoder('utf8');
    const typed: string[] = [];
    // Where we are inside an escape sequence: it can be split across chunks.
    let escape: 'none' | 'started' | 'csi' | 'ss3' = 'none';
    let finished = false;

    const stop = (): void => {
      try {
        input.off('data', onData);
        input.off('error', onError);
        input.off('end', onEnd);
        input.off('close', onEnd);
      } finally {
        // Last, and whatever happened above: the terminal must be usable again.
        try {
          setRawMode(false);
        } finally {
          input.pause();
        }
      }
    };
    const finish = (settle: () => void): void => {
      if (finished) return;
      finished = true;
      try {
        stop();
      } finally {
        settle();
      }
    };

    /** Handles one character; returns true when the question is over. */
    const handle = (char: string): boolean => {
      // No escape sequence holds Enter, Backspace, Ctrl+C or Ctrl+D: when one is open, the Esc was a key of its own, and these
      // keys must still work (otherwise `Esc` then `Enter` would be swallowed and the person could not finish or cancel).
      if (
        escape !== 'none' &&
        (char === CTRL_C || char === CTRL_D || ENTER.includes(char) || BACKSPACE.includes(char))
      ) {
        escape = 'none';
      }
      if (escape === 'started') {
        escape = char === '[' ? 'csi' : char === 'O' ? 'ss3' : 'none';
        return false;
      }
      if (escape === 'csi') {
        // A control sequence ends with a final byte from '@' to '~' (arrow keys: ESC [ A).
        if (char >= '@' && char <= '~') escape = 'none';
        return false;
      }
      if (escape === 'ss3') {
        escape = 'none';
        return false;
      }
      if (char === CTRL_C || char === CTRL_D) {
        output.write('\n');
        finish(() => resolve(null));
        return true;
      }
      if (ENTER.includes(char)) {
        output.write('\n');
        const answer = typed.join('');
        finish(() => resolve(answer));
        return true;
      }
      if (BACKSPACE.includes(char)) {
        if (typed.pop() !== undefined) output.write('\b \b');
        return false;
      }
      if (char === ESCAPE) {
        escape = 'started';
        return false;
      }
      // Tab and the other control characters are not part of a password.
      if (/^\p{Cc}$/u.test(char)) return false;
      typed.push(char);
      output.write('*');
      return false;
    };

    function onData(chunk: Buffer | string): void {
      // `for...of` walks code points, so an emoji is one character and one `*`.
      for (const char of typeof chunk === 'string' ? chunk : decoder.write(chunk)) {
        if (handle(char)) return;
      }
    }
    function onError(error: Error): void {
      finish(() => reject(error));
    }
    function onEnd(): void {
      output.write('\n');
      finish(() => resolve(null));
    }

    try {
      // Raw mode first: a key typed before the question shows would otherwise be echoed by the terminal in its normal mode.
      setRawMode(true);
      output.write(question);
      input.on('data', onData);
      input.on('error', onError);
      input.on('end', onEnd);
      input.on('close', onEnd);
      input.resume();
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

/**
 * The prompter that reads the real keyboard.
 *
 * @param input the keyboard (default: standard input)
 * @param output the screen (default: standard output)
 * @returns a {@link Prompter} for {@link askFirstAdmin}
 */
export function createTerminalPrompter(
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): Prompter {
  return {
    ask: (question) => readLine(input, output, question),
    askHidden: (question) => readHidden(input, output, question),
  };
}
