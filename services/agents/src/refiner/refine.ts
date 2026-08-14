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
 * The run produces two things, and they go to different places. The story is the
 * spec and lands in the description; open questions are conversation and land in
 * a comment. Keeping them apart is what stops the spec silting up with a
 * negotiation the implementer then has to read past. The split is made by a tool
 * the model calls rather than by parsing a separator out of its prose — see
 * `createHandbackTools`.
 *
 * STUB: the prompt is generic and the output is unvalidated. See the TODOs.
 */

import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";

import {
  intEnv,
  optionalEnv,
  type Logger,
  type RefineWorkItem,
} from "@cloud-harness/shared";

import type { AgentModel } from "../runtime/model.js";
import { createRepoTools } from "../runtime/repo-tools.js";

/**
 * How many tool-call rounds the model gets.
 *
 * Low enough that a model which starts reading the whole repository is stopped;
 * high enough for the pattern that actually works — list the tree, search for a
 * concept, read the three files that came back, check one of their neighbours.
 */
const DEFAULT_MAX_STEPS = 12;

/** Past this the model is thinking out loud, not asking. Also bounds the comment. */
const MAX_QUESTIONS = 5;

/** The fibonacci scale the board's Story Points field is pointed on. */
const STORY_POINT_VALUES = [1, 2, 3, 5, 8, 13] as const;

/**
 * Everything the refiner produces that is not the story, behind buffered tools.
 *
 * Three of them now: the open questions, the estimate, and the acceptance
 * criteria. They land in three different places — a comment, a number field and
 * a textarea field — and none of them belongs in the description, which is why
 * none of them is prose the caller has to fish out of the model's output.
 *
 * Intent-shaped and buffered, for two separate reasons.
 *
 * Intent-shaped because that is what survives the move to MCP (HANDOFF decision
 * 8): a tool defined by the workflow keeps its name and its prompt when the body
 * is re-implemented on someone else's primitives, where `jira_update_issue`
 * would not. Buffered because nothing here may write. The lane guard runs after
 * the model finishes, and a tool that wrote mid-loop would have written to a
 * ticket that a human may have taken back — the one thing the guard exists to
 * prevent. So everything accumulates in memory and the caller writes it, once,
 * after it has re-checked consent.
 *
 * Tools rather than conventions in the prose. Asking the model to emit its
 * questions behind a separator we split on, or to end with a `## Estimate`
 * section we regex a number out of, puts a parser back on the path decision 1
 * took one off — and it fails silently, in the direction of publishing the
 * scaffolding into the spec.
 */
export interface HandbackTools {
  tools: ToolSet;
  /** Questions asked during the run, in the order the model asked them. */
  questions: () => string[];
  /** The size the model settled on, if it ever called `set_story_points`. */
  storyPoints: () => number | undefined;
  /** The criteria list, as markdown bullets, if the model wrote one. */
  acceptanceCriteria: () => string | undefined;
}

