locals {
  bedrock_region = var.bedrock_region != "" ? var.bedrock_region : var.aws_region

  bedrock_model_arns = length(var.bedrock_allowed_model_arns) > 0 ? var.bedrock_allowed_model_arns : [
    "arn:aws:bedrock:${local.bedrock_region}::foundation-model/*",
    "arn:aws:bedrock:${local.bedrock_region}:${local.account_id}:inference-profile/*",
  ]

  secret_arns = [for s in aws_secretsmanager_secret.this : s.arn]
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Guard against the confused-deputy problem: these roles may only be assumed
    # on behalf of tasks in this account.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# ---------------------------------------------------------------------------
# Execution role: what the ECS agent does before your code runs.
# Pulls the image, creates log streams, resolves secrets. Shared by all four
# task definitions — it never touches application resources.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "task_execution" {
  name               = "${local.name_prefix}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    sid       = "ReadInjectedSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.secret_arns
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "read-injected-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

# ---------------------------------------------------------------------------
# Watcher task role.
#
# Produce-only. The watcher writes to all three queues and reads from none —
# it must never be able to consume its own dispatches. It also needs no Bedrock
# access, because it makes no model calls at all: the state machine is pure
# logic and the agents do all the thinking.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "watcher_task" {
  name               = "${local.name_prefix}-watcher-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "watcher_task" {
  statement {
    sid       = "DispatchWork"
    effect    = "Allow"
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
    resources = [for q in aws_sqs_queue.agent : q.arn]
  }
}

resource "aws_iam_role_policy" "watcher_task" {
  name   = "watcher"
  role   = aws_iam_role.watcher_task.id
  policy = data.aws_iam_policy_document.watcher_task.json
}

# ---------------------------------------------------------------------------
# Agent task roles, one per agent.
#
# Each agent can consume only its own queue. A reviewer that could read the
# implementer queue would be able to claim implementation work and silently
# stall the pipeline, so the isolation is worth three roles instead of one.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "agent_task" {
  for_each = var.agents

  name               = "${local.name_prefix}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    Agent = each.key
  }
}

data "aws_iam_policy_document" "agent_task" {
  for_each = var.agents

  # Every queue belonging to this agent, across all its stacks. One role per
  # agent rather than per (agent, stack): the stack images run identical code
  # with identical trust, so splitting further would add roles without adding
  # isolation. The agent-level boundary is the one that matters — it stops a
  # reviewer from claiming implementation work.
  statement {
    sid    = "ConsumeOwnQueues"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [
      for key, unit in local.agent_units :
      aws_sqs_queue.agent[key].arn if unit.agent == each.key
    ]
  }
}

resource "aws_iam_role_policy" "agent_task" {
  for_each = var.agents

  name   = "${each.key}-agent"
  role   = aws_iam_role.agent_task[each.key].id
  policy = data.aws_iam_policy_document.agent_task[each.key].json
}

# ---------------------------------------------------------------------------
# Bedrock access, attached to the agent roles only.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "bedrock_invoke" {
  count = var.enable_bedrock_access ? 1 : 0

  statement {
    sid    = "InvokeModels"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = local.bedrock_model_arns
  }
}

resource "aws_iam_policy" "bedrock_invoke" {
  count = var.enable_bedrock_access ? 1 : 0

  name        = "${local.name_prefix}-bedrock-invoke"
  description = "Invoke Bedrock models from the agent tasks"
  policy      = data.aws_iam_policy_document.bedrock_invoke[0].json
}

resource "aws_iam_role_policy_attachment" "agent_bedrock" {
  for_each = var.enable_bedrock_access ? var.agents : {}

  role       = aws_iam_role.agent_task[each.key].name
  policy_arn = aws_iam_policy.bedrock_invoke[0].arn
}
