/**
 * Implementer agent.
 *
 * Trigger:  human approval (initial), reviewer changes-requested, or a rebase.
 * Does:     clones the repo, implements, pushes, opens or updates the PR.
 * Leaves:   ticket in the code-review status, which triggers the reviewer.
 *
 * The three reasons are genuinely different jobs and the handler branches on
 * them — see the note on `rebase` below.
 *
 * STATUS: wiring and branch structure real, implementation logic stubbed.
 */

import {
  isImplementWorkItem,
  loadBitbucketConfig,
  loadJiraConfig,
  loadPipelineConfig,
  type ImplementOutcome,
  type ImplementWorkItem,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { JiraWriter } from '../clients/jira.js';
import { bootstrap, type AgentTaskContext } from '../runtime/consumer.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';

export const DEFAULT_SYSTEM_PROMPT = `You implement an approved Jira story in an existing codebase.

Write code that reads like the surrounding code: match its structure, naming,
and idiom. Stay within the scope of the story — do not refactor adjacent code
or add abstractions the story does not call for.

TODO: fill in the team's conventions — test command, coverage expectations,
commit message format, and what must be true before a PR is opened.`;

async function handle(ctx: AgentTaskContext<ImplementWorkItem>): Promise<ImplementOutcome> {
  const { item, log } = ctx;
  const bitbucket = new BitbucketClient(loadBitbucketConfig('implementer'), log);
  const jira = new JiraWriter(loadJiraConfig(), log);
  const pipeline = loadPipelineConfig();

  const branch = item.existingBranch ?? BitbucketClient.branchNameFor(item.issueKey, item.title);

  log.info('implementing', {
    reason: item.reason,
    attempt: `${item.attempt}/${item.maxAttempts}`,
    branch,
  });

  let workdir: string | undefined;
  try {
    workdir = await prepareWorkspace({
      issueKey: item.issueKey,
      repo: item.repository,
      // Every reason except the first continues an existing branch.
      ...(item.reason === 'initial' ? {} : { branch }),
      bitbucket,
      log,
    });

    switch (item.reason) {
      case 'rebase': {
        // Mechanical first: most conflicts do not need a model at all. Only
        // escalate to the agent when git cannot resolve it alone.
        //
        // TODO:
        //  1. bitbucket.rebaseOntoBase(workdir, item.repository.baseBranch)
        //  2. On 'clean': push --force-with-lease, then return the existing PR.
        //  3. On 'conflicts': resolve them with ctx.model, keeping the change
        //     semantically intact, then push.
        //  4. Return the ticket to whichever status it should resume at.
        //
        // Whatever this does, it must NOT consume a review attempt — the
        // counter is not incremented for rebases anywhere in the pipeline, and
        // that invariant is tested in packages/shared/src/pipeline.test.ts.
        throw new Error('implementer rebase path not implemented');
      }

      case 'changes_requested': {
        // TODO: apply item.reviewFeedback.findings to the existing branch.
        // Address the findings specifically rather than re-implementing the
        // story — the reviewer is going to re-check exactly those points.
        throw new Error('implementer changes_requested path not implemented');
      }

      case 'initial': {
        // TODO:
        //  1. Create `branch` off item.repository.baseBranch.
        //  2. Implement against item.refinedDescription, which is the whole
        //     spec — acceptance criteria and the paths the refiner found are
        //     prose inside it, not separate fields.
        //  3. Verify before pushing, using the repo's own commands — this task
        //     is running in the stack image selected by item.runtime.stack, so
        //     the toolchain is present:
        //       await prepareRepo(item.runtime.manifest, { cwd: workdir, log, signal })
        //       await runCommand(item.runtime.manifest.testCommand, {...})
        //     Pushing a branch whose suite fails wastes a full review round
        //     trip, and the budget is only three.
        //  4. bitbucket.pushBranch, bitbucket.openPullRequest
        //  5. jira.linkPullRequest so the watcher and reviewer can find it.
        //  6. jira.applyMutation({ status: pipeline.statuses.codeReview })
        //     <- this transition is the reviewer's trigger
        //  7. Call ctx.onProgress() periodically throughout.
        void pipeline;
        void jira;
        throw new Error('implementer initial path not implemented');
      }
    }

    // Guard rather than dead code: adding a fourth ImplementReason without
    // handling it here should fail loudly, not silently no-op the ticket.
    throw new Error(`unhandled implement reason: ${String(item.reason)}`);
  } finally {
    if (workdir !== undefined) await cleanupWorkspace(workdir, log);
  }
}

bootstrap({
  kind: 'implementer',
  queueUrlEnv: 'IMPLEMENTER_QUEUE_URL',
  validate: isImplementWorkItem,
  handle,
});
