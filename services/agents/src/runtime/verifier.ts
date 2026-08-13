/**
 * Running the repository's own suite, as a tool and as a fact.
 *
 * Moved here from implementer/implement.ts, which is where it was written and
 * where it earned its scars. Two agents need it and they need it for different
 * halves of the same question: the implementer runs the suite so it can fix what
 * fails, and the reviewer runs it so it can say whether the change works. The
 * reviewer is in fact the consumer `ReviewFeedback.verification` was designed
 * for. Same call as moving the read tools to runtime/ — one implementation, so a
 * lesson learned in one agent is not re-learned in the other.
 *
 * The commands come from the repo's manifest and are run verbatim; the task is
 * already in the stack image that can run them (see RuntimeRef).
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { Logger, RepoManifest } from '@cloud-harness/shared';

import { prepareRepo, runCommand } from './exec.js';

/** Output kept per test run. Enough for the model to act on, bounded for context. */
const TEST_OUTPUT_LIMIT = 8_000;

/**
 * How many times a model may run the suite inside one invocation.
 *
 * A test run is the most expensive tool an agent has in wall-clock terms, and
 * the failure it guards against is a model that treats it as a save button. The
 * implementer needs several — its loop is write, run, fix, run. A reviewer that
 * needs six is not reviewing.
 */
const DEFAULT_MAX_TEST_RUNS = 6;

/** What the suite said. This is what ReviewFeedback.verification carries. */
export interface Verification {
  /**
   * False is a real answer, not a missing one: the repo declared no test
   * command. A change that was never executed must say so rather than let
   * silence read as success.
   */
  attempted: boolean;
  command?: string;
  passed?: boolean;
  /** Tail-truncated output. Small enough to ride in a comment. */
  output?: string;
}

export interface Verifier {
  tools: ToolSet;
  /**
   * Run the suite for the record, sharing this run's memoised setup.
   *
   * Called once after the loop, because a model's own last run is stale the
   * moment it writes another file — and the implementer usually does, since the
   * natural last act is to fix what the run reported.
   */
  verify: () => Promise<Verification>;
}

export interface VerifierOptions {
  manifest: RepoManifest;
  workdir: string;
  log: Logger;
  signal: AbortSignal;
  onProgress?: () => Promise<void>;
  /** Defaults to DEFAULT_MAX_TEST_RUNS. */
  maxRuns?: number;
}

/**
 * `run_tests` — the repo's own test command, plus the setup it needs.
 *
 * Setup and build are memoised across calls: `npm ci` costs a minute and its
 * answer does not change between two edits to a source file, so paying it once
 * per run rather than once per call is most of the difference between a loop
 * that converges and one that times out.
 */
export function createVerifier(options: VerifierOptions): Verifier {
  const { manifest, workdir, log, signal } = options;
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_TEST_RUNS;
  let prepared: Promise<string | undefined> | undefined;
  let runs = 0;

  const commandOptions = {
    cwd: workdir,
    log,
    signal,
    outputLimit: TEST_OUTPUT_LIMIT,
  };

  /**
   * Resolves to an error description, or undefined when the repo is ready.
   *
   * **Success is memoised; failure is not.** Memoising the failure too is the
   * obvious saving and it is wrong, because of what setup failing usually means
   * mid-loop: the model has written `package.json` and not yet the lockfile, so
   * `npm ci` fails on exactly the file it is about to add. Cache that and every
   * later run replays a stale error, the model is told its fix did nothing, and
   * a correct implementation gets reported as a failing suite. That is not
   * hypothetical — it is what happened to KAN-8, and the model reasonably but
   * wrongly concluded the harness was running against the committed HEAD.
   *
   * The cost of retrying is bounded by maxRuns, since setup only runs when a
   * test run asks for it.
   */
  const prepare = async (): Promise<string | undefined> =>
    (prepared ??= (async () => {
      const results = await prepareRepo(manifest, commandOptions);
      const failed = results.find((result) => result.exitCode !== 0);
      if (failed === undefined) return undefined;

      // Let the next call try again against whatever the model fixes next.
      prepared = undefined;
      return (
        `Setup failed before the tests could run: \`${failed.command}\` exited ` +
        `${failed.exitCode ?? 'null'}. Fix what it reports and run the tests ` +
        `again — setup runs against the working tree as it is now, so a file ` +
        `you add next will be there.\n\n${failed.output}`
      );
    })());

  const run = async (): Promise<Verification> => {
    if (manifest.testCommand === undefined) {
      return { attempted: false };
    }

    const setupError = await prepare();
    if (setupError !== undefined) {
      return {
        attempted: true,
        command: manifest.testCommand,
        passed: false,
        output: setupError,
      };
    }

    const result = await runCommand(manifest.testCommand, commandOptions);
    return {
      attempted: true,
      command: manifest.testCommand,
      passed: result.exitCode === 0,
      output: result.timedOut
        ? `Timed out after ${result.durationMs}ms.\n\n${result.output}`
        : result.output,
    };
  };

  const runTests = tool({
    description:
      "Run the repository's own test suite and return its output. Use this to check the " +
      'code before you finish, and again after anything changes. If the repository ' +
      'declares no test command this says so.',
    inputSchema: z.object({}),
    execute: async (): Promise<string> => {
      try {
        if (runs >= maxRuns) {
          return (
            `The test-run budget of ${maxRuns} is spent. Finish on the evidence you ` +
            'have, and say what you were unable to verify.'
          );
        }
        runs += 1;

        const verification = await run();
        if (!verification.attempted) {
          return (
            'This repository declares no test command in .cloud-harness.yml, so there is ' +
            'nothing to run. Say so in your summary.'
          );
        }

        return verification.passed === true
          ? `\`${verification.command ?? ''}\` passed (run ${runs} of ${maxRuns}).\n\n${verification.output ?? ''}`
          : `\`${verification.command ?? ''}\` FAILED (run ${runs} of ${maxRuns}).\n\n${verification.output ?? ''}`;
      } finally {
        await options.onProgress?.();
      }
    },
  });

  return { tools: { run_tests: runTests }, verify: run };
}
