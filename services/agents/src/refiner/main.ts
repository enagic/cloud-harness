/**
 * Refiner agent.
 *
 * Trigger:  a ticket in the agent lane sitting in a draft column — either never
 *           refined, or sent back from the review gate by a human.
 * Does:     clones the repo, reads it, writes the story into the description.
 * Leaves:   ticket in the refinement-review column, awaiting human gate 1.
 *
 * It moves the card itself. The alternative — reporting an outcome and letting
 * the watcher transition — would need a message channel between the two that
 * does not exist, to convey something this process already knows and is already
 * credentialed to write. What makes it safe is the lane guard below, not the
 * absence of privilege.
 *
 * STATUS: complete for the happy path. The hand-back cases (draft too thin,
 * work too large to be one story) still report as ordinary failures.
 */

import {
  isRefineWorkItem,
  loadBitbucketConfig,
  loadJiraConfig,
  loadLlmConfig,
  loadPipelineConfig,
  type RefineOutcome,
  type RefineWorkItem,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { JiraWriter } from '../clients/jira.js';
import { bootstrap, type AgentTaskContext } from '../runtime/consumer.js';
import { createAgentModel } from '../runtime/model.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';
import { refine } from './refine.js';

async function handle(ctx: AgentTaskContext<RefineWorkItem>): Promise<RefineOutcome> {
  const { item, log } = ctx;
  const bitbucket = new BitbucketClient(loadBitbucketConfig('read'), log);
  const jira = new JiraWriter(loadJiraConfig(), log);
  const pipeline = loadPipelineConfig();
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

    log.info('refinement drafted', {
      exhaustedSteps: result.exhaustedSteps,
      readPaths: result.readPaths,
    });

    // The lane guard. Consent is re-checked here rather than trusted from
    // dispatch, because the work item is minutes old and a human can have taken
    // the ticket back while the model was reading the repo.
    //
    // Both conditions matter. The label says the agents are still welcome; the
    // column says this run is still the one in flight. A ticket a human has
    // dragged somewhere else still carrying the label would otherwise be pulled
    // backwards into refinement review by a write that is already stale.
    const lane = await jira.readLaneState(item.issueKey);
    const inAgentLane = lane.labels.includes(pipeline.labels.agentLane);
    const stillRefining = lane.status === pipeline.statuses.refining;

    if (!inAgentLane || !stillRefining) {
      // Terminal on purpose. Retrying re-runs the model against a ticket that
      // is no longer ours and writes nothing again; the work is discarded and
      // the SQS message deleted. The story is logged so the run is not a
      // complete waste if someone goes looking.
      log.warn('stood down, ticket is no longer ours', {
        issueKey: item.issueKey,
        inAgentLane,
        status: lane.status,
        story: result.story,
      });
      return {
        status: 'failed',
        reason: inAgentLane
          ? `ticket moved to ${lane.status} while refining`
          : 'ticket moved to the human lane while refining',
        retryable: false,
      };
    }

    // Story first, column second. A failure between the two leaves the ticket
    // in Refining with a good description, and the redelivered item rewrites it
    // and transitions — wasteful but correct.
    await jira.publishRefinement(item.issueKey, result.story);
    await jira.applyMutation(item.issueKey, { status: pipeline.statuses.refinementReview });

    return { status: 'succeeded', refined: result.story };
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
