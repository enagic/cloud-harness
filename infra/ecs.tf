resource "aws_ecs_cluster" "main" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = local.name_prefix
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

resource "aws_cloudwatch_log_group" "watcher" {
  name              = "/ecs/${local.name_prefix}/watcher"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------------------
# Shared container config
# ---------------------------------------------------------------------------

locals {
  # The workflow contract. Every component needs the same view of it, or the
  # watcher will transition tickets into statuses the agents never look for.
  pipeline_env = [
    { name = "STATUS_REFINING", value = var.jira_statuses.refining },
    { name = "STATUS_REFINEMENT_REVIEW", value = var.jira_statuses.refinement_review },
    { name = "STATUS_READY_TO_IMPLEMENT", value = var.jira_statuses.ready_to_implement },
    { name = "STATUS_IMPLEMENTING", value = var.jira_statuses.implementing },
    { name = "STATUS_CODE_REVIEW", value = var.jira_statuses.code_review },
    { name = "STATUS_REVIEWING", value = var.jira_statuses.reviewing },
    { name = "STATUS_CHANGES_REQUESTED", value = var.jira_statuses.changes_requested },
    { name = "STATUS_REBASE_REQUIRED", value = var.jira_statuses.rebase_required },
    { name = "STATUS_AWAITING_MERGE", value = var.jira_statuses.awaiting_merge },
    { name = "STATUS_DONE", value = var.jira_statuses.done },
    { name = "STATUS_FAILED", value = var.jira_statuses.failed },

    { name = "LABEL_REFINE", value = var.jira_labels.refine },
    { name = "LABEL_CHANGES_REQUESTED", value = var.jira_labels.changes_requested },

    { name = "MAX_IMPLEMENTATION_ATTEMPTS", value = tostring(var.max_implementation_attempts) },
  ]

  integration_env = [
    { name = "AWS_REGION", value = var.aws_region },
    { name = "ENVIRONMENT", value = var.environment },
    { name = "LOG_LEVEL", value = "info" },

    { name = "JIRA_BASE_URL", value = var.jira_base_url },
    { name = "JIRA_PROJECT_KEY", value = var.jira_project_key },
    { name = "JIRA_USER_EMAIL", value = var.jira_user_email },

    { name = "BITBUCKET_WORKSPACE", value = var.bitbucket_workspace },
    { name = "BITBUCKET_DEFAULT_REPO", value = var.bitbucket_default_repo },
    { name = "BITBUCKET_DEFAULT_BRANCH", value = var.bitbucket_default_branch },
  ]

  common_env = concat(local.pipeline_env, local.integration_env)

  # Injected by the ECS agent at task start, resolved through the execution
  # role. Values never appear in the task definition.
  jira_secrets = [
    {
      name      = "JIRA_API_TOKEN"
      valueFrom = aws_secretsmanager_secret.this["jira_api_token"].arn
    },
  ]

  # Bitbucket credentials, per identity. The execution role can read all three
  # because it is what performs the injection, but each CONTAINER receives only
  # its own — so a compromised implementer holds no credential that can approve
  # its own pull request. That containment is the point of the split.
  bitbucket_secret_for = {
    read        = aws_secretsmanager_secret.this["bitbucket_token_read"].arn
    implementer = aws_secretsmanager_secret.this["bitbucket_token_implementer"].arn
    reviewer    = aws_secretsmanager_secret.this["bitbucket_token_reviewer"].arn
  }

  # Agent kind -> which identity it acts as. Mirrors bitbucketRoleFor() in
  # packages/shared/src/config.ts; the two must agree.
  bitbucket_role_for_agent = {
    refiner     = "read"
    implementer = "implementer"
    reviewer    = "reviewer"
  }

  # Identity -> the env var its token is injected as. Mirrors
  # BITBUCKET_TOKEN_ENV in packages/shared/src/config.ts.
  bitbucket_env_for_role = {
    read        = "BITBUCKET_TOKEN"
    implementer = "BITBUCKET_IMPLEMENTER_TOKEN"
    reviewer    = "BITBUCKET_REVIEWER_TOKEN"
  }

  watcher_bitbucket_secrets = [
    {
      name      = "BITBUCKET_TOKEN"
      valueFrom = local.bitbucket_secret_for["read"]
    },
  ]

  llm_secrets = local.create_llm_api_key ? [
    {
      name      = "LLM_API_KEY"
      valueFrom = aws_secretsmanager_secret.this["llm_api_key"].arn
    },
  ] : []
}

# ---------------------------------------------------------------------------
# Watcher: always-on service, 0.25 vCPU / 512 MB
#
# Gets no model configuration at all — it makes no model calls. Its whole job is
# polling, running the pure state machine, and dispatching.
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "watcher" {
  family                   = "${local.name_prefix}-watcher"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.watcher_cpu
  memory                   = var.watcher_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.watcher_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "watcher"
      image     = "${aws_ecr_repository.this["watcher"].repository_url}:${var.watcher_image_tag}"
      essential = true

      environment = concat(local.common_env, [
        { name = "POLL_INTERVAL_SECONDS", value = tostring(var.watcher_poll_interval_seconds) },

        # agent -> stack -> queue URL. One blob rather than an env var per
        # queue, because the set is a product of agents and stacks.
        { name = "AGENT_QUEUE_URLS", value = jsonencode(local.agent_queue_urls) },

        # Runtime selection. The watcher reads each repo's .cloud-harness.yml,
        # validates the stack against this list, and routes to the matching
        # queue — which is what picks the image the agent runs in.
        { name = "KNOWN_STACKS", value = join(",", keys(var.stacks)) },
        { name = "DEFAULT_STACK", value = var.default_stack },
        { name = "STACK_DEFAULTS", value = jsonencode(local.stack_defaults) },
      ])

      secrets = concat(local.jira_secrets, local.watcher_bitbucket_secrets)

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.watcher.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "watcher"
        }
      }

      # Marks itself unhealthy if a poll cycle has not completed recently — a
      # process wedged on a hung Jira call would pass a liveness check forever.
      healthCheck = {
        command     = ["CMD-SHELL", "node dist/healthcheck.js || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    },
  ])

  tags = {
    Name = "${local.name_prefix}-watcher"
  }
}

resource "aws_ecs_service" "watcher" {
  name            = "${local.name_prefix}-watcher"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.watcher.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Single instance by design: two watchers would double-dispatch work items and
  # race on ticket transitions. Stop the old task before starting the new one.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  enable_execute_command = true # `aws ecs execute-command` for POC debugging

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.workloads.id]
    assign_public_ip = false
  }

  tags = {
    Name = "${local.name_prefix}-watcher"
  }
}
