/**
 * Reviewing a pull request against the story it is meant to satisfy.
 *
 * Split from handle.ts the same way refine.ts and implement.ts are: everything
 * here is the agent's *thinking*, and nothing here writes to Jira or Bitbucket.
 * The reviewer reads the diff, reads around it in the checked-out branch, runs
 * the repository's own suite, and records findings in memory. Not one of them is
 * posted until the caller has re-read consent.
 *
 * Two things make this agent different from the other two.
 *
 * **Findings are collected through a buffered tool, not a structured-output
 * call.** The obvious route is `generateObject` against a `ReviewFeedback`
 * schema, and it was not taken. A findings pass has to interleave with
 * exploration — read the diff, look at the caller, run the tests, then say what
 * is wrong — and a schema call is a single shot at the end that cannot use
 * tools. It would mean two model calls, the second re-deriving what the first
 * already knew. `report_finding` is the same shape the refiner's `ask_human`
 * already proved: intent-shaped, per decision 8, so a later move to MCP
 * re-implements a body and changes no prompt.
 *
 * **The anchor is resolved when the finding is recorded, not when it is posted.**
 * Bitbucket accepts an inline comment on a line that does not exist, so there is
 * no rejection to degrade from — see reviewer/diff.ts. Resolving at record time
 * means the model is *told* its anchor did not land while it can still do
 * something about it.
 */

import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import { z } from 'zod';

import {
  intEnv,
  optionalEnv,
  type Logger,
  type PullRequestComment,
  type ReviewWorkItem,
} from '@cloud-harness/shared';

import type { AgentModel } from '../runtime/model.js';
import { createRepoTools } from '../runtime/repo-tools.js';
import { createVerifier, type Verification } from '../runtime/verifier.js';
import { describeDiff, parseDiff, resolveAnchor, type ResolvedAnchor } from './diff.js';

/**
 * How many tool-call rounds the model gets.
 *
 * Between the refiner's twelve and the implementer's thirty. The reviewer reads
 * more than the refiner — it has a diff *and* the code around it — but it writes
 * nothing and re-runs nothing, so it has no fix-and-check cycle to pay for.
 */
const DEFAULT_MAX_STEPS = 20;

/**
 * How many times the reviewer may run the suite.
 *
 * Far below the implementer's six. The reviewer's suite run answers one question
 * and nothing it does changes the answer; a second run is for flakiness, and a
 * third is a loop.
 */
const MAX_TEST_RUNS = 2;

/**
 * Past this a review is a rewrite request, not a review.
 *
 * The cap is not really about cost — it is about what a human does with the
 * result. Fifteen threads on one pull request is already more than anyone reads,
 * and a reviewer that finds thirty things has either misunderstood the story or
 * is reviewing the codebase rather than the change.
 */
const MAX_FINDINGS = 15;

/** The diff goes in the prompt whole up to here; past it the model reads files. */
const MAX_DIFF_CHARS = 60_000;

export type Severity = 'blocker' | 'major' | 'minor';

/** A finding, with the address it will actually be posted at. */
export interface RecordedFinding {
  severity: Severity;
  /** The model's text, plus a note when the anchor had to degrade. */
  message: string;
  anchor: ResolvedAnchor;
}

export interface FindingTools {
  tools: ToolSet;
  findings: () => RecordedFinding[];
}

/**
 * `report_finding` — one finding, one thread, one call.
 *
 * Buffered for the same reason `ask_human` is: nothing may write before the lane
 * guard. A tool that posted its comment mid-loop would have written to a pull
 * request whose ticket a human may have taken back, which is the one thing the
 * guard exists to prevent. So findings accumulate in memory and the caller posts
 * them after consent has been re-read.
 *
 * One call per finding rather than a list, because that is how they are posted —
 * a comment carrying five findings forces every reply to say which of the five
 * it is about, and threading is what pairs a reply with its topic for free.
 */
