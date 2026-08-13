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

import { generateText, stepCountIs } from 'ai';

import {
  intEnv,
  optionalEnv,
  type ImplementWorkItem,
  type Logger,
} from '@cloud-harness/shared';

import { createRepoTools } from '../runtime/repo-tools.js';
import type { AgentModel } from '../runtime/model.js';
import { createVerifier, type Verification } from '../runtime/verifier.js';
import { createEditTools } from './edit-tools.js';

export type { Verification } from '../runtime/verifier.js';

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