export function createHandbackTools(log: Logger): HandbackTools {
  const asked: string[] = [];
  let points: number | undefined;
  let criteria: string[] = [];

  return {
    tools: {
      ask_human: tool({
        description:
          "Ask the reviewing human one open question about this ticket. Use this for " +
          "anything you need answered rather than putting it in the story: a genuine " +
          "ambiguity, a missing decision, or a proposal to split work that is too large " +
          "to be one story. The questions are posted as a single comment on the ticket " +
          "when you finish, and answers come back to you on your next pass. Ask only " +
          "what changes what gets built.",
        inputSchema: z.object({
          question: z
            .string()
            .min(1)
            .describe("One self-contained question, in plain prose."),
        }),
        execute: async ({ question }) => {
          const text = question.trim();
          if (text.length === 0) return "Empty question ignored.";
          if (asked.length >= MAX_QUESTIONS) {
            return `Question budget of ${MAX_QUESTIONS} is spent; this one was not recorded. Write the story with what you have and say in the estimate that confidence is low.`;
          }

          asked.push(text);
          log.info("question queued for the human", { question: text });
          return `Recorded question ${asked.length} of at most ${MAX_QUESTIONS}. It will be posted when you finish. Continue; do not wait for an answer.`;
        },
      }),

      // Not decoration, and not a summary: the board's workflow will not let a
      // ticket leave To Do without a number in this field. Leaving the size in
      // prose means a human hand-enters one at every single gate 1.
      set_story_points: tool({
        description:
          "Set the ticket's Story Points, on the fibonacci scale, sizing the work for " +
          "one implementer in one pass. The board requires this before the ticket can " +
          "move to In Progress, so a story without it cannot be started. Anything you " +
          "would put above 13 is not one story: give it 13 and use ask_human to propose " +
          "the split. Call this exactly once; calling it again replaces the value.",
        inputSchema: z.object({
          points: z
            .number()
            .describe("One of 1, 2, 3, 5, 8, 13."),
          why: z.string().min(1).describe("One sentence justifying the size."),
        }),
        execute: async ({ points: value, why }) => {
          if (!STORY_POINT_VALUES.includes(value as (typeof STORY_POINT_VALUES)[number])) {
            return `${value} is not on the scale. Use one of ${STORY_POINT_VALUES.join(", ")}.`;
          }
          points = value;
          log.info("story points recorded", { points: value, why });
          return `Story points set to ${value}. It will be written to the ticket when you finish.`;
        },
      }),

      // Content, not state. The board has a field shaped like a list, so the
      // criteria go in it rather than being buried in the middle of the prose —
      // which makes gate 1 a concrete read for the human and hands the reviewer
      // a checklist instead of a paragraph.
      set_acceptance_criteria: tool({
        description:
          "Set the ticket's Acceptance Criteria: the specific, checkable conditions that " +
          "make this story done. The implementer builds to these and the reviewer verifies " +
          "against them, so each one must be something a person could confirm by looking at " +
          "the finished change. Do not repeat them in the story. Call this exactly once; " +
          "calling it again replaces the list.",
        inputSchema: z.object({
          criteria: z
            .array(z.string().min(1))
            .min(1)
            .describe("One checkable condition per entry, in plain prose."),
        }),
        execute: async ({ criteria: list }) => {
          const cleaned = list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
          if (cleaned.length === 0) return "Empty criteria ignored.";
          criteria = cleaned;
          log.info("acceptance criteria recorded", { count: cleaned.length });
          return `Recorded ${cleaned.length} acceptance criteria. They will be written to the ticket when you finish.`;
        },
      }),
    },
    questions: () => [...asked],
    storyPoints: () => points,
    acceptanceCriteria: () =>
      criteria.length === 0 ? undefined : criteria.map((entry) => `- ${entry}`).join("\n"),
  };
}

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

THE STORY IS THE SPEC, AND ONLY THE SPEC. It is what the implementer builds from
and what the reviewer tests against. Everything you write in it will be treated
as a requirement. So it holds the work and nothing else: no questions, no notes
to the reviewer, no record of what you asked last time or what you were told.
That conversation belongs in comments, and you have a tool for it.

Three things you produce are NOT part of the story, because the board has its own
field or its own place for each of them. Use the tool; do not write them into the
description as well.

