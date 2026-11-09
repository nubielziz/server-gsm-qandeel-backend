// Reads the first admin's password for `--password-stdin` (P4b round 2): one line of standard input, for a deploy script.
import { FirstRunError } from '../first-run';

/**
 * Takes the password out of what was read from standard input.
 *
 * Why: `printf '%s\n' "$PASSWORD" | bun run setup --email ... --name ... --password-stdin`. The one trailing newline (`\n` or `\r\n`)
 * is not part of the password; anything else on another line is a mistake that must not become a password silently.
 *
 * @param text everything read from standard input
 * @returns the password
 * @throws {FirstRunError} when nothing was given, or the text has more than one line (the message never repeats the text)
 */
export function passwordFromStdinText(text: string): string {
  const password = text.replace(/\r?\n$/, '');
  if (password === '') throw new FirstRunError('--password-stdin: no password was given on standard input.');
  if (/[\r\n]/.test(password))
    throw new FirstRunError('--password-stdin: standard input must hold one line, the password.');
  return password;
}

/**
 * Reads the password from the process's standard input.
 *
 * @returns the password
 * @throws {FirstRunError} when standard input is a terminal (the password would be shown as it is typed; run `bun run setup`
 *   without the option to be asked for it), or the text is not one line
 */
export async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new FirstRunError(
      '--password-stdin reads the password from a pipe, not from the keyboard. ' +
        'Run `bun run setup` without it to be asked for the password.',
    );
  }
  return passwordFromStdinText(await Bun.stdin.text());
}
