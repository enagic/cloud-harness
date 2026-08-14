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
 * The hand-back comment, and it is posted on every pass without exception.
 *
 * That is load-bearing rather than polite. Gate 1 and the draft state share a
 * column, so the state machine tells them apart from the thread: no pipeline
 * comment means this ticket has never been refined, the pipeline's comment
 * being newest means it is waiting on a human, and a human comment after it is
 * a send-back. A silent successful pass would leave the ticket looking
 * unrefined and be refined again on the very next tick, forever.
 *
 * The reply route is "comment back on the ticket" and nothing parses what comes
 * back — the next pass gets the whole thread, tagged by author, and reads it.
 * Numbering is for the human's convenience in saying "1: yes, 2: use the
 * existing queue"; it is not a protocol.
 */
function handbackComment(args: {
  questions: string[];
  storyPoints?: number;
  acceptanceCriteria?: string;
}): string {
  const parts = [
    'I refined this as far as I could. The story is in the description and the',
    'acceptance criteria are in their own field.',
  ];

  // Said plainly, because it is the one thing that will stop the ticket dead:
  // the workflow requires Story Points before this can be started.
  if (args.storyPoints === undefined) {
    parts.push(
      '',
      'I could not settle on a size, so Story Points is still empty — the board will',
      'not let this ticket be started until someone puts a number in it.',
    );
  }
  if (args.acceptanceCriteria === undefined) {
    parts.push(
      '',
      'I did not manage to write acceptance criteria for this one, which is worth a',
      'second look before you approve it.',
    );
  }

  if (args.questions.length > 0) {
    parts.push(
      '',
      'These are the things I could not settle. Reply here with anything you want',
      'answered and I will fold your answers into the story on the next pass.',
      '',
      ...args.questions.map((question, i) => `${i + 1}. ${question}`),
    );
  } else {
    parts.push('', 'Nothing was left open. Over to you.');
  }

  return parts.join('\n');
}

export async function handleRefine(
  ctx: AgentTaskContext<RefineWorkItem>,
): Promise<RefineOutcome> {
  const { item, log } = ctx;
  const pipeline = loadPipelineConfig();
  const bitbucket = new BitbucketClient(loadBitbucketConfig('read'), log);
  const jira = new JiraWriter(loadJiraConfig(), pipeline, log);
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
      storyPoints: result.storyPoints,
      criteria: result.acceptanceCriteria !== undefined,
    });

    // The lane guard. Consent is re-checked here rather than trusted from
    // dispatch, because the work item is minutes old and a human can have taken
    // the ticket back while the model was reading the repo.
    //
    // Three conditions now, and the third is the one the column used to carry.
    // The label says the agents are still welcome. The column says the ticket
    // has not moved on. And the Assignee says THIS run is still the one in
    // flight — refinement no longer has a status of its own, so without it a
    // ticket that went round the loop and came back to To Do would look
    // identical to the one this run was dispatched against.
    const lane = await jira.readLaneState(item.issueKey);
    const inAgentLane = lane.labels.includes(pipeline.labels.agentLane);
    const stillInColumn = lane.status === pipeline.statuses.toDo;
    const stillOurs = lane.assigneeAccountId === pipeline.fields.botAccountId;

    if (!inAgentLane || !stillInColumn || !stillOurs) {
      // Terminal on purpose. Retrying re-runs the model against a ticket that
      // is no longer ours and writes nothing again; the work is discarded and
      // the SQS message deleted. The story is logged so the run is not a
      // complete waste if someone goes looking.
      log.warn('stood down, ticket is no longer ours', {
        issueKey: item.issueKey,
        inAgentLane,
        status: lane.status,
        assignee: lane.assigneeAccountId,
        story: result.story,
      });
      return {
        status: 'failed',
        reason: !inAgentLane
          ? 'ticket moved to the human lane while refining'
          : !stillInColumn
            ? `ticket moved to ${lane.status} while refining`
            : 'the ticket was taken off the bot while refining',
        retryable: false,
      };
    }

    // Story and fields first, then the comment and the hand-back. A failure
    // between them leaves the ticket assigned to the bot with a good
    // description, and the redelivered item rewrites it and hands back —
    // wasteful but correct.
    //
    // There is one hand-back, and this is it, whether the model was confident or
    // was guessing. The board gesture is identical because the human's job is
    // identical: read it and decide. What varies is what they read — the story
    // carries its own confidence, the fields carry the size and the criteria,
    // and anything the refiner could not settle is in the comment below. See
    // HANDOFF decision 4.
    await jira.publishRefinement(item.issueKey, {
      story: result.story,
      ...(result.storyPoints === undefined ? {} : { storyPoints: result.storyPoints }),
      ...(result.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: result.acceptanceCriteria }),
    });

    // No transition: gate 1 is in the same column refinement happened in, and
    // the tick that grants the budget is the human's. Releasing the Assignee is
    // what moves this ticket from "an agent is working" to "waiting for you",
    // and the comment is what stops the next tick reading it as unrefined.
    //
    // One comment, not one per question. It is a single hand-back and reads as
    // one.
    await jira.applyMutation(item.issueKey, {
      comment: handbackComment({
        questions: result.questions,
        ...(result.storyPoints === undefined ? {} : { storyPoints: result.storyPoints }),
        ...(result.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: result.acceptanceCriteria }),
      }),
      assignee: 'clear',
    });

    return { status: 'succeeded', refined: result.story };
  } finally {
    if (workdir !== undefined) await cleanupWorkspace(workdir, log);
  }
}
