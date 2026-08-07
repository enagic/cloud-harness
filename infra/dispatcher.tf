# One dispatcher Lambda per (agent, stack) unit. Turns queue depth into running
# tasks.
#
# A Lambda SQS event-source mapping would delete each message on successful
# *invocation*, which here means "the task was launched", not "the work was
# done" — a task that crashed mid-review would silently lose the ticket. Polling
# depth and letting the task own its own message keeps SQS retry semantics
# meaningful end to end. See docs/ARCHITECTURE.md.
#
# That choice is also why the stack has to be baked into the queue: this Lambda
# never opens a message, so it cannot look at one to decide which task
# definition to launch. Its queue *is* the decision. One Lambda per unit also
# gives each its own concurrency ceiling, error alarm, and blast radius.

data "archive_file" "dispatcher" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/dispatcher"
  output_path = "${path.module}/.build/dispatcher.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "dispatcher" {
  for_each = local.agent_units

  name              = "/aws/lambda/${local.name_prefix}-${each.value.suffix}-dispatcher"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "dispatcher" {
  for_each = local.agent_units

  name               = "${local.name_prefix}-${each.value.suffix}-dispatcher"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json

  tags = {
    Agent = each.value.agent
    Stack = each.value.stack
  }
}

data "aws_iam_policy_document" "dispatcher" {
  for_each = local.agent_units

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.dispatcher[each.key].arn}:*"]
  }

  # Depth only. This role deliberately cannot receive or delete messages.
  statement {
    sid       = "ReadQueueDepth"
    effect    = "Allow"
    actions   = ["sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.agent[each.key].arn]
  }

  statement {
    sid       = "CountRunningTasks"
    effect    = "Allow"
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid     = "LaunchAgent"
    effect  = "Allow"
    actions = ["ecs:RunTask"]

    # Revision wildcard: new task definition revisions stay covered without a
    # policy update.
    resources = ["${replace(aws_ecs_task_definition.agent[each.key].arn, "/:\\d+$/", "")}:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  # RunTask hands these roles to the task it starts, which requires PassRole.
  statement {
    sid     = "PassTaskRoles"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.task_execution.arn,
      aws_iam_role.agent_task[each.value.agent].arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "dispatcher" {
  for_each = local.agent_units

  name   = "dispatcher"
  role   = aws_iam_role.dispatcher[each.key].id
  policy = data.aws_iam_policy_document.dispatcher[each.key].json
}

resource "aws_lambda_function" "dispatcher" {
  for_each = local.agent_units

  function_name = "${local.name_prefix}-${each.value.suffix}-dispatcher"
  role          = aws_iam_role.dispatcher[each.key].arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  timeout       = 60
  memory_size   = 256

  filename         = data.archive_file.dispatcher.output_path
  source_code_hash = data.archive_file.dispatcher.output_base64sha256

  environment {
    variables = {
      AGENT_KIND         = each.value.agent
      STACK              = each.value.stack
      QUEUE_URL          = aws_sqs_queue.agent[each.key].id
      CLUSTER_ARN        = aws_ecs_cluster.main.arn
      TASK_DEFINITION    = aws_ecs_task_definition.agent[each.key].arn
      TASK_FAMILY        = aws_ecs_task_definition.agent[each.key].family
      SUBNET_IDS         = join(",", aws_subnet.private[*].id)
      SECURITY_GROUP_IDS = aws_security_group.workloads.id
      MAX_CONCURRENCY    = tostring(each.value.cfg.max_concurrency)
      CAPACITY_PROVIDER  = each.value.cfg.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    }
  }

  depends_on = [
    aws_iam_role_policy.dispatcher,
    aws_cloudwatch_log_group.dispatcher,
  ]

  tags = {
    Name  = "${local.name_prefix}-${each.value.suffix}-dispatcher"
    Agent = each.value.agent
    Stack = each.value.stack
  }
}

# --- Schedule ---------------------------------------------------------------
# One minute is the finest EventBridge granularity, and well inside the latency
# budget for a pipeline gated on human review twice.

resource "aws_cloudwatch_event_rule" "dispatcher" {
  for_each = local.agent_units

  name                = "${local.name_prefix}-${each.value.suffix}-dispatcher"
  description         = "Poll ${each.value.suffix} queue depth and launch tasks"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "dispatcher" {
  for_each = local.agent_units

  rule      = aws_cloudwatch_event_rule.dispatcher[each.key].name
  target_id = "dispatcher"
  arn       = aws_lambda_function.dispatcher[each.key].arn
}

resource "aws_lambda_permission" "dispatcher_events" {
  for_each = local.agent_units

  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatcher[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.dispatcher[each.key].arn
}

resource "aws_cloudwatch_metric_alarm" "dispatcher_errors" {
  for_each = local.agent_units

  alarm_name          = "${local.name_prefix}-${each.value.suffix}-dispatcher-errors"
  alarm_description   = "The ${each.value.suffix} dispatcher is failing; queued work will not start."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.dispatcher[each.key].function_name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
}
