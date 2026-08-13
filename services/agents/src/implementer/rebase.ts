/**
 * Resolving the conflicts a rebase stops on.
 *
 * Split from handle.ts the way implement.ts is: everything here is the agent's
 * *thinking* plus the tree it thinks in, and nothing here talks to Jira or
 * Bitbucket. The git verbs — fetch, rebase, continue, abort — belong to the
 * Bitbucket client; this file only turns a conflicted working tree into a
 * resolved one.
 *
 * The tool set is deliberately smaller than the implementer's: read tools and
 * write tools, and **no `run_tests`**. The tree is mid-rebase, so it holds one
 * replayed commit rather than the finished branch, and a suite run against it
 * would answer a question nobody asked — on a two-commit branch it would fail on
 * work that is still to be replayed. The suite runs once, after the rebase
 * finishes, where its answer is about something real.
 *
 * Note what this is not: a merge strategy. It cannot be, because the conflicts
 * worth resolving here are the ones git already refused to resolve mechanically.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateText, stepCountIs } from 'ai';

import {
  intEnv,
  optionalEnv,
  type ImplementWorkItem,
  type Logger,
} from '@cloud-harness/shared';

import { createRepoTools } from '../runtime/repo-tools.js';
import type { AgentModel } from '../runtime/model.js';
import { createEditTools } from './edit-tools.js';

/**
 * How many tool-call rounds the model gets per conflicted step.
 *
 * Smaller than the implementer's thirty because the job is bounded by the
 * conflict itself: read each conflicted file, understand both sides, write it
 * back. There is no suite to iterate against and nothing to explore beyond the
 * files git named.
 */
const DEFAULT_MAX_STEPS = 20;

export const DEFAULT_REBASE_SYSTEM_PROMPT = `You are resolving merge conflicts left by a rebase.

A branch implementing a ticket is being replayed onto its base branch, and git
stopped because it could not combine two changes to the same lines. Your job is
to produce the correct combined file — nothing else.

**Which side is which.** During a rebase the labels are the opposite of what most
people expect. \`<<<<<<< HEAD\` is the **base branch** — other people's merged
work, already on the target branch. \`>>>>>>> \` is **this ticket's own commit**,
the change being replayed. Read that carefully before you decide anything: taking
"ours" to mean the ticket's change is the single most common way this goes wrong.

**What a correct resolution looks like.** Both sides are wanted. Someone else's
merged work is not noise to be overwritten, and the ticket's change is what this
branch exists for. Combine them so both intents survive: usually that means
keeping the base branch's version of what it changed and re-applying the ticket's
change on top of it. Discard a side only when keeping it would be plainly wrong —
the same fix arriving twice, or a line the base branch deliberately deleted.

**How to do it.** Read every conflicted file in full before writing it. Write the
whole file back with \`write_file\`, with **every conflict marker removed** —
\`<<<<<<<\`, \`=======\`, \`>>>>>>>\` and anything git put between them. A file
you leave a marker in is a broken file, and it will be rejected.

Read the files around a conflict when the right resolution is not obvious from
the conflicted file alone. A rename on one side, or a function whose signature
changed under the ticket's caller, is only visible from the neighbours.

**Stay inside the conflict.** Do not fix, tidy, reformat or improve anything the
conflict did not force you to touch. This change is going back to a human who
approved a different diff, and every line you add that the conflict did not
require is a line they did not ask for.

You cannot run the tests here — the tree is mid-rebase and holds only part of the
branch. The suite runs on the finished result, so say plainly in your summary
anything you were unsure about.

Your closing message goes to the humans watching the ticket. Say, per file, what
the conflict was and how you resolved it, in prose. Be brief and specific.`;

function systemPrompt(): string {
  return optionalEnv('IMPLEMENTER_REBASE_SYSTEM_PROMPT') ?? DEFAULT_REBASE_SYSTEM_PROMPT;
}

export interface ResolveContext {
  model: AgentModel;
  log: Logger;
  workdir: string;
  signal: AbortSignal;
  /** Extends the SQS visibility timeout. Called after every tool and step. */
  onProgress: () => Promise<void>;
}

export interface ResolveResult {
  /** The model's closing prose. Goes to the board, not into a commit message. */
  summary: string;
  /** Conflicted paths the model wrote or deleted. */
  resolvedPaths: string[];
  /**
   * Conflicted paths that are still not fit to stage, and why. Empty means the
   * rebase can continue.
   */
  unresolved: UnresolvedPath[];
  /** True when the loop hit the step budget rather than finishing on its own. */
  exhaustedSteps: boolean;
}