- Something you need answered goes to \`ask_human\`, never into the story.
- The acceptance criteria go to \`set_acceptance_criteria\`. They are the
  checkable conditions for done, they live in the ticket's own Acceptance
  Criteria field, and the reviewer works through them one at a time. The story
  says what the work is and where it belongs; the criteria say how anyone can
  tell it is finished.
- The size goes to \`set_story_points\`. The board will not let this ticket be
  started without it.

Call \`set_acceptance_criteria\` and \`set_story_points\` on every ticket, before
you write the story out. A story with no criteria is not refined, and a ticket
with no points cannot leave the column it is in.

The line to draw is **how** versus **what**. How to build it is yours: the
framework, the file layout, the test runner, the port default. Pick one, say so,
move on — a reasonable engineer would, and asking about it wastes a human's
turn. **What to build is not yours.** If the draft leaves open something that
changes what the finished thing *is* — a command-line tool or a web service, one
user or every user, replace the thing or extend it — that is the requester's
decision and they are one comment away. Do not settle it by picking the reading
that makes the story easiest to write.

Asking is cheap and being wrong is not. A question costs the human one reply,
before anyone writes code, and they are already reading this ticket at the
review gate. A wrong guess costs an implementation, a review, and a second
ticket to undo it. When you genuinely cannot tell which side of the line a
decision falls on, ask.
- Once a question has been answered — by a human, or by you deciding it — the
  answer is simply part of the story, written as though it had always been in
  the draft. Recording a decision is useful; narrating that it was ever open is
  not. Write "The server binds 0.0.0.0 by default", not "the draft did not say
  which host, so I picked".

Your entire output is the description of the ticket, replacing what is there.
Start with the story's first heading. No preamble, no note about what you found
in the repository, no summary of what you are about to do, and nothing addressed
to the person reading — they are looking at a Jira ticket, not at a reply. The
sentence "Here is the refined story" has no place in a spec.

Anything you decided on the requester's behalf goes in a short \`## Assumptions\`
section, immediately above the estimate — one line each, stating the choice and
what it rules out. Not narration: this is the list of things a reviewer can
overturn for the price of a comment now and the price of an implementation
later.

Keep that list honest, because you will read it back. **The description you are
given may be your own previous story**, and a choice you made last time is
written into it as though it were a requirement. Anything under \`## Assumptions\`
is still open; anything you carry forward out of it into the body is a decision
you are making again, not one the requester ever made. Never describe a scope
you chose yourself as settled, and never cite the ticket as the authority for it.

End the story with this section, exactly this one field, and nothing else in it:

## Estimate

Confidence: high | medium | low — one sentence of why.

The size does not go here. It goes to \`set_story_points\`, because the board has
a field for it and a workflow rule that reads that field.

Confidence is about the ticket, not about you: how sure you are that this story
is what the requester actually wants. High means the draft and the repository
settled every question that changes the shape of the work. Low means you had to
guess at something material, and the guess is written into the story above — say
which one.

**Deciding a question does not make it answered.** If you asked something,
confidence is not high. If \`## Assumptions\` has anything material in it,
confidence is not high either — the story may be perfectly clear and still be
about the wrong thing, which is the only failure that matters here. Writing "the
scope is unambiguous" about a scope you chose is the specific mistake to avoid,
and so is inheriting that claim from a previous pass.

Anything you would size above 13 is not a story: give it 13, and use
\`ask_human\` to propose the split. Do not split it yourself and do not write a
breakdown into the story — the story describes one piece of work, and deciding a
ticket becomes three tickets is the human's call.

A human reads the confidence and the points side by side at the review gate and
decides what to do with them. Confidence blocks nothing at all, so be honest
rather than reassuring: low confidence on a genuinely underspecified ticket is
the useful answer, and a confident story built on a guess is the expensive one.
Never trade an honest low for a number that reads better.

Scope discipline matters more than completeness. Refine the ticket in front of
you; do not widen it into adjacent work you noticed.

TODO: add the team's own conventions here — the definition of done, the review
bar, and how much design latitude the implementer gets. Everything above is
generic; this is where it stops being generic. Override the whole prompt with
REFINER_SYSTEM_PROMPT.`;

