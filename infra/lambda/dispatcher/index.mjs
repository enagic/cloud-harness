/**
 * Backlog-driven dispatcher.
 *
 * Fires on a schedule, compares queue depth against how many dev agent tasks
 * are already running, and launches the difference (bounded by
 * MAX_CONCURRENCY). It deliberately does NOT read or delete queue messages —
 * the dev agent task receives its own message so that a crashed task returns
 * the ticket to the queue instead of losing it.
 *
 * Plain .mjs on purpose: the AWS SDK v3 ships with the Node runtime, so this
 * deploys with no build step and `terraform apply` works on a clean checkout.
 */

import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { ECSClient, ListTasksCommand, RunTaskCommand } from '@aws-sdk/client-ecs';

const sqs = new SQSClient({});
const ecs = new ECSClient({});

const {
  QUEUE_URL,
  CLUSTER_ARN,
  TASK_DEFINITION,
  TASK_FAMILY,
  SUBNET_IDS,
  SECURITY_GROUP_IDS,
  MAX_CONCURRENCY,
  CAPACITY_PROVIDER,
} = process.env;

const maxConcurrency = Number.parseInt(MAX_CONCURRENCY ?? '3', 10);

/** RunTask accepts at most 10 tasks per call. */
const RUN_TASK_BATCH_LIMIT = 10;

async function queueDepth() {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: QUEUE_URL,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );

  return {
    visible: Number.parseInt(Attributes?.ApproximateNumberOfMessages ?? '0', 10),
    inFlight: Number.parseInt(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10),
  };
}

/**
 * Counts RUNNING and PENDING tasks. PENDING matters: a task that was launched
 * on the previous tick but has not pulled its image yet is still capacity we
 * have committed, and ignoring it would over-launch on every tick.
 */
async function runningTaskCount() {
  let total = 0;

  for (const desiredStatus of ['RUNNING', 'PENDING']) {
    let nextToken;
    do {
      const page = await ecs.send(
        new ListTasksCommand({
          cluster: CLUSTER_ARN,
          family: TASK_FAMILY,
          desiredStatus,
          nextToken,
        }),
      );
      total += page.taskArns?.length ?? 0;
      nextToken = page.nextToken;
    } while (nextToken);
  }

  return total;
}

async function launch(count) {
  const subnets = SUBNET_IDS.split(',').filter(Boolean);
  const securityGroups = SECURITY_GROUP_IDS.split(',').filter(Boolean);
  const launched = [];

  let remaining = count;
  while (remaining > 0) {
    const batch = Math.min(remaining, RUN_TASK_BATCH_LIMIT);

    const response = await ecs.send(
      new RunTaskCommand({
        cluster: CLUSTER_ARN,
        taskDefinition: TASK_DEFINITION,
        count: batch,
        capacityProviderStrategy: [{ capacityProvider: CAPACITY_PROVIDER, weight: 1 }],
        networkConfiguration: {
          awsvpcConfiguration: { subnets, securityGroups, assignPublicIp: 'DISABLED' },
        },
        propagateTags: 'TASK_DEFINITION',
        startedBy: 'dev-agent-dispatcher',
      }),
    );

    for (const failure of response.failures ?? []) {
      console.error('RunTask failure', { arn: failure.arn, reason: failure.reason, detail: failure.detail });
    }
    for (const task of response.tasks ?? []) {
      launched.push(task.taskArn);
    }

    // A capacity failure will not resolve within this invocation; stop rather
    // than hammering RunTask. The next scheduled tick retries.
    if ((response.tasks?.length ?? 0) < batch) break;

    remaining -= batch;
  }

  return launched;
}

export const handler = async () => {
  const { visible, inFlight } = await queueDepth();

  if (visible === 0) {
    console.log(JSON.stringify({ msg: 'queue empty, nothing to dispatch', inFlight }));
    return { dispatched: 0, visible, inFlight };
  }

  const running = await runningTaskCount();
  const headroom = Math.max(0, maxConcurrency - running);
  const toLaunch = Math.min(visible, headroom);

  if (toLaunch === 0) {
    console.log(JSON.stringify({ msg: 'at max concurrency', visible, running, maxConcurrency }));
    return { dispatched: 0, visible, running };
  }

  const launched = await launch(toLaunch);

  console.log(
    JSON.stringify({
      msg: 'dispatched dev agent tasks',
      requested: toLaunch,
      launched: launched.length,
      visible,
      inFlight,
      running,
    }),
  );

  return { dispatched: launched.length, visible, running };
};
