/**
 * Running the repo's own build and test commands.
 *
 * The commands come from the repo's `.cloud-harness.yml` (with stack defaults
 * filled in), ride along on the work item, and are executed verbatim. Whether
 * they *can* run is decided upstream by which stack image the task launched in
 * — see docs/ARCHITECTURE.md → Runtime selection.
 *
 * This is real: it is mechanical process handling, not agent behaviour.
 */

import { spawn } from 'node:child_process';

import type { Logger } from '@cloud-harness/shared';

export interface CommandResult {
  command: string;
  exitCode: number | null;
  /** Combined stdout+stderr, tail-truncated to `outputLimit`. */
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  log: Logger;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Output is fed back to a model and pasted into Jira comments, so it must be
   * bounded. The tail is kept rather than the head — a failing suite puts the
   * useful part at the end.
   */
  outputLimit?: number;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 32_000;

function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `…[${text.length - limit} characters truncated]…\n${text.slice(-limit)}`;
}

/**
 * Run one shell command in the repo's working directory.
 *
 * Resolves with a non-zero exit code rather than rejecting — a failing test
 * suite is a normal, informative outcome here, not an exception. It is the
 * reviewer's evidence.
 *
 * Executed through `bash -lc` because manifest commands are written the way a
 * developer would type them (`npm ci && npm test`, `uv run pytest -x`) and are
 * expected to get pipes, `&&`, and PATH resolution.
 */
export async function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const startedAt = Date.now();

  options.log.info('running command', { command, cwd: options.cwd });

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      // Bound memory for a suite that logs pathologically; the tail is what
      // matters and the final truncation happens below anyway.
      if (output.length > outputLimit * 4) output = output.slice(-outputLimit * 2);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const result: CommandResult = {
        command,
        exitCode,
        output: tail(output, outputLimit),
        durationMs: Date.now() - startedAt,
        timedOut,
      };
      options.log.info('command finished', {
        command,
        exitCode,
        timedOut,
        durationMs: result.durationMs,
      });
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so a test runner can flush its output, then SIGKILL.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);

    // Task shutdown (SIGTERM / Spot interruption) must not leave the suite
    // running while the SQS message goes back on the queue.
    const onAbort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      output += `\nfailed to spawn: ${err.message}`;
      finish(null);
    });
    child.on('close', finish);
  });
}

/**
 * Run setup then build, stopping at the first failure.
 *
 * Returns the results in order so a caller can report exactly which step broke;
 * an empty array means the manifest declared neither.
 */
export async function prepareRepo(
  manifestCommands: { setupCommand?: string | undefined; buildCommand?: string | undefined },
  options: RunCommandOptions,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of [manifestCommands.setupCommand, manifestCommands.buildCommand]) {
    if (command === undefined) continue;
    const result = await runCommand(command, options);
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return results;
}
