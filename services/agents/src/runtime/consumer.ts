/**
 * The SQS consume loop shared by all three agents.
 *
 * Ownership model: the task receives its own message and deletes it only when
 * the work is genuinely finished. A crash, OOM, or Spot interruption leaves the
 * message to reappear after the visibility timeout, and after
 * queue_max_receive_count attempts it lands in the DLQ. That is why the
 * dispatcher Lambda reads only queue *depth* and never touches messages — see
 * docs/ARCHITECTURE.md.
 *
 * This file is real. What each agent *does* with a work item is not.
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from '@aws-sdk/client-sqs';

import {
  createChatModel,
  createLogger,
  intEnv,
  loadLlmConfig,
  requireEnv,
  type AgentKind,
  type AgentOutcome,
  type ChatModel,
  type Logger,
  type WorkItem,
} from '@cloud-harness/shared';

export interface AgentTaskContext<T extends WorkItem> {
  item: T;
  model: ChatModel;
  log: Logger;
  signal: AbortSignal;
  /**
   * Call regularly. Extends this ticket's SQS visibility timeout so a long run
   * is not redelivered mid-flight, which would put a second task on the same
   * branch.
   */
  onProgress: () => Promise<void>;
}

export interface AgentDefinition<T extends WorkItem> {
  kind: AgentKind;
  /** Env var naming this agent's queue, e.g. REFINER_QUEUE_URL. */
  queueUrlEnv: string;
  validate(value: unknown): value is T;
  /**
   * Does the work AND reports the result back to Jira. The returned outcome is
   * used only to decide the fate of the SQS message; by the time it returns,
   * the ticket should already be in its next status.
   */
  handle(ctx: AgentTaskContext<T>): Promise<AgentOutcome>;
}

/** Terminal for the message: the work will not be improved by a retry. */
function isTerminal(outcome: AgentOutcome): boolean {
  return outcome.status !== 'failed' || !outcome.retryable;
}

export async function runAgent<T extends WorkItem>(def: AgentDefinition<T>): Promise<void> {
  const log = createLogger({ service: `agent-${def.kind}` });

  const queueUrl = requireEnv(def.queueUrlEnv);
  const visibilityTimeout = intEnv('QUEUE_VISIBILITY_TIMEOUT_SECONDS', 3600);
  const maxItems = intEnv('MAX_ITEMS_PER_TASK', 1);
  const sqs = new SQSClient({});

  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info('shutdown signal, aborting current item', { signal });
      controller.abort();
    });
  }

  const heartbeat = (receiptHandle: string) => async (): Promise<void> => {
    try {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilityTimeout,
        }),
      );
    } catch (err) {
      // Non-fatal: worst case the item is redelivered and retried.
      log.warn('failed to extend visibility', { err });
    }
  };

  const handleMessage = async (message: Message): Promise<void> => {
    const receiptHandle = message.ReceiptHandle;
    if (receiptHandle === undefined || message.Body === undefined) {
      log.warn('message missing receipt handle or body, skipping');
      return;
    }

    let item: T;
    try {
      const parsed: unknown = JSON.parse(message.Body);
      if (!def.validate(parsed)) {
        // Wrong schema or wrong agent. This will never succeed, so let it age
        // into the DLQ rather than deleting the evidence.
        log.error('message failed validation, leaving for DLQ', {
          messageId: message.MessageId,
        });
        return;
      }
      item = parsed;
    } catch (err) {
      log.error('message body is not valid JSON, leaving for DLQ', { err });
      return;
    }

    const itemLog = log.child({ issueKey: item.issueKey, messageId: message.MessageId });
    itemLog.info('starting work item', {
      repo: `${item.repository.workspace}/${item.repository.slug}`,
    });

    const startedAt = Date.now();
    try {
      const outcome = await def.handle({
        item,
        model: createChatModel(loadLlmConfig()),
        log: itemLog,
        signal: controller.signal,
        onProgress: heartbeat(receiptHandle),
      });

      if (isTerminal(outcome)) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
        );
        itemLog.info('work item complete', {
          status: outcome.status,
          durationMs: Date.now() - startedAt,
        });
      } else {
        itemLog.warn('work item failed, leaving message for retry', {
          reason: outcome.status === 'failed' ? outcome.reason : undefined,
        });
      }
    } catch (err) {
      // Leave the message: visibility lapses and SQS redelivers.
      itemLog.error('work item threw, leaving message for retry', { err });
    }
  };

  log.info('agent starting', { queueUrl, maxItems, visibilityTimeout });

  let processed = 0;
  while (processed < maxItems && !controller.signal.aborted) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20, // long poll
        VisibilityTimeout: visibilityTimeout,
        MessageAttributeNames: ['All'],
      }),
    );

    const message = response.Messages?.[0];
    if (message === undefined) {
      // The dispatcher launched us against a backlog another task has since
      // drained. Exiting frees the concurrency slot immediately.
      log.info('no messages available, exiting');
      break;
    }

    await handleMessage(message);
    processed += 1;
  }

  log.info('agent finished', { processed });
}

/** Shared bootstrap for the three thin `main.ts` entrypoints. */
export function bootstrap<T extends WorkItem>(def: AgentDefinition<T>): void {
  runAgent(def).catch((err: unknown) => {
    createLogger({ service: `agent-${def.kind}` }).error('fatal', { err });
    process.exit(1);
  });
}