export function createFindingTools(options: {
  log: Logger;
  files: ReturnType<typeof parseDiff>;
  onProgress?: () => Promise<void>;
}): FindingTools {
  const recorded: RecordedFinding[] = [];

  return {
    tools: {
      report_finding: tool({
        description:
          'Report one problem with this pull request, anchored at the code it is about. ' +
          'Call this once per problem — each one becomes its own comment thread that ' +
          'someone can reply to. Anchor it as tightly as you honestly can: give a path ' +
          'and a line for a problem with a specific line, a path alone for a claim about ' +
          'a whole file, and neither only for a claim about the change as a whole. ' +
          'Only blockers send the pull request back.',
        inputSchema: z.object({
          severity: z
            .enum(['blocker', 'major', 'minor'])
            .describe(
              'blocker: this must be fixed before the change can merge. major: a real ' +
                'problem the author should address. minor: worth saying, not worth blocking.',
            ),
          path: z
            .string()
            .optional()
            .describe('Repository-relative path this is about, when it is about one.'),
          line: z
            .number()
            .int()
            .optional()
            .describe('Line number in the changed file. Only lines in the diff can be used.'),
          message: z
            .string()
            .min(1)
            .describe(
              'What is wrong and what to do about it, in prose. Self-contained: it is read ' +
                'next to the code, not next to your other findings.',
            ),
        }),
        execute: async ({ severity, path, line, message }): Promise<string> => {
          try {
            const text = message.trim();
            if (text.length === 0) return 'Empty finding ignored.';
            if (recorded.length >= MAX_FINDINGS) {
              return (
                `The finding budget of ${MAX_FINDINGS} is spent; this one was not recorded. ` +
                'Put anything else in your closing summary.'
              );
            }

            const anchor = resolveAnchor(options.files, { path, line });
            recorded.push({
              severity,
              // The note is part of the message rather than metadata because it
              // is read by a human next to the finding, and "this was meant for
              // line 40" is the sentence that keeps a degraded finding usable.
              message: anchor.note === undefined ? text : `${text}\n\n${anchor.note}`,
              anchor,
            });

            options.log.info('finding recorded', {
              severity,
              tier: anchor.tier,
              path: anchor.path,
              line: anchor.line,
              degraded: anchor.note !== undefined,
            });

            const where =
              anchor.tier === 'line'
                ? `on ${anchor.path}:${anchor.line ?? 0}`
                : anchor.tier === 'file'
                  ? `on ${anchor.path} as a whole`
                  : 'on the pull request as a whole';

            return anchor.note === undefined
              ? `Recorded finding ${recorded.length} of at most ${MAX_FINDINGS}, ${where}.`
              : `Recorded finding ${recorded.length} of at most ${MAX_FINDINGS}, but not where ` +
                `you aimed it: ${anchor.note} It will be posted ${where}. If you meant a ` +
                'different line, report it again with one that is in the diff.';
          } finally {
            await options.onProgress?.();
          }
        },
      }),
    },
    findings: () => [...recorded],
  };
}

export const DEFAULT_SYSTEM_PROMPT = `You review a pull request against the story it was written to satisfy.

The story is the spec. It was refined, a human approved it, and the implementer
built from it. Your question is whether this change does what that story asked —
not whether it is the change you would have written.

Read before you judge. You have the branch checked out and tools to list, read
and search it, and you have the diff. The diff tells you what changed; the
repository tells you whether it fits. A change that looks wrong in isolation and
right in context is the most common thing a hasty reviewer gets wrong.

Run the tests. \`run_tests\` executes the repository's own suite, and its result
is the one piece of evidence in your review that is not an opinion. Run it once
before you conclude anything.

Report each problem separately with \`report_finding\`. Each call becomes its own
comment thread on the pull request, anchored at the code, and someone may reply
to it — so make each one self-contained and say what should change, not just what
is wrong. A finding that only names a problem costs the implementer a round trip
to ask what you wanted.

Anchor as tightly as you honestly can. A problem with a line goes on that line. A
claim about a whole file — it is dead code now, it belongs somewhere else — goes
on the file. Only a claim about the change as a whole goes on neither, and those
should be rare. You will be told which lines the diff makes addressable; a line
outside them cannot be anchored and your finding will be moved outward, so aim at
a line the diff actually contains.

**Severity decides what happens next, so spend it carefully.**

- \`blocker\` sends the pull request back to the implementer and spends one of a
  small number of attempts. Use it when the change does not do what the story
  asked, when it is broken, or when it introduces a genuine hazard.
- \`major\` is a real problem the author should fix. It does not send the change
  back on its own.
- \`minor\` is worth saying and not worth anyone's time to argue about.

Style preferences are not blockers. Neither is a design you would have done
differently, if the one in front of you works and the story did not specify. The
budget exists for disagreements about whether the work is done, and a round trip
spent on a naming preference is one that is not available when something is
actually wrong.

**You have almost certainly seen this pull request before.** The existing comment
threads are in your prompt, including the ones marked resolved and the ones the
implementer pushed back on. Read them first. Do not re-raise something that was
answered, argued down, or already fixed — that is the single most expensive thing
you can do here, because it burns an attempt on a disagreement neither side
remembers having. If a previous finding of yours is genuinely still unaddressed,
say so as a new finding and reference what was said before.

Your closing message is posted as a comment on the pull request as a whole. It is
what a human reads to decide whether to merge. Say what the change does, what you
checked, what the suite said, and what you concluded. Prose, no preamble, nothing
addressed to a reader — write it the way a senior engineer signs off on a review.
Do not list your findings again; they are already threads of their own.

TODO: add the team's own review bar here — what counts as a blocker in this
codebase, which checks are automated elsewhere and should not be duplicated, and
the conventions a newcomer would get wrong. Everything above is generic; this is
where it stops being generic. Override the whole prompt with REVIEWER_SYSTEM_PROMPT.`;

