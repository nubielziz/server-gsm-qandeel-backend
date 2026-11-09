// Runs a command inside a pseudo-terminal (Bun's `terminal` option) so a test can answer its questions like a person at a keyboard:
// wait for a prompt, type an answer, read what the screen showed, collect the exit code. Used by the setup and db:reset tests.

/** A command running in a pseudo-terminal. */
export interface TerminalSession {
  /** Everything the command wrote to the screen so far (with the terminal's `\r\n` line ends). */
  readonly screen: () => string;
  /** Waits until `text` appears on the screen after the last thing waited for, and moves the cursor past it. */
  readonly waitFor: (text: string, timeoutMs?: number) => Promise<void>;
  /** Types text (or a control character such as `\x03`) as the keyboard would send it. */
  readonly send: (text: string) => void;
  /** The exit code, once the command ends; also closes the terminal. */
  readonly exitCode: () => Promise<number>;
}

/**
 * Starts a command with a real pseudo-terminal as its standard input and output.
 *
 * @param command the program and its arguments
 * @param options the working directory and the exact environment (no other variable reaches the command)
 * @returns the session
 */
export function runInTerminal(
  command: string[],
  options: { cwd: string; env: Record<string, string> },
): TerminalSession {
  let screen = '';
  let cursor = 0;
  const decoder = new TextDecoder();
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: 120,
      rows: 40,
      data: (_terminal, data) => {
        screen += decoder.decode(data, { stream: true });
      },
    },
  });
  const terminal = proc.terminal!;
  return {
    screen: () => screen,
    send: (text) => {
      terminal.write(text);
    },
    waitFor: async (text, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = screen.indexOf(text, cursor);
        if (found >= 0) {
          cursor = found + text.length;
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${JSON.stringify(text)}. The screen shows:\n${screen}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    exitCode: async () => {
      const code = await proc.exited;
      terminal.close();
      return code;
    },
  };
}
