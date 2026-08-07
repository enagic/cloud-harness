# Three run-to-completion task definitions off one image, distinguished by
# `command`. Not services: the dispatcher runs one per unit of backlog, it
# drains max_items_per_task work items, then exits.

resource "aws_ecs_task_definition" "agent" {
  for_each = var.agents

  family                   = "${local.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.agent_task[each.key].arn

  # Default is 20 GB, which a dependency install plus a repo clone can fill.
  ephemeral_storage {
    size_in_gib = each.value.ephemeral_storage_gb
  }

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.this["agents"].repository_url}:${var.agents_image_tag}"
      essential = true

      # Selects which agent this task runs. Same image for all three.
      command = ["node", each.value.entrypoint]

      environment = concat(local.common_env, [
        { name = "AGENT_KIND", value = each.key },
        { name = "WORKSPACE_DIR", value = "/workspace" },
        { name = "MAX_ITEMS_PER_TASK", value = tostring(each.value.max_items_per_task) },
        { name = "QUEUE_VISIBILITY_TIMEOUT_SECONDS", value = tostring(each.value.visibility_timeout_seconds) },

        # Each agent sees only its own queue; the URL env name matches the
        # queueUrlEnv in its AgentDefinition.
        { name = "${upper(each.key)}_QUEUE_URL", value = aws_sqs_queue.agent[each.key].id },

        { name = "LLM_PROVIDER", value = var.llm_provider },
        { name = "LLM_BASE_URL", value = var.llm_base_url },
        { name = "LLM_MODEL", value = each.value.model != "" ? each.value.model : var.llm_default_model },
        { name = "LLM_REASONING_EFFORT", value = each.value.reasoning_effort },
        { name = "LLM_REQUEST_TIMEOUT_SECONDS", value = tostring(var.llm_request_timeout_seconds) },
        { name = "BEDROCK_REGION", value = local.bedrock_region },
      ])

      secrets = concat(local.jira_bitbucket_secrets, local.llm_secrets)

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.agent[each.key].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = each.key
        }
      }
    },
  ])

  tags = {
    Name  = "${local.name_prefix}-${each.key}"
    Agent = each.key
  }
}
