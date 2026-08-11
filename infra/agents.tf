# One run-to-completion task definition per (agent, stack) unit.
#
# The stack determines the image, and the image is what makes dynamic testing
# possible: the implementer verifies its change before pushing and the reviewer
# runs the suite before approving, both using the repo's own commands from
# `.cloud-harness.yml`. Those commands only work if the toolchain is present,
# which is why "which image" is decided at dispatch rather than at run time.
#
# Not services: each dispatcher runs one task per unit of backlog, the task
# drains max_items_per_task work items, then exits.

resource "aws_cloudwatch_log_group" "agent" {
  for_each = local.agent_units

  name              = "/ecs/${local.name_prefix}/${each.value.suffix}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "agent" {
  for_each = local.agent_units

  family                   = "${local.name_prefix}-${each.value.suffix}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cfg.cpu
  memory                   = each.value.cfg.memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.agent_task[each.value.agent].arn

  # Default is 20 GB. A clone plus a dependency tree plus a build cache fills
  # that quickly — a JVM repo's ~/.m2 alone can run to several GB.
  ephemeral_storage {
    size_in_gib = each.value.cfg.ephemeral_storage_gb
  }

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name = each.value.suffix
      # agents-base for the refiner, agents-<stack> for everything that builds.
      image     = "${aws_ecr_repository.this[each.value.image_repo].repository_url}:${var.agents_image_tag}"
      essential = true

      # Selects which agent this task runs. Same code in every image.
      command = ["node", each.value.cfg.entrypoint]

      environment = concat(local.common_env, [
        { name = "AGENT_KIND", value = each.value.agent },
        { name = "CLOUD_HARNESS_STACK", value = each.value.stack },
        { name = "WORKSPACE_DIR", value = "/workspace" },
        { name = "MAX_ITEMS_PER_TASK", value = tostring(each.value.cfg.max_items_per_task) },
        { name = "QUEUE_VISIBILITY_TIMEOUT_SECONDS", value = tostring(each.value.cfg.visibility_timeout_seconds) },

        # Each task sees only its own queue; the env var name matches the
        # queueUrlEnv in its AgentDefinition.
        { name = "${upper(each.value.agent)}_QUEUE_URL", value = aws_sqs_queue.agent[each.key].id },

        { name = "LLM_PROVIDER", value = var.llm_provider },
        { name = "LLM_BASE_URL", value = var.llm_base_url },
        { name = "LLM_MODEL", value = each.value.cfg.model != "" ? each.value.cfg.model : var.llm_default_model },
        { name = "LLM_REASONING_EFFORT", value = each.value.cfg.reasoning_effort },
        { name = "LLM_REQUEST_TIMEOUT_SECONDS", value = tostring(var.llm_request_timeout_seconds) },
        { name = "LLM_MAX_OUTPUT_TOKENS", value = tostring(var.llm_max_output_tokens) },
        { name = "BEDROCK_REGION", value = local.bedrock_region },
        ],
        # Refiner-only knobs. Kept out of the other task definitions so an
        # operator reading them is not left wondering what a step budget does to
        # an agent that has no tool loop yet.
        each.value.agent == "refiner" ? [
          { name = "REFINER_MAX_STEPS", value = tostring(var.refiner_max_steps) },
      ] : [])

      # Exactly one Bitbucket credential reaches this container: the one for the
      # identity this agent acts as. The reviewer's task never sees the
      # implementer's token, so it cannot be tricked into acting as the author
      # of the pull request it is reviewing.
      secrets = concat(
        local.jira_secrets,
        [
          {
            name      = local.bitbucket_env_for_role[local.bitbucket_role_for_agent[each.value.agent]]
            valueFrom = local.bitbucket_secret_for[local.bitbucket_role_for_agent[each.value.agent]]
          },
        ],
        local.llm_secrets,
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.agent[each.key].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = each.value.suffix
        }
      }
    },
  ])

  tags = {
    Name  = "${local.name_prefix}-${each.value.suffix}"
    Agent = each.value.agent
    Stack = each.value.stack
  }
}
