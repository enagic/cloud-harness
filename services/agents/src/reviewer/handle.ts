/**
 * The reviewer's work-item handler: read, review, guard, post, transition.
 *
 * Split from main.ts for the reason the other two were — the handler is
 * importable without starting the SQS consume loop, so a live run drives the
 * real code path rather than a reimplementation of it.
 *
 * The write order is the design of this file, as it is in the implementer's.
 * Everything before the lane guard is a read: the diff, the existing comments, a
 * clone in a scratch directory, a test run. Nothing outside this process sees
 * any of it, so a ticket a human took back mid-run costs money and nothing else.
 * The first externally visible act is the first finding, and it happens after
 * consent has been re-read.
 *
 * Where the findings go is HANDOFF decision 9: the pull request, one comment per
 * finding, anchored at the code. Jira gets the transition and a pointer, because
 * Jira tracks the status of the work and does not carry the payload.
 */

import {
  loadBitbucketConfig,
  loadJiraConfig,
  loadLlmConfig,
  loadPipelineConfig,
  type ReviewFeedback,
  type ReviewFinding,
  type ReviewOutcome,
  type ReviewWorkItem,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { JiraWriter } from '../clients/jira.js';
import type { AgentTaskContext } from '../runtime/consumer.js';
import { createAgentModel } from '../runtime/model.js';
import type { Verification } from '../runtime/verifier.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';
import { review, verdict, type RecordedFinding } from './review.js';

/** Keeps a suite's output inside what is reasonable in a pull request comment. */
const COMMENT_OUTPUT_LIMIT = 4_000;

/**
 * The pull-request-level comment: the model's sign-off, and what was run.
 *
 * These are the two genuinely PR-level things a review produces. The findings
 * are not here — each one is its own thread, anchored where it belongs, and
 * repeating them in a summary would recreate the single blob decision 9 exists
 * to prevent.
 */
function summaryComment(args: {
  summary: string;
  verification: Verification;
  outcome: 'approved' | 'changes_requested';
  findings: RecordedFinding[];
  approval?: { status: 'approved' } | { status: 'refused'; reason: string };
}): string {
  const counts = ['blocker', 'major', 'minor']
    .map((severity) => ({
      severity,
      count: args.findings.filter((finding) => finding.severity === severity).length,
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.severity}${entry.count === 1 ? '' : 's'}`);

  const parts = [
    args.outcome === 'approved'
      ? '**Reviewed — approved.**'
      : '**Reviewed — changes requested.**',
    '',
    args.summary,
    '',
    '---',
    '',
    counts.length === 0
      ? 'No findings were raised.'
      : `${counts.join(', ')}, each on its own thread against the code it is about.`,
  ];

  if (!args.verification.attempted) {
    parts.push(
      'The repository declares no test command, so this change was **not executed** — ' +
        'this review read the diff and the code around it, and nothing more.',
    );
  } else {
    parts.push(
      `\`${args.verification.command ?? ''}\` ` +
        (args.verification.passed === true ? 'passed.' : '**failed**.'),
    );
    if (args.verification.passed === false) {
      parts.push('', '```', (args.verification.output ?? '').slice(-COMMENT_OUTPUT_LIMIT), '```');
    }
  }

  // Said out loud rather than swallowed. A pull request sitting in Awaiting
  // Merge with no approval on it looks like the reviewer forgot, and the next
  // person to look would go hunting for a bug that is really a deployment shape.
  if (args.approval?.status === 'refused') {
    parts.push(
      '',
      'Bitbucket would not record an approval from this identity — in this deployment ' +
        'the reviewer and the pull request author are the same account. The verdict above ' +
        `stands regardless. (${args.approval.reason})`,
    );
  }

  return parts.join('\n');
}

/** The Jira side of a send-back: whose turn it is, and where to look. */
function handbackComment(item: ReviewWorkItem, findings: RecordedFinding[]): string {
  const blockers = findings.filter((finding) => finding.severity === 'blocker').length;

  return [
    `Review attempt ${item.attempt} of ${item.maxAttempts} found ` +
      `${blockers === 1 ? '1 blocker' : `${blockers} blockers`}.`,
    '',
    `The findings are on the pull request, each against the code it is about:`,
    item.pullRequestUrl,
  ].join('\n');
}

/** The shared-type shape of a finding: the anchor it was actually posted at. */
function toReviewFinding(finding: RecordedFinding): ReviewFinding {
  return {
    severity: finding.severity,
    message: finding.message,
    ...(finding.anchor.path === undefined ? {} : { path: finding.anchor.path }),
    ...(finding.anchor.line === undefined ? {} : { line: finding.anchor.line }),
  };
}

export async function handleReview(
  ctx: AgentTaskContext<ReviewWorkItem>,
): Promise<ReviewOutcome> {
  const { item, log } = ctx;

  const pipeline = loadPipelineConfig();
  const bitbucket = new BitbucketClient(loadBitbucketConfig('reviewer'), log);
  const jira = new JiraWriter(loadJiraConfig(), pipeline, log);
  const model = createAgentModel(loadLlmConfig(), log);

  log.info('reviewing', {
    branch: item.branch,
    pullRequestUrl: item.pullRequestUrl,
    attempt: `${item.attempt}/${item.maxAttempts}`,
    stack: item.runtime.stack,
  });

  let workdir: string | undefined;
  try {
    // Both reads before the clone, so a credential or a deleted pull request
    // fails in two API calls rather than after a full checkout.
    //
    // The comments are read here rather than carried on the work item, and that
    // is deliberate: a payload on the work item is a snapshot taken at dispatch,
    // and a human may have replied to a finding in the minutes between then and
    // this container starting. See decision 9.
    const diff = await bitbucket.getPullRequestDiff(item.repository, item.pullRequestId);
    const comments = await bitbucket.listPullRequestComments(
      item.repository,
      item.pullRequestId,
    );

    // Full depth and the PR's own branch. No `depth: 1` — the reviewer reads the
    // branch as it stands, and a shallow clone buys nothing here since the diff
    // comes from the API rather than from git.
    workdir = await prepareWorkspace({
      issueKey: item.issueKey,
      repo: item.repository,
      branch: item.branch,
      bitbucket,
      log,
    });

    const result = await review(item, {
      model,
      log,
      workdir,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
      diff,
      comments,
    });

    const outcome = verdict(result.findings, result.verification);

    log.info('review drafted', {
      outcome,
      findings: result.findings.length,
      degraded: result.findings.filter((finding) => finding.anchor.note !== undefined).length,
      exhaustedSteps: result.exhaustedSteps,
      verified: result.verification.attempted,
      passed: result.verification.passed,
    });

    // The lane guard. Consent is re-read here rather than trusted from dispatch,
    // because the work item is many minutes old by now and a human can have
    // taken the ticket back while the model was reading.
    //
    // Three conditions. The label says the agents are still welcome; the column
    // says the ticket has not moved on; and **Code Reviewer**, not Assignee,
    // says this run is the one in flight. Two fields for two roles is what lets
    // one column hold a review and a rebase at the same time without either
    // agent mistaking the other's run for its own.
    const lane = await jira.readLaneState(item.issueKey);
    const inAgentLane = lane.labels.includes(pipeline.labels.agentLane);
    const stillInColumn = lane.status === pipeline.statuses.codeReview;
    const stillOurs = lane.codeReviewerAccountId === pipeline.fields.botAccountId;

    if (!inAgentLane || !stillInColumn || !stillOurs) {
      // Terminal on purpose, and the one path where the reviewer has something
      // to say and no right to say it. Nothing has been posted, so there is
      // nothing to clean up; the review goes to the log and nowhere else.
      log.warn('stood down, ticket is no longer ours', {
        issueKey: item.issueKey,
        inAgentLane,
        status: lane.status,
        codeReviewer: lane.codeReviewerAccountId,
        outcome,
        findings: result.findings.length,
        summary: result.summary,
      });
      return {
        status: 'failed',
        reason: !inAgentLane
          ? 'ticket moved to the human lane while reviewing'
          : !stillInColumn
            ? `ticket moved to ${lane.status} while reviewing`
            : 'the ticket was taken off the bot while reviewing',
        retryable: false,
      };
    }

    // Past here everything is a write. Findings first, each its own thread, so
    // the summary that follows is read against a pull request that already
    // carries the detail.
    //
    // Not idempotent, and deliberately not pretending to be: a redelivery
    // re-runs the model and there is no natural key to match a freshly worded
    // finding against an existing one. What makes that survivable is decision
    // 10 — the second pass reads its own first pass's comments and is told not
    // to raise what is already there.
    for (const finding of result.findings) {
      await bitbucket.commentOnPullRequest(item.repository, item.pullRequestId, {
        text: `**${finding.severity}** — ${finding.message}`,
        ...(finding.anchor.path === undefined ? {} : { path: finding.anchor.path }),
        ...(finding.anchor.line === undefined ? {} : { line: finding.anchor.line }),
      });
      await ctx.onProgress();
    }

    // Approve before the summary, so the summary can say what happened. A
    // refusal here is expected in a deployment where one token is both the
    // implementer and the reviewer, and it does not change the verdict.
    const approval =
      outcome === 'approved'
        ? await bitbucket.approvePullRequest(item.repository, item.pullRequestId)
        : undefined;

    await bitbucket.commentOnPullRequest(item.repository, item.pullRequestId, {
      text: summaryComment({
        summary: result.summary,
        verification: result.verification,
        outcome,
        findings: result.findings,
        ...(approval === undefined ? {} : { approval }),
      }),
    });

    const feedback: ReviewFeedback = {
      summary: result.summary,
      findings: result.findings.map(toReviewFinding),
      verification: result.verification,
    };

    // The transition last, so a failure anywhere above leaves the ticket in
    // Code Review still held by the bot, and the redelivered item retries the
    // whole thing rather than handing a half-reviewed pull request onwards.
    //
    // Nothing here touches the attempt counter, and the reason is worth keeping
    // straight now that the counter has moved: countAttempts counts In Progress
    // → Code Review edges in Jira's own changelog. Sending work back is the
    // opposite edge, so it increments nothing — the *implementer's* next
    // transition does, whenever it happens, which is what makes the count
    // survive no matter who moves the card.
    if (outcome === 'changes_requested') {
      await jira.applyMutation(item.issueKey, {
        comment: handbackComment(item, result.findings),
        status: pipeline.statuses.inProgress,
        codeReviewer: 'clear',
      });
      return { status: 'changes_requested', feedback };
    }

    // Human gate 2, in the QA column where it belongs: the reviewer approved,
    // and a human validates and merges. The reviewer never merges.
    //
    // Code Reviewer is released rather than left pointing at the bot, because
    // at this gate that field means "the person holding the review" — which is
    // what makes gate 2 legible on the board at all.
    await jira.applyMutation(item.issueKey, {
      status: pipeline.statuses.validation,
      codeReviewer: 'clear',
    });
    return { status: 'approved', feedback };
  } finally {
    if (workdir !== undefined) await cleanupWorkspace(workdir, log);
  }
}
