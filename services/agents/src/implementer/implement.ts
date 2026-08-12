/**
 * Turning an approved story into a working tree that passes its own suite.
 *
 * Split from handle.ts the same way refine.ts is split from the refiner's:
 * everything here is the agent's *thinking* plus the workspace it thinks in, and
 * nothing here talks to Jira or Bitbucket. The result is that the expensive,
 * interesting half runs against a real repo and a real model without pushing a
 * branch or moving anyone's card.
 *
 * One model call with a tool loop, as in the refiner. The difference is what the
 * loop can do: the implementer gets the read tools every agent gets, plus write
 * tools, plus a way to run the repo's own tests. That last one is what makes the
 * loop worth having — a model that can see its suite fail can fix it, and the
 * alternative is shipping the first draft to a reviewer who will run the same
 * command and bounce it, at the cost of one of three attempts.
 */

import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import { z } from 'zod';

import {
  intEnv,
  optionalEnv,
  type ImplementWorkItem,
  type Logger,
  type RepoManifest,
} from '@cloud-harness/shared';

import { createRepoTools } from '../runtime/repo-tools.js';
import { prepareRepo, runCommand } from '../runtime/exec.js';
import type { AgentModel } from '../runtime/model.js';
import { createEditTools } from './edit-tools.js';

/**
 * How many tool-call rounds the model gets.
 *
 * Substantially more than the refiner's twelve, because the shape of the work is
 * different: reading enough to place a change, writing several files, running
 * the suite, and fixing what it reports is a longer loop than reading a repo and
 * writing prose about it. Still bounded — a model that has not converged in
 * thirty rounds is not about to.
 */
const DEFAULT_MAX_STEPS = 30;

/**
 * How many times the model may run the suite inside one implementation.
 *
 * A test run is the most expensive tool here in wall-clock terms, and the
 * failure it guards against is a model that treats it as a save button.
 */
const MAX_TEST_RUNS = 6;

/** What the suite said. Mirrors ReviewFeedback.verification, which the reviewer fills in the same way. */
export interface Verification {
  /**
   * False is a real answer, not a missing one: the repo declared no test
   * command. A branch that was never verified must say so rather than let
   * silence read as success.
   */
  attempted: boolean;
  command?: string;
  passed?: boolean;
  /** Tail-truncated output. Small enough to ride in a Jira comment. */
  output?: string;
}

export interface Verifier {
  tools: ToolSet;
  /**
   * Run the suite for the record, sharing this run's memoised setup.
   *
   * Called once after the loop, because the model's own last run is stale the
   * moment it writes another file — and it usually does, since the natural last
   * act is to fix what the run reported.
   */
  verify: () => Promise<Verification>;
}

/** Output kept per test run. Enough for the model to act on, bounded for context. */
const TEST_OUTPUT_LIMIT = 8_000;

/**
 * `run_tests` — the repo's own test command, plus the setup it needs.
 *
 * The commands are the manifest's and are run verbatim; the task is already in
 * the stack image that can run them (see RuntimeRef). Setup and build are
 * memoised across calls: `npm ci` costs a minute and its answer does not change
 * between two edits to a source file, so paying it once per run rather than once
 * per call is most of the difference between a loop that converges and one that
 * times out.
 */
export function createVerifier(options: {
  manifest: RepoManifest;
  workdir: string;
  log: Logger;
  signal: AbortSignal;
  onProgress?: () => Promise<void>;
}): Verifier {
  const { manifest, workdir, log, signal } = options;
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
   * The cost of retrying is bounded by MAX_TEST_RUNS, since setup only runs when
   * a test run asks for it.
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
      "Run the repository's own test suite and return its output. Use this to check your " +
      'work before you finish, and again after fixing anything it reports. If the ' +
      'repository declares no test command this says so.',
    inputSchema: z.object({}),
    execute: async (): Promise<string> => {
      try {
        if (runs >= MAX_TEST_RUNS) {
          return (
            `The test-run budget of ${MAX_TEST_RUNS} is spent. Finish the change on the ` +
            'evidence you have, and say in your summary what you were unable to verify.'
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
          ? `\`${verification.command ?? ''}\` passed (run ${runs} of ${MAX_TEST_RUNS}).\n\n${verification.output ?? ''}`
          : `\`${verification.command ?? ''}\` FAILED (run ${runs} of ${MAX_TEST_RUNS}).\n\n${verification.output ?? ''}`;
      } finally {
        await options.onProgress?.();
      }
    },
  });

  return { tools: { run_tests: runTests }, verify: run };
}

