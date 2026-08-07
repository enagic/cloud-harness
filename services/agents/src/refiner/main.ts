/**
 * Refiner agent.
 *
 * Trigger:  human adds the kickoff label, or sends a refinement back.
 * Does:     clones the repo, enriches the draft ticket with code context.
 * Leaves:   ticket in the refinement-review status, awaiting human gate 1.
 *
 * STATUS: wiring real, refinement logic stubbed.
 */

import {
  isRefineWorkItem,
  loadBitbucketConfig,
  loadJiraConfig,
  loadPipelineConfig,
  type RefineOutcome,
  type RefineWorkItem,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { JiraWriter } from '../clients/jira.js';
import { bootstrap, type AgentTaskContext } from '../runtime/consumer.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';

export const DEFAULT_SYSTEM_PROMPT = `You refine Jira tickets into implementable stories.

You have read access to the repository the work will land in. Use it: point at
the files and modules the change touches, and note prior art the implementer
should follow rather than reinvent.

TODO: fill in the team's actual conventions before this is useful —
  - what "implementable" means here (repo layout, testing bar, definition of done)
  - how much design latitude the implementer gets vs. what must be pinned down
  - how to flag genuine ambiguity as an open question instead of guessing`;

async function handle(ctx: AgentTaskContext<RefineWorkItem>): Promise<RefineOutcome> {
  const { item, log } = ctx;
  const bitbucket = new BitbucketClient(loadBitbucketConfig(), log);
  const jira = new JiraWriter(loadJiraConfig(), log);
  const pipeline = loadPipelineConfig();

  let workdir: string | undefined;
  try {
    workdir = await prepareWorkspace({
      issueKey: item.issueKey,
      repo: item.repository,
      bitbucket,
      log,
    });

    // TODO:
    //  1. Explore the repo for context relevant to item.draftDescription.
    //     Read-only — the refiner must never push.
    //  2. Call ctx.model.complete() to produce a RefinedStory, folding in
    //     item.reviewerComments when this is a second pass so the human's
    //     feedback is addressed rather than the story being rewritten from
    //     scratch.
    //  3. jira.publishRefinement(item.issueKey, refined)
    //  4. jira.applyMutation(item.issueKey, {
    //       status: pipeline.statuses.refinementReview,
    //     })  <- hands off to human gate 1
    //  5. Call ctx.onProgress() periodically throughout.
    void pipeline;
    throw new Error('refiner handler not implemented');
  } finally {
    if (workdir !== undefined) await cleanupWorkspace(workdir, log);
  }
}

bootstrap({
  kind: 'refiner',
  queueUrlEnv: 'REFINER_QUEUE_URL',
  validate: isRefineWorkItem,
  handle,
});
