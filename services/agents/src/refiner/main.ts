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
  loadLlmConfig,
  type RefineOutcome,
  type RefineWorkItem,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { bootstrap, type AgentTaskContext } from '../runtime/consumer.js';
import { createAgentModel } from '../runtime/model.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';
import { refine } from './refine.js';

async function handle(ctx: AgentTaskContext<RefineWorkItem>): Promise<RefineOutcome> {
  const { item, log } = ctx;
  const bitbucket = new BitbucketClient(loadBitbucketConfig('read'), log);
  const model = createAgentModel(loadLlmConfig(), log);

  let workdir: string | undefined;
  try {
    workdir = await prepareWorkspace({
      issueKey: item.issueKey,
      repo: item.repository,
      bitbucket,
      log,
    });

    const result = await refine(item, {
      model,
      log,
      workdir,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    });

    // Everything the refiner is *for* has happened by here. What is missing is
    // the reporting half, and it is blocked on decisions rather than effort:
    //
    //  - `RefineOutcome.succeeded` carries a structured `RefinedStory`, which is
    //    the rejected format. It becomes prose, and grows the hand-back variants
    //    from HANDOFF decision 4 ("not enough detail", "too large, here is a
    //    breakdown") that neither succeeded nor failed can express today.
    //  - Publishing is `jira.publishRefinement`, still a stub, and per decision 8
    //    it should land as an intent-shaped tool rather than a REST wrapper.
    //  - The transition to `Refinement Review` is NOT this agent's to make any
    //    more — decision 2 moved status mutations to the watcher.
    //
    // Until then: log the story, and report a terminal failure so the SQS
    // message is deleted rather than redelivered against an unchanged ticket.
    log.info('refined story (not published)', {
      exhaustedSteps: result.exhaustedSteps,
      readPaths: result.readPaths,
      story: result.story,
    });

    return {
      status: 'failed',
      reason: 'refiner produces the story but does not publish it yet',
      retryable: false,
    };
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
