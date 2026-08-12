/**
 * The implementer's work-item handler: clone, branch, implement, guard, push.
 *
 * Split from main.ts for the reason refiner/handle.ts was — the handler is
 * importable without starting the SQS consume loop, so a live run drives the
 * real code path rather than a reimplementation of it.
 *
 * The write order is the whole design of this file. Everything before the lane
 * guard is local: a clone in a scratch directory, edits to files nobody else can
 * see, a test run. Nothing outside this process observes any of it, so a ticket
 * a human took back mid-run costs money and nothing else. The first externally
 * visible act is the push, and it happens after consent has been re-read.
 *
 * IMPLEMENTED: the `initial` reason. `changes_requested` and `rebase` continue a
 * branch that already exists and need review findings or a conflict in front of
 * the model; both are still stubs and are rejected up front rather than half
 * handled.
 */

import {
  loadBitbucketConfig,
  loadJiraConfig,
  loadLlmConfig,
  loadPipelineConfig,
  type ImplementOutcome,
  type ImplementWorkItem,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { JiraWriter } from '../clients/jira.js';
import type { AgentTaskContext } from '../runtime/consumer.js';
import { createAgentModel } from '../runtime/model.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';
import { implement, type Verification } from './implement.js';

/** Keeps a failing suite's output inside what is reasonable in a Jira comment. */
const COMMENT_OUTPUT_LIMIT = 4_000;

/**
 * The comment left when the implementation is not fit to review.
 *
 * Written for the human who has to pick it up, so it says what was attempted and
 * what the suite said, and it does not pretend the branch exists — nothing was
 * pushed. See the stopHere path below for why.
 */
function failureComment(args: {
  reason: string;
  summary: string;
  verification: Verification;
}): string {
  const parts = [
    `I could not produce a change worth reviewing: ${args.reason}`,
    '',
    'Nothing was pushed and no pull request was opened.',
  ];

  if (args.summary.length > 0) {
    parts.push('', '## What I was doing', '', args.summary);
  }

  if (args.verification.attempted && args.verification.passed === false) {
    parts.push(
      '',
      '## Test output',
      '',
      `\`${args.verification.command ?? 'the test command'}\` failed:`,
      '',
      (args.verification.output ?? '').slice(-COMMENT_OUTPUT_LIMIT),
    );
  }

  return parts.join('\n');
}

/** The pull request body: the model's own summary, plus what the suite said. */
function pullRequestDescription(args: {
  issueKey: string;
  summary: string;
  verification: Verification;
}): string {
  const verification = args.verification.attempted
    ? args.verification.passed === true
      ? `\`${args.verification.command ?? ''}\` passed.`
      : `\`${args.verification.command ?? ''}\` did not pass.`
    : 'The repository declares no test command, so this change was not executed.';

  return [
    args.summary,
    '',
    '---',
    '',
    `Implemented for ${args.issueKey} by the cloud-harness implementer.`,
    `Verification: ${verification}`,
  ].join('\n');
}

export async function handleImplement(
  ctx: AgentTaskContext<ImplementWorkItem>,
): Promise<ImplementOutcome> {
  const { item, log } = ctx;

  if (item.reason !== 'initial') {
    // Terminal, not retryable: redelivering this reaches the same line. The
    // ticket is left in Implementing for a human to move, which is visible on
    // the board rather than silently idle.
    return {
      status: 'failed',
      reason: `the "${item.reason}" path is not implemented yet`,
      retryable: false,
    };
  }

  const bitbucket = new BitbucketClient(loadBitbucketConfig('implementer'), log);
  const jira = new JiraWriter(loadJiraConfig(), log);
  const pipeline = loadPipelineConfig();
  const model = createAgentModel(loadLlmConfig(), log);

  const branch = BitbucketClient.branchNameFor(item.issueKey, item.title);

  log.info('implementing', {
    reason: item.reason,
    attempt: `${item.attempt}/${item.maxAttempts}`,
    branch,
    stack: item.runtime.stack,
  });

  let workdir: string | undefined;
  try {
    // No depth. Unlike the refiner this workspace produces commits, and the
    // rebase path will eventually need to replay them onto a base branch a
    // shallow clone would not have.
    workdir = await prepareWorkspace({
      issueKey: item.issueKey,
      repo: item.repository,
      bitbucket,
      log,
    });

    await bitbucket.createBranch(workdir, branch);

    const result = await implement(item, {
      model,
      log,
      workdir,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    });

    log.info('implementation drafted', {
      changedPaths: result.changedPaths,
      exhaustedSteps: result.exhaustedSteps,
      verified: result.verification.attempted,
      passed: result.verification.passed,
    });

    // Is this fit to review? Two ways it is not, and neither is a crash.
    //
    // A failing suite is deliberately not pushed. The review budget is three
    // round trips and it exists for disagreements about the change, not for code
    // that does not run — the reviewer would execute the same command, reach the
    // same conclusion, and spend an attempt saying so. Discarding the branch
    // rather than pushing it for a human to salvage is the same call the refiner
    // makes when it stands down: one rule, consistently applied, beats a branch
    // on the remote that may or may not be worth anything.
    const stopHere =
      result.changedPaths.length === 0
        ? 'the model finished without changing any files'
        : result.verification.attempted && result.verification.passed === false
          ? `the repository's own test command failed`
          : undefined;

    // The lane guard. Consent is re-read here rather than trusted from dispatch,
    // because the work item is many minutes old by now and a human can have
    // taken the ticket back while the model was working. Both conditions matter:
    // the label says the agents are still welcome, the column says this run is
    // still the one in flight.
    const lane = await jira.readLaneState(item.issueKey);
    const inAgentLane = lane.labels.includes(pipeline.labels.agentLane);
    const stillImplementing = lane.status === pipeline.statuses.implementing;

    if (!inAgentLane || !stillImplementing) {
      // Terminal on purpose, and it is the one path where the implementer has
      // something to say and no right to say it. Nothing was pushed, so there is
      // nothing to clean up; the work goes to the log and nowhere else.
      log.warn('stood down, ticket is no longer ours', {
        issueKey: item.issueKey,
        inAgentLane,
        status: lane.status,
        changedPaths: result.changedPaths,
        summary: result.summary,
      });
      return {
        status: 'failed',
        reason: inAgentLane
          ? `ticket moved to ${lane.status} while implementing`
          : 'ticket moved to the human lane while implementing',
        retryable: false,
      };
    }

    if (stopHere !== undefined) {
      // Agent Failed rather than a silent idle: the board should show that this
      // ticket needs a person. Note the workflow has to permit the transition
      // from Implementing — resolveStatusIds only checks that the status exists.
      await jira.applyMutation(item.issueKey, {
        comment: failureComment({
          reason: stopHere,
          summary: result.summary,
          verification: result.verification,
        }),
        status: pipeline.statuses.failed,
      });
      return { status: 'failed', reason: stopHere, retryable: false };
    }

    // Past here everything is a write, in the order that fails safest. The
    // branch goes up first: a failure between the push and the PR leaves an
    // orphan branch, and the redelivered item pushes the same branch again and
    // finds its own PR. A PR without a branch would be neither.
    const commit = await bitbucket.commitAll(
      workdir,
      `${item.issueKey}: ${item.title}\n\n${result.summary}`,
    );
    if (!commit.committed) {
      // changedPaths said otherwise, so something is wrong with an assumption
      // rather than with the ticket — .gitignore swallowing every written file
      // is the likely one. Loud, and worth a retry only once the cause is fixed.
      throw new Error(
        `${item.issueKey}: the model reported writing ${result.changedPaths.length} ` +
          'files but git found nothing to commit',
      );
    }

    await bitbucket.pushBranch(workdir, branch);

    const pr = await bitbucket.openPullRequest({
      repo: item.repository,
      branch,
      title: `${item.issueKey}: ${item.title}`,
      description: pullRequestDescription({
        issueKey: item.issueKey,
        summary: result.summary,
        verification: result.verification,
      }),
    });

    // Before the transition, not after. The transition is the reviewer's
    // trigger, and a reviewer dispatched against a ticket whose PR has not been
    // linked yet gets no branch and no PR id, which is exactly the case
    // dispatch_review bails out of.
    await jira.linkPullRequest(item.issueKey, pr);

    await jira.applyMutation(item.issueKey, {
      status: pipeline.statuses.codeReview,
    });

    return {
      status: 'succeeded',
      pullRequestUrl: pr.url,
      pullRequestId: pr.id,
      branch: pr.branch,
      summary: result.summary,
    };
  } finally {
    if (workdir !== undefined) await cleanupWorkspace(workdir, log);
  }
}
