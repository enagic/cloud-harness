/**
 * Code reviewer agent.
 *
 * Trigger:  ticket enters the code-review status.
 * Does:     checks out the branch, reviews the diff, exercises the change.
 * Leaves:   either the changes-requested status (back to the implementer,
 *           consuming an attempt) or the awaiting-merge status with the PR
 *           approved (human gate 2).
 *
 * STATUS: wiring and the two-way branch real, review logic stubbed.
 */

import {
  isReviewWorkItem,
  loadBitbucketConfig,
  loadJiraConfig,
  loadPipelineConfig,
  type ReviewOutcome,
  type ReviewWorkItem,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { JiraWriter } from '../clients/jira.js';
import { bootstrap, type AgentTaskContext } from '../runtime/consumer.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';

export const DEFAULT_SYSTEM_PROMPT = `You review a pull request against the story it is meant to satisfy.

Report every issue you find, including ones you are uncertain about, with a
severity. Only blockers should send the PR back — a round trip costs the team
one of a small number of attempts, so do not spend one on style preferences.

Check the change actually does what the story asked, not merely that it compiles.

TODO: fill in the team's review bar — what counts as a blocker here, which
checks are automated elsewhere and should not be duplicated, and how to run the
test suite.`;

async function handle(ctx: AgentTaskContext<ReviewWorkItem>): Promise<ReviewOutcome> {
  const { item, log } = ctx;
  const bitbucket = new BitbucketClient(loadBitbucketConfig('reviewer'), log);
  const jira = new JiraWriter(loadJiraConfig(), log);
  const pipeline = loadPipelineConfig();

  log.info('reviewing', {
    branch: item.branch,
    pullRequestUrl: item.pullRequestUrl,
    attempt: `${item.attempt}/${item.maxAttempts}`,
  });

  let workdir: string | undefined;
  try {
    workdir = await prepareWorkspace({
      issueKey: item.issueKey,
      repo: item.repository,
      branch: item.branch,
      bitbucket,
      log,
    });

    // The runtime this task launched in was chosen from item.runtime.stack, so
    // the toolchain for these commands is present. See prepareRepo/runCommand
    // in ../runtime/exec.ts — that part is implemented.
    //
    // TODO:
    //  1. Diff the branch against item.repository.baseBranch.
    //  2. Review it against item.refinedDescription, which carries the
    //     acceptance criteria as prose rather than as a separate field.
    //  3. Actually exercise the change:
    //       await prepareRepo(item.runtime.manifest, { cwd: workdir, log, signal })
    //       const test = item.runtime.manifest.testCommand
    //         ? await runCommand(item.runtime.manifest.testCommand, {...})
    //         : undefined;
    //     Record it in ReviewFeedback.verification, including `command`. If the
    //     repo declared no testCommand, report attempted: false rather than
    //     implying the change was verified — a review that only read the diff
    //     must say so.
    //  4. Decide: any blocker findings -> changes_requested, else approved.
    //     A failing test suite is a blocker; an absent one is not, on its own.
    //
    // On changes_requested:
    //     jira.publishReview(...) so the implementer can read the findings back
    //     bitbucket.commentOnPullRequest(...)
    //     jira.applyMutation({ status: pipeline.statuses.changesRequested })
    //         ^ the watcher increments the attempt counter on this transition;
    //           the reviewer must not try to manage the counter itself.
    //
    // On approved:
    //     bitbucket.approvePullRequest(...)
    //     jira.applyMutation({ status: pipeline.statuses.awaitingMerge })
    //         ^ human gate 2. The reviewer never merges.
    //
    //  5. Call ctx.onProgress() periodically — test suites are slow and this
    //     is the agent most likely to exceed the visibility timeout.
    void pipeline;
    void jira;
    throw new Error('reviewer handler not implemented');
  } finally {
    if (workdir !== undefined) await cleanupWorkspace(workdir, log);
  }
}

bootstrap({
  kind: 'reviewer',
  queueUrlEnv: 'REVIEWER_QUEUE_URL',
  validate: isReviewWorkItem,
  handle,
});