function systemPrompt(): string {
  return optionalEnv('REVIEWER_SYSTEM_PROMPT') ?? DEFAULT_SYSTEM_PROMPT;
}

export interface ReviewContext {
  model: AgentModel;
  log: Logger;
  workdir: string;
  signal: AbortSignal;
  onProgress: () => Promise<void>;
  /** The pull request's three-dot diff, as Bitbucket serves it. */
  diff: string;
  /** Every existing comment on the pull request, oldest first. See decision 10. */
  comments: PullRequestComment[];
}

export interface ReviewResult {
  /** The model's closing prose. Becomes the pull-request-level comment. */
  summary: string;
  findings: RecordedFinding[];
  /** The authoritative post-loop suite run, not whatever the model last saw. */
  verification: Verification;
  exhaustedSteps: boolean;
}

/**
 * The existing threads, tagged and in order.
 *
 * Injected rather than offered as a tool, and that is decision 10's other half.
 * The choice looks like a toss-up until you notice this codebase has already run
 * the experiment: the refiner's `ask_human` went three consecutive live runs
 * without being called once — a working, well-described, genuinely needed tool
 * the model simply declined to reach for. Betting that a model will volunteer to
 * go and read its own history is betting on exactly that behaviour. Awareness is
 * deterministic; only depth can be lazy.
 */
