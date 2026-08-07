# One queue + DLQ per agent.
#
# Separate queues rather than one queue with a type discriminator: each agent
# has its own concurrency ceiling, its own timeout profile (a reviewer running a
# test suite is not a refiner reading files), and its own failure mode. Sharing
# one queue would mean a backlog of reviews starving refinements, and a single
# DLQ whose contents you have to sort by hand.
#
# Ownership model: the agent task receives its own message and deletes it only
# when the work is done. A task that crashes, is Spot-interrupted, or hangs lets
# the message reappear after the visibility timeout, then land in the DLQ after
# max_receive_count attempts. That is why the dispatcher reads depth only.

resource "aws_sqs_queue" "agent_dlq" {
  for_each = var.agents

  name                      = "${local.name_prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
  sqs_managed_sse_enabled   = true

  tags = {
    Name  = "${local.name_prefix}-${each.key}-dlq"
    Agent = each.key
  }
}

resource "aws_sqs_queue" "agent" {
  for_each = var.agents

  name                       = "${local.name_prefix}-${each.key}"
  visibility_timeout_seconds = each.value.visibility_timeout_seconds
  message_retention_seconds  = var.queue_retention_seconds
  receive_wait_time_seconds  = 20 # long polling
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.agent_dlq[each.key].arn
    maxReceiveCount     = each.value.max_receive_count
  })

  tags = {
    Name  = "${local.name_prefix}-${each.key}"
    Agent = each.key
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "agent_dlq" {
  for_each = var.agents

  queue_url = aws_sqs_queue.agent_dlq[each.key].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.agent[each.key].arn]
  })
}

# --- Alarms -----------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"

  tags = {
    Name = "${local.name_prefix}-alerts"
  }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  for_each = var.agents

  alarm_name          = "${local.name_prefix}-${each.key}-dlq-not-empty"
  alarm_description   = "A ${each.key} work item exhausted its retries and landed in the DLQ."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.agent_dlq[each.key].name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "queue_backlog" {
  for_each = var.agents

  alarm_name          = "${local.name_prefix}-${each.key}-backlog"
  alarm_description   = "${each.key} work is piling up faster than tasks drain it."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.agent[each.key].name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
}
