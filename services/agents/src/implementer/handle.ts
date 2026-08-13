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
 * IMPLEMENTED: the `initial` and `rebase` reasons. `changes_requested` is still
 * a stub and is rejected up front rather than half handled — it needs the review
 * findings in front of the model, and it is where HANDOFF decision 5's
 * unresolved consent question lands.
 */

import {
  loadBitbucketConfig,
  loadJiraConfig,
  loadLlmConfig,
  loadPipelineConfig,
  type ImplementOutcome,
  type ImplementWorkItem,
  type Logger,
  type PipelineConfig,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { JiraWriter } from '../clients/jira.js';
import type { AgentTaskContext } from '../runtime/consumer.js';
import { createAgentModel, type AgentModel } from '../runtime/model.js';
import { createVerifier, type Verification } from '../runtime/verifier.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';
import { implement } from './implement.js';
import { resolveConflicts, type ResolveResult } from './rebase.js';

/** Keeps a failing suite's output inside what is reasonable in a Jira comment. */
const COMMENT_OUTPUT_LIMIT = 4_000;

/**
 * How many times a rebase may stop on conflicts before this gives up.
 *
 * One per commit being replayed, in the worst case, and these branches are the
 * pipeline's own — a handful of commits, one per implementation attempt. A
 * branch that stops six times is either enormous or the model is resolving
 * conflicts into new ones, and both want a human rather than another round.
 */
const MAX_CONFLICT_ROUNDS = 5;

/** What both paths need: the clients, the config, and the model. */
interface Clients {
  bitbucket: BitbucketClient;
  jira: JiraWriter;
  pipeline: PipelineConfig;
  model: AgentModel;
  log: Logger;
}

/**
 * Put a dead end on the board — unless a human has already taken the ticket
 * back.
 *
 * Every failure that stops before the push goes through here, for two reasons.
 * The first is that it must be *said*: a handler that declines work and writes
 * nothing leaves the ticket in Implementing, which the state machine reads as
 * "an agent owns this" and idles on forever. That is what stranded KAN-6.
 *
 * The second is the lane, re-read for the same reason the write paths re-read
 * it. The work item is minutes old by the time anything fails, and a ticket a
 * human has pulled back into their own lane must not be dragged into Agent
 * Failed underneath them. Nothing has been written when this is called, so
 * standing down costs a log line and nothing else.
 */
async function failOnBoard(
  clients: Clients,
  item: ImplementWorkItem,
  args: { reason: string; comment: string },
): Promise<ImplementOutcome> {
  const { jira, pipeline, log } = clients;

  const lane = await jira.readLaneState(item.issueKey);
  const inAgentLane = lane.labels.includes(pipeline.labels.agentLane);
  const stillImplementing = lane.status === pipeline.statuses.implementing;

  if (!inAgentLane || !stillImplementing) {
    log.warn('stood down before reporting a failure; the ticket is no longer ours', {
      issueKey: item.issueKey,
      inAgentLane,
      status: lane.status,
      unreported: args.reason,
    });
    return {
      status: 'failed',
      reason: inAgentLane
        ? `ticket moved to ${lane.status} while implementing`
        : 'ticket moved to the human lane while implementing',
      retryable: false,
    };
  }

  await jira.applyMutation(item.issueKey, {
    comment: args.comment,
    status: pipeline.statuses.failed,
  });
  return { status: 'failed', reason: args.reason, retryable: false };
}

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

  const clients: Clients = {
    bitbucket: new BitbucketClient(loadBitbucketConfig('implementer'), log),
    jira: new JiraWriter(loadJiraConfig(), log),
    pipeline: loadPipelineConfig(),
    model: createAgentModel(loadLlmConfig(), log),
    log,
  };

  if (item.reason === 'rebase') return await implementRebase(ctx, clients);

  if (item.reason !== 'initial') {
    // Terminal, not retryable: redelivering this reaches the same line.
    return await failOnBoard(clients, item, {
      reason: `the "${item.reason}" path is not implemented yet`,
      comment:
        `This ticket needs the **${item.reason}** implementer path, which is not built yet, ` +
        `so nothing was done to the branch or the pull request.\n\n` +
        `It is over to a human from here.`,
    });
  }

  return await implementInitial(ctx, clients);
}

