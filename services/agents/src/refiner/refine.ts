/**
 * Producing a refined story from a draft ticket and a checked-out repository.
 *
 * Split from main.ts on purpose: everything here is the agent's *thinking*, and
 * nothing here writes to Jira or Bitbucket. That makes the interesting half of
 * the refiner runnable against a real ticket and a real model without mutating
 * anyone's board.
 *
 * One model call, not two. `generateText` with the repo tools and a step budget
 * is the tool loop the AI SDK exists to provide — the model reads its way around
 * the repository until it has enough, then writes the story. There is no second
 * structured-output pass because the refined story is prose (HANDOFF decision 1);
 * with nothing to parse, a schema call would only add a failure mode.
 *
 * STUB: the prompt is generic and the output is unvalidated. See the TODOs.
 */

import { generateText, stepCountIs } from 'ai';

import { intEnv, optionalEnv, type Logger, type RefineWorkItem } from '@cloud-harness/shared';

import type { AgentModel } from '../runtime/model.js';
import { createRepoTools } from './repo-tools.js';

/**
 * How many tool-call rounds the model gets.
 *
 * Low enough that a model which starts reading the whole repository is stopped;
 * high enough for the pattern that actually works — list the tree, search for a
 * concept, read the three files that came back, check one of their neighbours.
 */
const DEFAULT_MAX_STEPS = 12;

export const DEFAULT_SYSTEM_PROMPT = `You refine Jira tickets into implementable stories.

A story is implementable when an engineer who has never seen the draft can start
work without asking what was meant. That means concrete acceptance criteria, and
enough repository context that the implementer does not have to rediscover where
the work belongs.

You have READ-ONLY access to the repository the work will land in. Use it:

- Name the specific files and modules the change touches. Only name paths you
  have actually opened or found by searching; a confidently wrong path costs the
  implementer more than no path at all.
- Point at prior art. If this codebase already solves a similar problem, the
  implementer should follow that pattern rather than invent a second one.

Write the story as prose with headings — the kind of thing a person would write.
A human reads it next and may edit it before an agent sees it again, so do not
emit JSON, and do not invent a format that would break when someone edits around
it.

Scope discipline matters more than completeness. Refine the ticket in front of
you; do not widen it into adjacent work you noticed. Where the draft is
genuinely ambiguous and the answer changes what gets built, raise it as an open
question. Where a reasonable engineer would just pick one, pick one and say so.

TODO: add the team's own conventions here — the definition of done, the review
bar, and how much design latitude the implementer gets. Everything above is
generic; this is where it stops being generic. Override the whole prompt with
REFINER_SYSTEM_PROMPT.`;

function systemPrompt(): string {
  return optionalEnv('REFINER_SYSTEM_PROMPT') ?? DEFAULT_SYSTEM_PROMPT;
}

/** What the caller supplies beyond the work item: a model, a clone, and a log. */
export interface RefineContext {
  model: AgentModel;
  log: Logger;
  workdir: string;
  signal: AbortSignal;
  /** Extends the SQS visibility timeout. Called after every tool and step. */
  onProgress: () => Promise<void>;
}

export interface RefineResult {
  /** The refined story, as prose. Ready to go into the Jira description. */
  story: string;
  /** Repo-relative paths the model actually opened. */
  readPaths: string[];
  /** True when exploration hit the step budget rather than finishing on its own. */
  exhaustedSteps: boolean;
}

/** The draft, plus the human's feedback when this is a second pass. */
function draftPrompt(item: RefineWorkItem): string {
  const parts = [
    `Ticket: ${item.issueKey}`,
    `Repository: ${item.repository.workspace}/${item.repository.slug}`,
    `Base branch: ${item.repository.baseBranch}`,
    '',
    'Draft description as it stands on the board:',
    item.draftDescription.trim() || '(the draft is empty)',
  ];

  if (item.reviewerComments?.length) {
    parts.push(
      '',
      'A human reviewed a previous refinement and sent it back with the comments',
      'below. Revise the story to address them — do not start over.',
      ...item.reviewerComments.map((comment, i) => `${i + 1}. ${comment.trim()}`),
    );
  }

  return parts.join('\n');
}

/**
 * Explore the repo, then write the story. Throws on model failure; the caller
 * decides what that means for the work item.
 */
export async function refine(item: RefineWorkItem, ctx: RefineContext): Promise<RefineResult> {
  const repo = createRepoTools({ root: ctx.workdir, log: ctx.log, onProgress: ctx.onProgress });
  const maxSteps = intEnv('REFINER_MAX_STEPS', DEFAULT_MAX_STEPS);

  const result = await generateText({
    model: ctx.model.model,
    providerOptions: ctx.model.providerOptions,
    maxOutputTokens: ctx.model.maxOutputTokens,
    abortSignal: ctx.signal,
    system: systemPrompt(),
    prompt: draftPrompt(item),
    tools: repo.tools,
    stopWhen: stepCountIs(maxSteps),
    onStepFinish: async () => {
      // The tool loop can run for minutes; keep the SQS message ours.
      await ctx.onProgress();
    },
  });

  // `stopWhen` firing means the model was still working when the budget ran
  // out, so the story was written from a partial picture. Surfaced rather than
  // thrown: a story from eleven files is usually still useful, and the caller
  // is better placed to decide.
  const exhaustedSteps = result.steps.length >= maxSteps;

  ctx.log.info('refinement complete', {
    steps: result.steps.length,
    maxSteps,
    readPaths: repo.readPaths().length,
    finishReason: result.finishReason,
    usage: result.usage,
  });

  // TODO: the model can return an empty string here — some providers do it when
  // the last step was a tool call and the budget ended the loop. Decide whether
  // that is a retry, a hand-back (HANDOFF decision 4), or a second call that
  // asks for the story with the tools removed.
  return { story: result.text.trim(), readPaths: repo.readPaths(), exhaustedSteps };
}
