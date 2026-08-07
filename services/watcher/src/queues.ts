import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

import type { AgentKind, Logger, QueueUrls, WorkItem } from '@cloud-harness/shared';

export class WorkQueues {
  private readonly sqs = new SQSClient({});

  constructor(
    private readonly urls: QueueUrls,
    private readonly log: Logger,
  ) {}

  /**
   * Standard queues: at-least-once delivery, no ordering guarantee. Neither
   * matters here — tickets are independent, and every agent is expected to be
   * safe to re-run on a ticket it has already touched (the implementer reuses
   * its branch, the reviewer re-reviews the same commit).
   *
   * Dispatch-once is enforced by the ticket status transition that follows a
   * successful send, not by the queue.
   */
  async send(item: WorkItem): Promise<string> {
    const queueUrl = this.urls[item.agent satisfies AgentKind];

    const response = await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(item),
        MessageAttributes: {
          issueKey: { DataType: 'String', StringValue: item.issueKey },
          agent: { DataType: 'String', StringValue: item.agent },
          schemaVersion: { DataType: 'Number', StringValue: String(item.schemaVersion) },
        },
      }),
    );

    const messageId = response.MessageId ?? '<unknown>';
    this.log.info('dispatched work item', {
      issueKey: item.issueKey,
      agent: item.agent,
      messageId,
    });
    return messageId;
  }
}
