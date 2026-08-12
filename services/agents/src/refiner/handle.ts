/**
 * The refiner's work-item handler: clone, refine, guard, write.
 *
 * Split from main.ts so it can be driven without the SQS consume loop. main.ts
 * is the entrypoint and does nothing but bootstrap; everything that decides what
 * happens to a ticket is here, where a caller holding a work item can invoke it
 * directly against a real board.
 *
 * It moves the card itself. The alternative — reporting an outcome and letting
 * the watcher transition — would need a message channel between the two that
 * does not exist, to convey something this process already knows and is already
 * credentialed to write. What makes it safe is the lane guard below, not the
 * absence of privilege.
 */

import {
  loadBitbucketConfig,
  loadJiraConfig,
  loadLlmConfig,
  loadPipelineConfig,
  type RefineOutcome,
  type RefineWorkItem,
} from '@cloud-harness/shared';

import { BitbucketClient } from '../clients/bitbucket.js';
import { JiraWriter } from '../clients/jira.js';
import type { AgentTaskContext } from '../runtime/consumer.js';
import { createAgentModel } from '../runtime/model.js';
import { cleanupWorkspace, prepareWorkspace } from '../runtime/workspace.js';
import { refine } from './refine.js';

/**
 * The open questions, as the comment a human answers by replying.
 *
 * Kept plain on purpose. The reply route is "comment back on the ticket" and
 * nothing parses what comes back — the next pass gets the whole thread, tagged
 * by author, and reads it. Numbering is for the human's convenience in saying
 * "1: yes, 2: use the existing queue"; it is not a protocol.
 */
function questionComment(questions: string[]): string {
  return [
    'I refined this as far as I could and left the story in the description.',
    'These are the things I could not settle. Reply here with anything you want',
    'answered, then move the ticket back to a draft column and I will fold your',
    'answers into the story.',
    '',
    ...questions.map((question, i) => `${i + 1}. ${question}`),
  ].join('\n');
}

export async function handleRefine(
  ctx: AgentTaskContext<RefineWorkItem>,
): Promise<RefineOutcome> {
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
      // The refiner only reads. It never commits, so it never needs history to
      // replay onto a base branch.
      depth: 1,
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
      questions: result.questions.length,
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

    // Story first, then the questions and the column. A failure between them
    // leaves the ticket in Refining with a good description, and the redelivered
    // item rewrites it and transitions — wasteful but correct.
    //
    // There is one hand-back, and this is it, whether the model was confident or
    // was guessing. The board gesture is identical because the human's job is
    // identical: read it and decide. What varies is what they read — the story
    // carries its own confidence and size, and anything the refiner could not
    // settle is in the comment below. See HANDOFF decision 4.
    await jira.publishRefinement(item.issueKey, result.story);
    await jira.applyMutation(item.issueKey, {
      // One comment, not one per question. It is a single hand-back and reads as
      // one, and applyMutation posts it before it transitions, so the card
      // arriving in Refinement Review already has the questions attached.
      ...(result.questions.length > 0 ? { comment: questionComment(result.questions) } : {}),
      status: pipeline.statuses.refinementReview,
    });

    return { status: 'succeeded', refined: result.story };
  } finally {
    if (workdir !== undefined) await cleanupWorkspace(workdir, log);
  }
}
