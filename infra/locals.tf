# The (agent, stack) product that drives queues, task definitions, and
# dispatchers.
#
# Runtime-needing agents get one unit per stack, because the stack determines
# which image the task runs and therefore which language toolchains exist. The
# refiner only reads source, so it gets a single unit on the base image.
#
# With the default 3 stacks this is 1 + 3 + 3 = 7 units. Each unit is a queue, a
# DLQ, a task definition, a dispatcher Lambda, and two alarms. That multiplication
# is the price of the dispatcher never reading messages — it only knows depth, so
# the queue itself has to encode which image the work needs.

locals {
  runtime_agents = { for k, v in var.agents : k => v if v.needs_runtime }
  plain_agents   = { for k, v in var.agents : k => v if !v.needs_runtime }

  agent_units = merge(
    # Agents with no runtime requirement: one unit, base image.
    {
      for name, cfg in local.plain_agents : name => {
        agent      = name
        stack      = "default"
        cfg        = cfg
        image_repo = "agents-base"
        # Terraform-safe suffix for names that must stay stable.
        suffix = name
      }
    },
    # Runtime-needing agents: one unit per stack.
    {
      for pair in setproduct(keys(local.runtime_agents), keys(var.stacks)) :
      "${pair[0]}-${pair[1]}" => {
        agent      = pair[0]
        stack      = pair[1]
        cfg        = local.runtime_agents[pair[0]]
        image_repo = "agents-${pair[1]}"
        suffix     = "${pair[0]}-${pair[1]}"
      }
    },
  )

  # ECR repositories: the watcher, the base agent image, and one per stack.
  ecr_repos = merge(
    {
      watcher      = "${local.name_prefix}/watcher"
      agents-base  = "${local.name_prefix}/agents-base"
    },
    {
      for stack in keys(var.stacks) :
      "agents-${stack}" => "${local.name_prefix}/agents-${stack}"
    },
  )

  # agent -> stack -> queue URL, handed to the watcher as one JSON blob. The set
  # grows whenever a stack is added, so a flat env var per queue would mean
  # editing the task definition every time.
  agent_queue_urls = {
    for agent in keys(var.agents) : agent => {
      for key, unit in local.agent_units :
      unit.stack => aws_sqs_queue.agent[key].id
      if unit.agent == agent
    }
  }

  # Fallback commands per stack, for repos whose manifest omits them. Empty
  # strings are dropped so the agent sees "absent" rather than "run nothing".
  stack_defaults = {
    for name, cfg in var.stacks : name => merge(
      cfg.default_setup == "" ? {} : { setupCommand = cfg.default_setup },
      cfg.default_build == "" ? {} : { buildCommand = cfg.default_build },
      cfg.default_test == "" ? {} : { testCommand = cfg.default_test },
      cfg.default_lint == "" ? {} : { lintCommand = cfg.default_lint },
    )
  }
}