function systemPrompt(): string {
  return optionalEnv("REFINER_SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT;
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
  /** Open questions for the human, in the order asked. Posted as one comment. */
  questions: string[];
  /**
   * The size, for the board's Story Points field.
   *
   * Absent when the model never called `set_story_points`. Not an error: the
   * story is still worth publishing, and the workflow's own validator will stop
   * the ticket at gate 1 until a human puts a number in — which is exactly the
   * fallback that existed before the refiner wrote this field at all. The
   * hand-back comment says so rather than leaving it to be discovered.
   */
  storyPoints?: number;
  /** The criteria list as markdown bullets, for the Acceptance Criteria field. */
  acceptanceCriteria?: string;
  /** Repo-relative paths the model actually opened. */
  readPaths: string[];
  /** True when exploration hit the step budget rather than finishing on its own. */
  exhaustedSteps: boolean;
}

/**
 * The description, plus the comment thread when there is one.
 *
 * This is the whole of the refiner's memory, and it is rehydrated from the
 * ticket rather than stored anywhere. A second pass looks exactly like a first
 * one to the pipeline; what tells them apart is that the description is already
 * a refined story and the thread already has an exchange in it. Nothing tracks
 * which pass this is, deliberately — the ticket is the state, and a human may
 * have edited any part of it in between.
 */
export function draftPrompt(item: RefineWorkItem): string {
  const conversation = item.conversation ?? [];
  const priorPass = conversation.some((comment) => comment.author === "agent");

  const parts = [
    `Ticket: ${item.issueKey}`,
    `Repository: ${item.repository.workspace}/${item.repository.slug}`,
    `Base branch: ${item.repository.baseBranch}`,
    "",
    priorPass
      ? "Description as it stands on the board. You wrote a version of this on an earlier pass and it came back to you; a human may have edited it since. Improve it — do not start over."
      : "Draft description as it stands on the board:",
    item.draftDescription.trim() || "(the draft is empty)",
  ];

  const criteria = item.draftAcceptanceCriteria?.trim();
  if (criteria) {
    parts.push(
      "",
      "Acceptance Criteria field as it stands. Same contract as the description:",
      "improve it, and re-send the whole list through set_acceptance_criteria —",
      "what you send replaces what is there.",
      "",
      criteria,
    );
  }

  if (conversation.length > 0) {
    parts.push(
      "",
      ...(priorPass
        ? [
            'The comment thread on the ticket, oldest first. "You" is the pipeline —',
            'questions you asked on an earlier pass. "Human" is the person reviewing.',
            "Fold anything answered into the story as though it had always been part",
            "of the draft, and re-ask only what is still genuinely open.",
          ]
        : [
            "Comments left on the ticket, oldest first. Nobody has refined this yet,",
            "so treat these as part of the draft rather than as answers.",
          ]),
      "",
      ...conversation.map(
        (comment) =>
          `${comment.author === "agent" ? "You" : "Human"}: ${comment.text.trim()}`,
      ),
    );
  }

  return parts.join("\n");
}

/**
 * Explore the repo, then write the story. Throws on model failure; the caller
 * decides what that means for the work item.
 */
export async function refine(
  item: RefineWorkItem,
  ctx: RefineContext,
): Promise<RefineResult> {
  const repo = createRepoTools({
    root: ctx.workdir,
    log: ctx.log,
    onProgress: ctx.onProgress,
  });
  const handback = createHandbackTools(ctx.log);
  const maxSteps = intEnv("REFINER_MAX_STEPS", DEFAULT_MAX_STEPS);

  const result = await generateText({
    model: ctx.model.model,
    providerOptions: ctx.model.providerOptions,
    maxOutputTokens: ctx.model.maxOutputTokens,
    abortSignal: ctx.signal,
    system: systemPrompt(),
    prompt: draftPrompt(item),
    tools: { ...repo.tools, ...handback.tools },
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

  const questions = handback.questions();
  const storyPoints = handback.storyPoints();
  const acceptanceCriteria = handback.acceptanceCriteria();

  ctx.log.info("refinement complete", {
    steps: result.steps.length,
    maxSteps,
    readPaths: repo.readPaths().length,
    questions: questions.length,
    storyPoints,
    criteria: acceptanceCriteria !== undefined,
    finishReason: result.finishReason,
    usage: result.usage,
  });

  const story = result.text.trim();

  // An empty story is a failed run, not a quiet one, and it is the caller's
  // `failed` branch rather than anything to do with handing back — a refiner
  // with no story has nothing to publish and nothing for a human to review.
  // Providers do this when the last step was a tool call and the budget ended
  // the loop, which is why it is treated as transient: the retry re-runs the
  // exploration and usually lands. The redrive policy bounds how many times.
  if (story.length === 0) {
    throw new Error(
      `${item.issueKey}: the model returned no story after ${result.steps.length} steps ` +
        `(finishReason: ${result.finishReason}). Nothing was written to the ticket.`,
    );
  }

  return {
    story,
    questions,
    ...(storyPoints === undefined ? {} : { storyPoints }),
    ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    readPaths: repo.readPaths(),
    exhaustedSteps,
  };
}
