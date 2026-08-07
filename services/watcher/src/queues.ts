import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

import type { AgentKind, Logger, QueueUrls, WorkItem } from '@cloud-harness/shared';

export class WorkQueues {
  private readonly sqs = new SQSClient({});

  constructor(
    private readonly urls: QueueUrls,
    private readonly log: Logger,
  ) {}

  /**
   * Route a work item to the queue for its agent AND its stack.
   *
   * The stack dimension is what makes runtime selection work. Each
   * (agent, stack) queue feeds a task definition whose image carries that
   * stack's toolchain, so choosing the queue *is* choosing the runtime. The
   * dispatcher Lambdas only read queue depth — they never see a message — so
   * this is the last point at which anything can decide which image runs.
   *
   * Agents that need no runtime (the refiner) have a single `default` entry and
   * fall through to it regardless of the ticket's stack.
   *
   * Standard queues: at-least-once delivery, no ordering guarantee. Neither
   * matters here — tickets are independent, and every agent is expected to be
   * safe to re-run on a ticket it has already touched (the implementer reuses
   * its branch, the reviewer re-reviews the same commit). Dispatch-once is
   * enforced by the ticket status transition that follows a successful send.
   */
  async send(item: WorkItem): Promise<string> {
    const agent: AgentKind = item.agent;
    const byStack = this.urls[agent];
    const queueUrl = byStack[item.runtime.stack] ?? byStack['default'];

    if (queueUrl === undefined) {
      // Should be unreachable: the watcher validates the stack against
      // KNOWN_STACKS before building the item. Fail loudly rather than
      // silently dropping the ticket.
      throw new Error(
        `no queue for agent=${agent} stack=${item.runtime.stack}; ` +
          `configured: ${Object.keys(byStack).join(', ')}`,
      );
    }

    const response = await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(item),
        MessageAttributes: {
          issueKey: { DataType: 'String', StringValue: item.issueKey },
          agent: { DataType: 'String', StringValue: agent },
          stack: { DataType: 'String', StringValue: item.runtime.stack },
          schemaVersion: { DataType: 'Number', StringValue: String(item.schemaVersion) },
        },
      }),
    );

    const messageId = response.MessageId ?? '<unknown>';
    this.log.info('dispatched work item', {
      issueKey: item.issueKey,
      agent,
      stack: item.runtime.stack,
      messageId,
    });
    return messageId;
  }
}
