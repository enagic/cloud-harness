output "aws_region" {
  description = "Region the stack is deployed in."
  value       = var.aws_region
}

output "ecr_repository_urls" {
  description = "Push targets: the watcher, the base agent image, and one per stack."
  value       = { for k, v in aws_ecr_repository.this : k => v.repository_url }
}

output "stacks" {
  description = <<-EOT
    Tech stacks this deployment can build and test. A repo selects one in its
    .cloud-harness.yml; anything else is failed with a comment on the ticket.
  EOT
  value = {
    known   = keys(var.stacks)
    default = var.default_stack
  }
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "watcher_service_name" {
  description = "Watcher ECS service name."
  value       = aws_ecs_service.watcher.name
}

output "agent_units" {
  description = <<-EOT
    Every (agent, stack) unit, keyed as "<agent>" or "<agent>-<stack>". Agents
    that execute repo commands have one unit per stack; the refiner has one.
  EOT
  value = {
    for k, v in local.agent_units : k => {
      agent = v.agent
      stack = v.stack
      image = v.image_repo
    }
  }
}

output "agent_task_families" {
  description = "Task definition family per unit."
  value       = { for k, v in aws_ecs_task_definition.agent : k => v.family }
}

output "agent_queue_urls" {
  description = "Work queue URL per unit."
  value       = { for k, v in aws_sqs_queue.agent : k => v.id }
}

output "agent_dlq_urls" {
  description = "Dead letter queue per unit. Items here exhausted their retries."
  value       = { for k, v in aws_sqs_queue.agent_dlq : k => v.id }
}

output "dispatcher_function_names" {
  description = "Backlog dispatcher Lambda per unit."
  value       = { for k, v in aws_lambda_function.dispatcher : k => v.function_name }
}

output "secret_names" {
  description = "Secrets to populate before the stack will work. See scripts/put-secrets.sh."
  value       = { for k, v in aws_secretsmanager_secret.this : k => v.name }
}

output "alerts_topic_arn" {
  description = "SNS topic carrying DLQ, backlog, and dispatcher alarms."
  value       = aws_sns_topic.alerts.arn
}

output "log_groups" {
  description = "Where each component logs."
  value = merge(
    { watcher = aws_cloudwatch_log_group.watcher.name },
    { for k, v in aws_cloudwatch_log_group.agent : k => v.name },
    { for k, v in aws_cloudwatch_log_group.dispatcher : "${k}-dispatcher" => v.name },
  )
}

output "agent_image_builds" {
  description = <<-EOT
    Dockerfile per agent image, for scripts/build-and-push.sh. The base image
    must be built first — the stack images are FROM it.
  EOT
  value = merge(
    { agents-base = "services/agents/Dockerfile.base" },
    { for name, cfg in var.stacks : "agents-${name}" => cfg.dockerfile },
  )
}

output "jira_workflow" {
  description = <<-EOT
    The columns, label and fields this deployment expects. All of them must
    already exist on the Jira board — statuses are resolved by name and custom
    fields by id.
  EOT
  value = {
    statuses       = var.jira_statuses
    agent_label    = var.jira_agent_label
    bot_account_id = var.jira_bot_account_id
    fields         = var.jira_fields
  }
}

output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Subnets all workloads run in."
  value       = aws_subnet.private[*].id
}
