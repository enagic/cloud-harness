output "aws_region" {
  description = "Region the stack is deployed in."
  value       = var.aws_region
}

output "ecr_repository_urls" {
  description = "Push targets. Two repos: the watcher, and one shared agents image."
  value       = { for k, v in aws_ecr_repository.this : k => v.repository_url }
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "watcher_service_name" {
  description = "Watcher ECS service name."
  value       = aws_ecs_service.watcher.name
}

output "agent_task_families" {
  description = "Task definition family per agent."
  value       = { for k, v in aws_ecs_task_definition.agent : k => v.family }
}

output "agent_queue_urls" {
  description = "Work queue URL per agent."
  value       = { for k, v in aws_sqs_queue.agent : k => v.id }
}

output "agent_dlq_urls" {
  description = "Dead letter queue per agent. Items here exhausted their retries."
  value       = { for k, v in aws_sqs_queue.agent_dlq : k => v.id }
}

output "dispatcher_function_names" {
  description = "Backlog dispatcher Lambda per agent."
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

output "jira_workflow" {
  description = <<-EOT
    The statuses and labels this deployment expects. These must already exist on
    the Jira board — transitions are resolved by name.
  EOT
  value = {
    statuses = var.jira_statuses
    labels   = var.jira_labels
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