export interface UnresolvedPath {
  path: string;
  reason: 'untouched' | 'conflict_markers';
}

/** What git stopped on, and the story it stopped in the middle of. */
export function conflictPrompt(item: ImplementWorkItem, paths: string[]): string {
  return [
    `Ticket: ${item.issueKey}`,
    `Title: ${item.title}`,
    `Repository: ${item.repository.workspace}/${item.repository.slug}`,
    `Base branch being rebased onto: ${item.repository.baseBranch}`,
    '',
    'Conflicted files:',
    ...paths.map((path) => `  - ${path}`),
    '',
    // The story is context, not the task. It is here because a resolution
    // frequently turns on what the ticket was trying to do — which of two
    // competing edits is the one this branch exists for — and without it the
    // model is choosing between two anonymous diffs.
    'The story this branch implements, for context on what its change is for:',
    '',
    item.refinedDescription.trim() || '(the story is empty)',
  ].join('\n');
}

/**
 * Does this file still carry conflict markers?
 *
 * `<<<<<<<` and `>>>>>>>` only, never `=======`: a row of equals signs at the
 * start of a line is a setext heading in Markdown and a section underline in
 * reStructuredText, both of which are ordinary content in a repository, and
 * rejecting a correctly resolved README over one would be maddening. The two
 * angle-bracket markers have no such second life.
 */
export function hasConflictMarkers(content: string): boolean {
  return /^(<{7}|>{7})(\s|$)/m.test(content);
}

/**
 * Check the model's work before git is asked to stage it.
 *
 * This exists because `git add -A` believes whatever it is given. A file still
 * full of markers stages happily, `git rebase --continue` commits it, and the
 * branch is pushed with `<<<<<<< HEAD` in the middle of it — a failure that
 * looks like a successful rebase from every angle except reading the diff.
 *
 * Two ways to fail, and the second one is the reason this takes `written` at
 * all. A conflict with no markers to remove — a binary file, or a file deleted
 * on one side and modified on the other — is not resolvable by writing text, and
 * a marker scan alone would call it clean and stage git's unresolved copy. So a
 * conflicted path the model never touched counts as unresolved regardless of
 * what is in it.
 */
export async function unresolvedPaths(
  workdir: string,
  conflicted: string[],
  written: Set<string>,
): Promise<UnresolvedPath[]> {
  const unresolved: UnresolvedPath[] = [];

  for (const path of conflicted) {
    if (!written.has(path)) {
      unresolved.push({ path, reason: 'untouched' });
      continue;
    }

    // Written and now gone is a resolution: the delete/modify conflict settled
    // in favour of the delete.
    const content = await readFile(join(workdir, path), 'utf8').catch(() => undefined);
    if (content === undefined) continue;

    if (hasConflictMarkers(content)) {
      unresolved.push({ path, reason: 'conflict_markers' });
    }
  }

  return unresolved;
}

/**
 * Resolve the conflicts in `ctx.workdir`. Throws on model failure; the caller
 * decides what that means for the work item.
 *
 * Leaves the rebase in progress either way — staging and continuing is the
 * caller's, because it is the caller that knows whether the result is fit to go
 * anywhere.
 */
export async function resolveConflicts(
  item: ImplementWorkItem,
  paths: string[],
  ctx: ResolveContext,
): Promise<ResolveResult> {
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

  const maxSteps = intEnv('IMPLEMENTER_REBASE_MAX_STEPS', DEFAULT_MAX_STEPS);

  const result = await generateText({
    model: ctx.model.model,
    providerOptions: ctx.model.providerOptions,
    maxOutputTokens: ctx.model.maxOutputTokens,
    abortSignal: ctx.signal,
    system: systemPrompt(),
    prompt: conflictPrompt(item, paths),
    tools: { ...repo.tools, ...edits.tools },
    stopWhen: stepCountIs(maxSteps),
    onStepFinish: async () => {
      await ctx.onProgress();
    },
  });

  const exhaustedSteps = result.steps.length >= maxSteps;
  const written = new Set(edits.changedPaths());
  const unresolved = await unresolvedPaths(ctx.workdir, paths, written);

  ctx.log.info('conflict resolution loop finished', {
    steps: result.steps.length,
    maxSteps,
    conflicted: paths.length,
    written: written.size,
    unresolved: unresolved.length,
    finishReason: result.finishReason,
    usage: result.usage,
  });

  return {
    summary: result.text.trim(),
    resolvedPaths: paths.filter((path) => written.has(path)),
    unresolved,
    exhaustedSteps,
  };
}