export function describeThreads(comments: PullRequestComment[]): string {
  if (comments.length === 0) {
    return 'There are no comments on this pull request. This is the first review of it.';
  }

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const roots = comments.filter(
    (comment) => comment.parentId === undefined || !byId.has(comment.parentId),
  );

  const lines = [
    'Existing comment threads on this pull request, oldest first. "You" is the',
    'pipeline — findings from an earlier review pass. "Human" is a person.',
    'Resolved threads are included deliberately: a thing that was answered or',
    'argued down must not be raised again.',
    '',
  ];

  for (const root of roots) {
    const replies = comments.filter((comment) => comment.parentId === root.id);
    const where =
      root.path === undefined
        ? 'on the pull request'
        : root.line === undefined
          ? `on ${root.path}`
          : `on ${root.path}:${root.line}`;

    lines.push(`--- Thread ${where}${root.resolved ? ' (RESOLVED)' : ''}`);
    for (const comment of [root, ...replies]) {
      lines.push(`${comment.author === 'agent' ? 'You' : 'Human'}: ${comment.text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** The story, the change, and everything already said about it. */
export function reviewPrompt(
  item: ReviewWorkItem,
  args: { diff: string; files: ReturnType<typeof parseDiff>; comments: PullRequestComment[] },
): string {
  const diff =
    args.diff.length > MAX_DIFF_CHARS
      ? `${args.diff.slice(0, MAX_DIFF_CHARS)}\n\n…the diff is truncated here at ${MAX_DIFF_CHARS} characters. Read the remaining files directly.`
      : args.diff || '(the pull request has an empty diff)';

  // The criteria are a checklist rather than a paragraph, which is the point of
  // the board carrying them in their own field: a review that works through
  // them one at a time is a different and better review than one that reads a
  // story and forms an impression.
  const criteria = item.acceptanceCriteria?.trim();

  return [
    `Ticket: ${item.issueKey}`,
    `Title: ${item.title}`,
    `Repository: ${item.repository.workspace}/${item.repository.slug}`,
    `Pull request: #${item.pullRequestId} — ${item.pullRequestUrl}`,
    `Branch: ${item.branch} onto ${item.repository.baseBranch}`,
    `Review attempt ${item.attempt} of ${item.maxAttempts}.`,
    '',
    'The approved story. This is what the change is meant to do:',
    '',
    item.refinedDescription.trim() || '(the story is empty)',
    '',
    ...(criteria
      ? [
          'The acceptance criteria a human approved. Check each one against the change',
          'and raise a finding for any that is not met — an unmet criterion is a blocker,',
          'not a nitpick, however good the code around it is:',
          '',
          criteria,
          '',
        ]
      : []),
    'Where a finding can be anchored. A line outside these cannot be commented on:',
    '',
    describeDiff(args.files),
    '',
    describeThreads(args.comments),
    '',
    'The diff:',
    '',
    diff,
  ].join('\n');
}

/**
 * The verdict, and it is arithmetic rather than judgement.
 *
 * The model chooses severities; it does not choose the outcome. That split is
 * decision 7's principle applied one level out — the thing that spends an
 * attempt should not itself be stochastic — and it keeps the rule legible: any
 * blocker sends the change back, and so does a suite that fails.
 *
 * A failing suite is a blocker on its own and does not need the model to agree,
 * because it is the one fact in a review that is not an opinion. An *absent*
 * suite is not: a repo that declares no test command produced a change nobody
 * could execute, which is a property of the repo rather than a fault in the
 * change. The summary says so; it does not block.
 */
export function verdict(
  findings: RecordedFinding[],
  verification: Verification,
): 'approved' | 'changes_requested' {
  if (verification.attempted && verification.passed === false) return 'changes_requested';
  return findings.some((finding) => finding.severity === 'blocker')
    ? 'changes_requested'
    : 'approved';
}

/**
 * Review the change in `ctx.workdir`. Throws on model failure; the caller
 * decides what that means for the work item.
 *
 * Writes nothing. Every finding it produces is in memory when this returns.
 */
export async function review(item: ReviewWorkItem, ctx: ReviewContext): Promise<ReviewResult> {
  const files = parseDiff(ctx.diff);

  const repo = createRepoTools({
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
    maxRuns: MAX_TEST_RUNS,
  });
  const reporting = createFindingTools({ log: ctx.log, files, onProgress: ctx.onProgress });

  const maxSteps = intEnv('REVIEWER_MAX_STEPS', DEFAULT_MAX_STEPS);

  const result = await generateText({
    model: ctx.model.model,
    providerOptions: ctx.model.providerOptions,
    maxOutputTokens: ctx.model.maxOutputTokens,
    abortSignal: ctx.signal,
    system: systemPrompt(),
    prompt: reviewPrompt(item, { diff: ctx.diff, files, comments: ctx.comments }),
    tools: { ...repo.tools, ...verifier.tools, ...reporting.tools },
    stopWhen: stepCountIs(maxSteps),
    onStepFinish: async () => {
      await ctx.onProgress();
    },
  });

  const exhaustedSteps = result.steps.length >= maxSteps;
  const findings = reporting.findings();

  ctx.log.info('review loop finished', {
    steps: result.steps.length,
    maxSteps,
    readPaths: repo.readPaths().length,
    findings: findings.length,
    blockers: findings.filter((finding) => finding.severity === 'blocker').length,
    finishReason: result.finishReason,
    usage: result.usage,
  });

  // The authoritative run, for the same reason the implementer has one: the
  // model's own last look at the suite may predate the last thing it learned,
  // and `verification` is the half of the review a human is entitled to trust.
  // Here it is also the verdict's other input, so it must not be the model's
  // recollection of a run.
  await ctx.onProgress();
  const verification = await verifier.verify();

  const summary = result.text.trim();

  // An empty summary is a failed run rather than a quiet one, exactly as an
  // empty story is for the refiner: there is nothing to post at the pull request
  // level and nothing for a human to read at gate 2. Providers do this when the
  // last step was a tool call and the budget ended the loop, so it is transient
  // — the retry re-runs the review, and the redrive policy bounds it.
  if (summary.length === 0) {
    throw new Error(
      `${item.issueKey}: the model returned no review summary after ${result.steps.length} steps ` +
        `(finishReason: ${result.finishReason}). Nothing was posted to the pull request.`,
    );
  }

  return { summary, findings, verification, exhaustedSteps };
}
