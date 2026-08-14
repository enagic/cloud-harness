variable "project_name" {
  description = "Short name used to prefix every resource."
  type        = string
  default     = "cloud-harness"
}

variable "environment" {
  description = "Environment name (poc, dev, prod)."
  type        = string
  default     = "poc"
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones to spread subnets across."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = <<-EOT
    Use one NAT gateway for all private subnets instead of one per AZ.
    true is the right POC default (~$32/mo vs ~$64/mo); flip to false for prod
    so a single AZ outage cannot take out egress for the whole pipeline.
  EOT
  type        = bool
  default     = true
}

variable "disposable_deployment" {
  description = <<-EOT
    This stack is expected to be destroyed and recreated, so destroy actually
    destroys. Two effects, both about `terraform destroy` leaving nothing
    behind:

      - ECR repositories delete even when they hold images. Without this,
        destroy FAILS the moment any image has been pushed, which is every
        deployment that has run.
      - Secrets delete immediately instead of entering a 7-day recovery
        window. The window does not just delay cleanup: it reserves the secret
        NAMES, so the next apply fails with "already scheduled for deletion".
        A daily up/down cycle is impossible with it on.

    NEVER true in production. It removes the recovery window that exists so an
    accidental destroy is survivable, and lets a repository holding the only
    copy of an image be deleted without complaint.
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Watcher (the only always-on component)
# ---------------------------------------------------------------------------

variable "watcher_cpu" {
  description = "Fargate CPU units for the watcher. 256 = 0.25 vCPU."
  type        = number
  default     = 256
}

variable "watcher_memory" {
  description = "Fargate memory (MiB) for the watcher."
  type        = number
  default     = 512
}

variable "watcher_poll_interval_seconds" {
  description = "How often the watcher polls Jira and Bitbucket."
  type        = number
  default     = 60
}

variable "watcher_image_tag" {
  description = "Container image tag for the watcher."
  type        = string
  default     = "latest"
}

# ---------------------------------------------------------------------------
# Agents
#
# One map drives everything per agent: its queue, DLQ, task definition,
# dispatcher Lambda, IAM role, and alarms. Adding a fourth agent means adding a
# map entry and an entrypoint in services/agents.
# ---------------------------------------------------------------------------

variable "agents_image_tag" {
  description = "Container image tag for the shared agents image."
  type        = string
  default     = "latest"
}

variable "agents" {
  description = <<-EOT
    Per-agent sizing and queue behaviour.

    entrypoint  path inside the agent image, selected via the task `command`
    needs_runtime  true for agents that execute the repo's build and test
                   commands. Those get one queue and one task definition PER
                   STACK, each running that stack's image. Agents that only read
                   source (the refiner) run on the base image and get a single
                   queue.
    cpu/memory  Fargate task size; must be a valid Fargate CPU/memory pair
    ephemeral_storage_gb  21-200. Needs room for a clone plus dependencies.
    max_concurrency       ceiling on simultaneous tasks PER (agent, stack)
    max_items_per_task    work items one task drains before exiting
    visibility_timeout_seconds  floor on how long one item may take; agents also
                                extend visibility while working
    max_receive_count     deliveries before the item goes to its DLQ
    use_fargate_spot      cheaper, interruptible; SQS redelivery covers it
    model / reasoning_effort  per-agent model selection, empty inherits default
  EOT

  type = map(object({
    entrypoint                 = string
    needs_runtime              = bool
    cpu                        = number
    memory                     = number
    ephemeral_storage_gb       = number
    max_concurrency            = number
    max_items_per_task         = number
    visibility_timeout_seconds = number
    max_receive_count          = number
    use_fargate_spot           = bool
    model                      = string
    reasoning_effort           = string
  }))

  default = {
    # Reads the repo for context and writes prose. No build, no tests, so it
    # runs on the base image and needs no per-stack variants.
    refiner = {
      entrypoint                 = "dist/refiner/main.js"
      needs_runtime              = false
      cpu                        = 1024
      memory                     = 4096
      ephemeral_storage_gb       = 30
      max_concurrency            = 3
      max_items_per_task         = 1
      visibility_timeout_seconds = 1800
      max_receive_count          = 3
      use_fargate_spot           = false
      model                      = ""
      reasoning_effort           = ""
    }

    # The heavy one: clones, builds, tests, iterates.
    implementer = {
      entrypoint                 = "dist/implementer/main.js"
      needs_runtime              = true
      cpu                        = 4096
      memory                     = 16384
      ephemeral_storage_gb       = 50
      max_concurrency            = 3
      max_items_per_task         = 1
      visibility_timeout_seconds = 3600
      max_receive_count          = 3
      use_fargate_spot           = false
      model                      = ""
      reasoning_effort           = ""
    }

    # Checks out and exercises the branch — a review that cannot run the suite
    # is just a diff read, so this needs a real build environment.
    reviewer = {
      entrypoint                 = "dist/reviewer/main.js"
      needs_runtime              = true
      cpu                        = 2048
      memory                     = 8192
      ephemeral_storage_gb       = 50
      max_concurrency            = 3
      max_items_per_task         = 1
      visibility_timeout_seconds = 3600
      max_receive_count          = 3
      use_fargate_spot           = false
      model                      = ""
      reasoning_effort           = ""
    }
  }

  validation {
    condition     = alltrue([for k in keys(var.agents) : contains(["refiner", "implementer", "reviewer"], k)])
    error_message = "agents keys must be refiner, implementer, or reviewer."
  }
}

# ---------------------------------------------------------------------------
# Tech stacks
#
# Each stack is one container image and, for every runtime-needing agent, one
# queue + task definition + dispatcher. A repo selects its stack in
# `.cloud-harness.yml`; the watcher reads that file and routes accordingly.
#
# Adding a stack: add an entry here, add services/agents/Dockerfile.<key>,
# apply, then `make images`.
# ---------------------------------------------------------------------------

variable "stacks" {
  description = <<-EOT
    Tech stacks this deployment can build and test.

    dockerfile  path relative to the repo root; must exist before `make images`
    default_*   fallback commands for repos whose manifest omits them. Explicit
                manifest values always win — the deployment never overrides what
                a repo said about itself.
  EOT

  type = map(object({
    dockerfile    = string
    description   = string
    default_setup = string
    default_build = string
    default_test  = string
    default_lint  = string
  }))

  default = {
    node = {
      dockerfile    = "services/agents/Dockerfile.node"
      description   = "Node 22 + corepack (pnpm/yarn) + node-gyp toolchain"
      default_setup = "npm ci"
      default_build = "npm run build --if-present"
      default_test  = "npm test"
      default_lint  = "npm run lint --if-present"
    }

    python = {
      dockerfile    = "services/agents/Dockerfile.python"
      description   = "Python 3 + venv + uv + build-essential"
      default_setup = "uv sync"
      default_build = ""
      default_test  = "uv run pytest"
      default_lint  = "uv run ruff check ."
    }

    jvm = {
      dockerfile    = "services/agents/Dockerfile.jvm"
      description   = "Temurin JDK 21 + Maven (Gradle via repo wrapper)"
      default_setup = ""
      default_build = "mvn -B -q compile"
      default_test  = "mvn -B test"
      default_lint  = ""
    }
  }

  validation {
    condition     = length(var.stacks) > 0
    error_message = "At least one stack must be configured."
  }
}

variable "default_stack" {
  description = <<-EOT
    Stack used for a repo with no .cloud-harness.yml. Must be a key in `stacks`.

    A repo that HAS a manifest naming an unknown stack is failed with a comment
    rather than silently falling back here — it tried to say something and got
    it wrong, and running its build in the wrong image produces a confusing
    review instead of an actionable error.
  EOT
  type        = string
  default     = "node"

  validation {
    condition     = contains(keys(var.stacks), var.default_stack)
    error_message = "default_stack must be one of the keys in `stacks`."
  }
}

variable "queue_retention_seconds" {
  description = "How long an unprocessed work item survives in a queue."
  type        = number
  default     = 345600 # 4 days
}

variable "max_implementation_attempts" {
  description = <<-EOT
    Review round trips allowed before a ticket is failed for human triage.
    Rebases deliberately do not count against this — see the state machine in
    packages/shared/src/pipeline.ts.
  EOT
  type        = number
  default     = 3
}

# ---------------------------------------------------------------------------
# Jira
# ---------------------------------------------------------------------------

variable "jira_base_url" {
  description = "Jira Cloud base URL, e.g. https://acme.atlassian.net"
  type        = string
}

variable "jira_project_key" {
  description = "Jira project key to watch, e.g. ENG"
  type        = string
}

variable "jira_user_email" {
  description = "Email of the Jira account whose API token is in Secrets Manager."
  type        = string
}

variable "jira_statuses" {
  description = <<-EOT
    The board's columns, which MUST match the workflow exactly — transitions are
    resolved by name and a mismatch is a ticket that silently never moves.

    These are ordinary columns rather than pipeline-specific ones, which is the
    point: most teams cannot add columns to their own board, so the pipeline
    fits into the seven that are already there. Status is no longer the whole
    state — the rest of it lives on the four fields in jira_fields.

      to_do        drafting, refinement, and human gate 1 (the DOR tick)
      in_progress  the implementer's column; every attempt leaves it
      code_review  the pull request's column: review, rebase, consented fix
      validation   human gate 2 — post-build QA, then the merge
      done         terminal, merged
      blocked      terminal, the pipeline gave up and a human is needed
      closed       terminal, won't do; recognised but never read or written
  EOT

  type = object({
    to_do       = string
    in_progress = string
    code_review = string
    validation  = string
    done        = string
    blocked     = string
    closed      = string
  })

  default = {
    to_do       = "To Do"
    in_progress = "In Progress"
    code_review = "Code Review"
    validation  = "Validation"
    done        = "Done"
    blocked     = "Blocked"
    closed      = "Closed"
  }
}

variable "jira_bot_account_id" {
  description = <<-EOT
    Atlassian account id of the dedicated bot account.

    This is the in-flight marker: a ticket assigned to it is being worked on by
    an agent right now, and the Code Reviewer field pointing at it means the
    reviewer agent is running. An account rather than a label deliberately — a
    stranded in-flight label is invisible cruft a PO has to know to go looking
    for, while a wrong assignee is at least visible in the field people already
    read to find out who is working on something.

    The account needs `Assignable User` in the project's permission scheme,
    which is a SEPARATE permission from write access. Without it the bot will
    edit fields and transition issues perfectly well while silently failing to
    be assigned. `npm run preflight` checks for it.
  EOT

  type = string
}

variable "jira_fields" {
  description = <<-EOT
    Custom field ids, as `customfield_NNNNN`. Read them off
    /rest/api/3/field on the target site.

    Ids rather than names, because the changelog records a field's display name
    as it stood at the time and the attempt budget is derived from that
    changelog — a rename must not silently reset every ticket's budget.

      code_reviewer       userpicker; the bot means the reviewer agent is running,
                          a human means the ticket is at gate 2
      dor                 multicheckbox; ticked means gate 1 passed and the
                          attempt budget is granted. The board's own workflow
                          validator requires it before In Progress, which is what
                          makes gate 1 impossible to skip
      dor_ticked_value    the option on that field that counts as ticked
      story_points        number; the refiner writes it, and the workflow requires
                          it before In Progress
      acceptance_criteria textarea; content rather than state. The refiner writes
                          the criteria here instead of burying them in prose, and
                          the reviewer verifies against them
  EOT

  type = object({
    code_reviewer       = string
    dor                 = string
    dor_ticked_value    = optional(string, "Yes")
    story_points        = string
    acceptance_criteria = string
  })
}

variable "jira_agent_label" {
  description = <<-EOT
    The lane marker, and the only label the pipeline reads.

    Present, the ticket is in the agent lane; absent, it is in the human lane
    and nothing is dispatched. It is standing consent rather than a trigger —
    it is not consumed on dispatch and survives until a human removes it. The
    board column says which stage to run; this says whether to run at all.

    To edit a ticket the agents are working on, a human moves it to the human
    lane first. Editing in the agent lane is a broken contract and the agent's
    write wins.

    Labels are used ONLY for signals a human deliberately sends — never to
    store pipeline state, because anyone with write access can change a label.
    The attempt budget is derived from the Jira changelog instead; see
    packages/shared/src/pipeline.ts.
  EOT

  type    = string
  default = "agent"
}

# ---------------------------------------------------------------------------
# Bitbucket
# ---------------------------------------------------------------------------

variable "bitbucket_workspace" {
  description = "Bitbucket workspace slug."
  type        = string
}

variable "bitbucket_default_repo" {
  description = "Repo slug the agents work in when a ticket does not name one."
  type        = string
}

variable "bitbucket_default_branch" {
  description = "Branch PRs target and rebases run against."
  type        = string
  default     = "main"
}

# ---------------------------------------------------------------------------
# Model access
#
# The POC talks to an OpenAI-compatible /chat/completions endpoint so the
# provider stays swappable. Bedrock is the intended destination: flip
# llm_provider to "bedrock" and set enable_bedrock_access, which grants the task
# roles bedrock:InvokeModel* and drops the need for an API key secret.
# ---------------------------------------------------------------------------

variable "llm_provider" {
  description = "Which client path the services take: openai_compatible or bedrock."
  type        = string
  default     = "openai_compatible"

  validation {
    condition     = contains(["openai_compatible", "bedrock"], var.llm_provider)
    error_message = "llm_provider must be openai_compatible or bedrock."
  }
}

variable "llm_base_url" {
  description = <<-EOT
    Base URL of the OpenAI-compatible API, including the version path
    (e.g. https://gateway.internal/v1). Ignored when llm_provider = bedrock.
  EOT
  type        = string
  default     = ""
}

variable "llm_default_model" {
  description = "Model id used by any agent whose `model` is empty, and by the watcher."
  type        = string
  default     = ""
}

variable "llm_request_timeout_seconds" {
  description = "Per-request timeout for model calls."
  type        = number
  default     = 300
}

variable "llm_max_output_tokens" {
  description = <<-EOT
    Completion budget per model call. Deliberately generous: a reasoning model
    bills hidden thinking against the same budget as the answer, so a cap sized
    for the reply alone returns an empty completion.
  EOT
  type        = number
  default     = 8192
}

variable "refiner_max_steps" {
  description = <<-EOT
    Tool-call rounds the refiner gets to explore the repository before it must
    write the story. Low enough to stop a model that starts reading everything;
    high enough for list -> search -> read the few files that came back.
  EOT
  type        = number
  default     = 12
}

variable "enable_bedrock_access" {
  description = <<-EOT
    Attach bedrock:InvokeModel / InvokeModelWithResponseStream to the agent task
    roles. Set true when llm_provider = bedrock.
  EOT
  type        = bool
  default     = false
}

variable "bedrock_region" {
  description = "Region for Bedrock calls. Defaults to aws_region when empty."
  type        = string
  default     = ""
}

variable "bedrock_allowed_model_arns" {
  description = <<-EOT
    ARNs the agent task roles may invoke. Defaults to every foundation model and
    inference profile in bedrock_region. Narrow this before prod.
  EOT
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Observability
# ---------------------------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "enable_container_insights" {
  description = <<-EOT
    ECS Container Insights on the cluster.

    Off for a deployment you tear down regularly. Enabling it makes AWS create
    /aws/ecs/containerinsights/<cluster>/performance OUTSIDE Terraform's state,
    with no expiry — so it survives every destroy and accumulates across
    apply/destroy cycles. Nothing else here leaks that way; every other log
    group is a managed resource.
  EOT
  type        = bool
  default     = true
}

variable "alarm_email" {
  description = "Optional email subscribed to the alarm topic. Empty disables the subscription."
  type        = string
  default     = ""
}