/** First pass: a branch off the base, the story implemented on it, a new PR. */
async function implementInitial(
  ctx: AgentTaskContext<ImplementWorkItem>,
  clients: Clients,
): Promise<ImplementOutcome> {
  const { item, log } = ctx;
  const { bitbucket, jira, pipeline, model } = clients;

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

/** The Jira comment for a rebase that landed: what moved, and what the suite said. */
function rebaseComment(args: {
  baseBranch: string;
  rebased: boolean;
  rounds: ResolveResult[];
  verification: Verification;
}): string {
  const resolved = args.rounds.flatMap((round) => round.resolvedPaths);

  const parts = [
    !args.rebased
      ? `Nothing to rebase: this branch already contains \`${args.baseBranch}\`, so the ` +
        `conflict that queued this had already been resolved. The branch was not changed.`
      : resolved.length === 0
        ? `Rebased onto \`${args.baseBranch}\`. Git replayed the branch without conflicts.`
        : `Rebased onto \`${args.baseBranch}\`, resolving conflicts in ` +
          `${resolved.length === 1 ? '1 file' : `${resolved.length} files`}: ` +
          resolved.map((path) => `\`${path}\``).join(', ') +
          '.',
  ];

  for (const round of args.rounds) {
    if (round.summary.length > 0) parts.push('', round.summary);
  }

  parts.push(
    '',
    '---',
    '',
    args.verification.attempted
      ? args.verification.passed === true
        ? `\`${args.verification.command ?? ''}\` passed on the branch as it now stands.`
        : `\`${args.verification.command ?? ''}\` **failed** on the branch as it now stands.`
      : 'The repository declares no test command, so the branch was not executed.',
    '',
    // Said explicitly because it is the rule most likely to be doubted by
    // whoever reads this on a ticket that has already been round the loop.
    'No implementation attempt was consumed; a rebase is not a review round trip.',
  );

  if (args.verification.attempted && args.verification.passed === false) {
    parts.push('', '```', (args.verification.output ?? '').slice(-COMMENT_OUTPUT_LIMIT), '```');
  }

  return parts.join('\n');
}

/**
 * Continue the ticket's existing branch, replayed onto a base that has moved.
 *
 * Nothing here consumes an attempt: the ticket goes back to Code Review on
 * success, and countAttempts only counts entries into Changes Requested. Base
 * branch churn is not the implementer failing a review.
 */
async function implementRebase(
  ctx: AgentTaskContext<ImplementWorkItem>,
  clients: Clients,
): Promise<ImplementOutcome> {
  const { item, log } = ctx;
  const { bitbucket, jira, pipeline, model } = clients;
  const baseBranch = item.repository.baseBranch;

  const branch = item.existingBranch;
  if (branch === undefined) {
    // The watcher fills this from the PR it found in Bitbucket, so its absence
    // means the pipeline flagged a conflict on a pull request it can no longer
    // locate. Guessing the branch name would clone something that may not exist
    // and fail three receives later in the DLQ; say so on the board instead.
    return await failOnBoard(clients, item, {
      reason: 'the work item carries no branch to rebase',
      comment:
        'A rebase was queued for this ticket, but the work item carries no branch — ' +
        'the pull request it was flagged against could not be found. Nothing was changed.',
    });
  }

  log.info('rebasing', {
    reason: item.reason,
    attempt: `${item.attempt}/${item.maxAttempts}`,
    branch,
    baseBranch,
    stack: item.runtime.stack,
  });

  let workdir: string | undefined;
  try {
    // The branch as it stands, at full depth. A shallow clone cannot replay
    // commits onto a base branch it does not have — which is the whole job here.
    workdir = await prepareWorkspace({
      issueKey: item.issueKey,
      repo: item.repository,
      branch,
      bitbucket,
      log,
    });

    const rounds: ResolveResult[] = [];
    let rebase = await bitbucket.rebaseOntoBase(workdir, baseBranch);

    while (rebase.status === 'conflicts') {
      if (rounds.length >= MAX_CONFLICT_ROUNDS) {
        await bitbucket.abortRebase(workdir);
        return await failOnBoard(clients, item, {
          reason: `the rebase stopped on conflicts more than ${MAX_CONFLICT_ROUNDS} times`,
          comment:
            `I could not rebase this branch onto \`${baseBranch}\`: it stopped on conflicts ` +
            `more than ${MAX_CONFLICT_ROUNDS} times, which is past the point where another ` +
            `round is likely to help.\n\nThe branch and its pull request are untouched — ` +
            `nothing was pushed.`,
        });
      }

      const round = await resolveConflicts(item, rebase.paths, {
        model,
        log,
        workdir,
        signal: ctx.signal,
        onProgress: ctx.onProgress,
      });
      rounds.push(round);

      log.info('conflict round finished', {
        conflicted: rebase.paths.length,
        resolved: round.resolvedPaths.length,
        unresolved: round.unresolved.length,
        exhaustedSteps: round.exhaustedSteps,
      });

      if (round.unresolved.length > 0) {
        // Not a retry. The model had the files and did not resolve them, and a
        // second identical run is not going to differ enough to be worth the
        // conflict being resolved wrongly instead of not at all.
        await bitbucket.abortRebase(workdir);
        return await failOnBoard(clients, item, {
          reason: `${round.unresolved.length} conflicted file(s) were not resolved`,
          comment: unresolvedComment(baseBranch, round),
        });
      }

      await ctx.onProgress();
      rebase = await bitbucket.continueRebase(workdir);
    }

    // `not_needed` means the base branch is already an ancestor of this branch:
    // whatever Bitbucket saw as a conflict is gone, most likely because a human
    // resolved it while this was queued. There is nothing to push, and the right
    // move is to put the ticket back in the pipeline rather than to invent work.
    const rebased = rebase.status !== 'not_needed';
    if (!rebased) {
      log.info('nothing to rebase; the branch already contains the base branch', {
        branch,
        baseBranch,
      });
    }

    // The suite runs on the finished branch, not mid-rebase — see rebase.ts.
    // This is the first honest answer about the combined result, and on a clean
    // mechanical rebase it is the only check there is.
    await ctx.onProgress();
    const verification = await createVerifier({
      manifest: item.runtime.manifest,
      workdir,
      log,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    }).verify();

    // The lane guard, in the same place and for the same reason as the initial
    // path: the work item is many minutes old and a human may have taken the
    // ticket back. Everything above this line is local to the workspace.
    const lane = await jira.readLaneState(item.issueKey);
    const inAgentLane = lane.labels.includes(pipeline.labels.agentLane);
    const stillImplementing = lane.status === pipeline.statuses.implementing;

    if (!inAgentLane || !stillImplementing) {
      log.warn('stood down, ticket is no longer ours', {
        issueKey: item.issueKey,
        inAgentLane,
        status: lane.status,
        rebased,
      });
      return {
        status: 'failed',
        reason: inAgentLane
          ? `ticket moved to ${lane.status} while rebasing`
          : 'ticket moved to the human lane while rebasing',
        retryable: false,
      };
    }

    // Past here everything is a write. The push comes first and it happens even
    // when the suite failed, which is the one place this path parts company with
    // the initial one. There, a failing suite means throwing away a branch that
    // never existed anywhere else; here the rebase is real work on a branch a
    // human is already looking at, and discarding it means they redo it by hand.
    // So the resolution is pushed and the ticket is failed to them with the
    // output — the reviewer is never handed a branch whose suite does not pass.
    if (rebased) await bitbucket.pushBranch(workdir, branch, true);

    if (verification.attempted && verification.passed === false) {
      await jira.applyMutation(item.issueKey, {
        comment: rebaseComment({ baseBranch, rebased, rounds, verification }),
        status: pipeline.statuses.failed,
      });
      return {
        status: 'failed',
        reason: `the rebased branch does not pass the repository's test command`,
        retryable: false,
      };
    }

    // Back to the reviewer rather than to wherever the ticket was when the
    // conflict was noticed. The commits have been rewritten onto a base that
    // moved, so what a reviewer approved before this is not what would merge
    // now — and re-reviewing costs nothing from the attempt budget.
    await jira.applyMutation(item.issueKey, {
      comment: rebaseComment({ baseBranch, rebased, rounds, verification }),
      status: pipeline.statuses.codeReview,
    });

    const summary = rounds
      .map((round) => round.summary)
      .filter((text) => text.length > 0)
      .join('\n\n');

    return {
      status: 'succeeded',
      ...(item.pullRequestUrl === undefined ? {} : { pullRequestUrl: item.pullRequestUrl }),
      branch,
      summary: summary || `Rebased onto ${baseBranch} with no conflicts.`,
    };
  } finally {
    if (workdir !== undefined) await cleanupWorkspace(workdir, log);
  }
}

/** The Jira comment for conflicts the model could not resolve. */
function unresolvedComment(baseBranch: string, round: ResolveResult): string {
  const lines = round.unresolved.map((entry) =>
    entry.reason === 'untouched'
      ? `- \`${entry.path}\` — left untouched. Binary files and delete/modify ` +
        `conflicts cannot be resolved by editing text.`
      : `- \`${entry.path}\` — still contains conflict markers.`,
  );

  const parts = [
    `I could not finish rebasing this branch onto \`${baseBranch}\`.`,
    '',
    'These files were left unresolved:',
    ...lines,
    '',
    'The rebase was aborted, so the branch and its pull request are exactly as they ' +
      'were — nothing was pushed.',
  ];

  if (round.summary.length > 0) {
    parts.push('', '## What I was doing', '', round.summary);
  }

  return parts.join('\n');
}