export const DEFAULT_SYSTEM_PROMPT = `You implement an approved story in an existing codebase.

The story you are given is the spec. A human approved it, and everything in it is
a requirement. Build what it describes — not less, and specifically not more.

Read before you write. The repository is checked out and you have tools to list,
read and search it. Find where this change belongs and what it should look like
before you create a single file, and follow what is already there: the same
structure, the same naming, the same idioms, the same test style. Code that reads
like it was always part of this repository is the goal, and it is a goal you can
only reach by looking.

Write whole files. \`write_file\` replaces a file's entire contents, so read a
file before you overwrite it and keep everything you did not mean to change.

Run \`run_tests\` before you finish, and again after fixing anything it reports.
A branch whose own suite fails is worse than no branch — it costs a human a
review round trip to tell you something the suite already said. If the repository
has tests, yours must pass. If your change is worth testing and the repository
has a test suite, add tests for it in the style the suite already uses.

Stay inside the story. Do not refactor code the story did not ask you to touch,
do not add abstractions for needs nobody has stated, and do not fix unrelated
things you notice on the way — those are separate tickets, and bundling them
makes the review harder for the human whose approval this needs. Adjacent
problems that genuinely block the story are the exception; say so in your summary
when you hit one.

You cannot ask a question. There is no human in this loop — the questions were
asked and answered at refinement, and the story in front of you is the result. If
you find it genuinely ambiguous, implement the most reasonable reading, and say
plainly in your summary which reading you took and what the alternative was. A
reviewer reads that summary next.

Your closing message becomes the pull request description, and it is the only
thing you write that a human reads. Explain what you changed and why, in prose,
in enough detail that a reviewer knows where to look. Say what you verified and
what you could not. No preamble and nothing addressed to the reader — write it
the way an engineer writes a good PR description, not the way a chatbot reports
back.

TODO: add the team's own conventions here — commit and PR conventions, the
definition of done, coverage expectations, and anything the codebase does that a
newcomer would get wrong. Everything above is generic; this is where it stops
being generic. Override the whole prompt with IMPLEMENTER_SYSTEM_PROMPT.`;

function systemPrompt(): string {
  return optionalEnv('IMPLEMENTER_SYSTEM_PROMPT') ?? DEFAULT_SYSTEM_PROMPT;
}

export interface ImplementContext {
  model: AgentModel;
  log: Logger;
  workdir: string;
  signal: AbortSignal;
  /** Extends the SQS visibility timeout. Called after every tool and step. */
  onProgress: () => Promise<void>;
}

export interface ImplementResult {
  /** The model's closing prose. Becomes the pull request description. */
  summary: string;
  /** Repo-relative paths the model wrote or deleted. */
  changedPaths: string[];
  /** The authoritative post-loop test run, not whatever the model last saw. */
  verification: Verification;
  /** True when the loop hit the step budget rather than finishing on its own. */
  exhaustedSteps: boolean;
}

/**
 * The story, plus what the implementer is being asked to do with it.
 *
 * Only the `initial` reason is built here. The other two continue a branch that
 * already exists and need the review findings or the conflict in front of the
 * model; handle.ts rejects them before this is called.
 */
export function storyPrompt(item: ImplementWorkItem): string {
  return [
    `Ticket: ${item.issueKey}`,
    `Title: ${item.title}`,
    `Repository: ${item.repository.workspace}/${item.repository.slug}`,
    `Base branch: ${item.repository.baseBranch}`,
    `Stack: ${item.runtime.stack}`,
    '',
    'The approved story. This is the spec:',
    '',
    item.refinedDescription.trim() || '(the story is empty)',
  ].join('\n');
}

/**
 * Implement the story in `ctx.workdir`. Throws on model failure; the caller
 * decides what that means for the work item.
 *
 * Leaves the working tree dirty and uncommitted, deliberately — committing and
 * pushing happen after the lane guard, and nothing here should produce anything
 * that outlives a stand-down.
 */
export async function implement(
  item: ImplementWorkItem,
  ctx: ImplementContext,
): Promise<ImplementResult> {
  const repo = createRepoTools({
    root: ctx.workdir,
    log: ctx.log,
    onProgress: ctx.onProgress,
  });
  const edits = createEditTools({
    root: ctx.workdir,
    log: ctx.log,
    onProgress: ctx.onProgress,
  });
  const verifier = createVerifier({
    manifest: item.runtime.manifest,
    workdir: ctx.workdir,
    log: ctx.log,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });

  const maxSteps = intEnv('IMPLEMENTER_MAX_STEPS', DEFAULT_MAX_STEPS);

  const result = await generateText({
    model: ctx.model.model,
    providerOptions: ctx.model.providerOptions,
    maxOutputTokens: ctx.model.maxOutputTokens,
    abortSignal: ctx.signal,
    system: systemPrompt(),
    prompt: storyPrompt(item),
    tools: { ...repo.tools, ...edits.tools, ...verifier.tools },
    stopWhen: stepCountIs(maxSteps),
    onStepFinish: async () => {
      await ctx.onProgress();
    },
  });

  const exhaustedSteps = result.steps.length >= maxSteps;
  const changedPaths = edits.changedPaths();

  ctx.log.info('implementation loop finished', {
    steps: result.steps.length,
    maxSteps,
    readPaths: repo.readPaths().length,
    changedPaths: changedPaths.length,
    finishReason: result.finishReason,
    usage: result.usage,
  });

  // The authoritative run. The model's own last look at the suite predates its
  // last edit whenever the loop ended the way it should have — fix, then stop —
  // so trusting it would mean reporting a green suite for a tree that has
  // changed since. Costs one more test run per implementation; the alternative
  // is a verification field that is right most of the time.
  await ctx.onProgress();
  const verification = await verifier.verify();

  return {
    summary: result.text.trim(),
    changedPaths,
    verification,
    exhaustedSteps,
  };
}
