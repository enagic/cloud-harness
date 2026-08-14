# Architecture

Why the pieces fit together the way they do. Close calls are marked so they are
easy to revisit.

## The pipeline

```
        human drafts a ticket, adds the kickoff label
                          │
                          ▼
                   ┌─────────────┐
                   │  REFINER    │  clones repo, adds code context
                   └──────┬──────┘
                          ▼
                  ╔═══════════════╗
                  ║  HUMAN GATE 1 ║  approve, or send back with comments ──┐
                  ╚═══════╤═══════╝                                        │
                          │ approved                          (re-refine) ─┘
                          ▼
                   ┌─────────────┐
              ┌───▶│ IMPLEMENTER │  clones, implements, pushes PR
              │    └──────┬──────┘
              │           ▼
              │    ┌─────────────┐
              │    │  REVIEWER   │  checks out branch, reviews, runs tests
              │    └──────┬──────┘
              │           │
    changes requested     │ approved
    (attempt + 1)◀────────┤
              │           ▼
              │   ╔═══════════════╗
              │   ║  HUMAN GATE 2 ║  merge, or send back
              │   ╚═══════╤═══════╝
              └───────────┘
                          │ merged
                          ▼
                        done

    rebase required ──▶ IMPLEMENTER   (attempt unchanged)
```

Two human gates, three agents, one attempt budget. Everything between the gates
is automated; neither gate can be bypassed by an agent.

## Components

| | Shape | Size | Image | Scaling |
|---|---|---|---|---|
| Watcher | Always-on ECS service | 0.25 vCPU / 512 MB | watcher | Fixed at 1 |
| Refiner | Run-to-completion task | 1 vCPU / 4 GB | agents-base | 0..N by queue depth |
| Implementer | Run-to-completion task | 4 vCPU / 16 GB | agents-*&lt;stack&gt;* | 0..N per stack |
| Reviewer | Run-to-completion task | 2 vCPU / 8 GB | agents-*&lt;stack&gt;* | 0..N per stack |
| Dispatchers | Lambda per unit, 1-min schedule | 256 MB | — | — |

Each **(agent, stack) unit** has its own queue, DLQ, dispatcher, and alarms; IAM
roles are per agent. The implementer and reviewer exist once per stack because
they execute the target repo's build and test commands — see Runtime selection.

## Why the watcher is separate from the agents

All three agents clone repositories, so none of them can be the cheap
always-on component. But something must run continuously to notice signals, and
running a 4 vCPU task on a poll loop to do it would be absurd.

So the watcher is a fourth component that does no agent work at all: it polls,
runs the state machine, and dispatches. It makes **no model calls** — its IAM
role has no Bedrock access and it gets no model configuration. That keeps the
only always-on component at 0.25 vCPU and about $9/month.

## Why the state machine is a pure function

All the workflow rules live in `packages/shared/src/pipeline.ts` as
`decide(ticket, config) -> action`. It touches no network, no Jira, no SQS. The
watcher is the I/O shell around it.

This matters because the subtle rules — the attempt budget, the rebase
exemption, gate ordering, refusing to re-dispatch a ticket an agent already
holds — are exactly the things that break silently in production and are
miserable to reproduce. As pure functions they are covered by tests that run in
60ms (`npm test`), including a full three-strike lifecycle with an interleaved
rebase, which is where the off-by-one errors live.

`decide()` consumes an already-derived `attempts` number rather than fetching it,
so the derivation (`countAttempts`) is separately testable and swappable — if
the budget ever moves to a different source, `decide()` does not change.

## Why the agents poll SQS themselves

This is the load-bearing decision, and the one most likely to be "simplified" by
someone who has not hit the failure mode.

The obvious wiring is an SQS event-source mapping on a Lambda that calls
`ecs:RunTask`. SQS then deletes the message when the invocation succeeds — and
it succeeds as soon as the task is *launched*. From that moment the work item
exists only inside a Fargate task. If a reviewer OOMs 20 minutes into a test
suite, the ticket is gone silently. Retry and DLQ would cover only launch
failures, which are the failures we care least about.

So each dispatcher reads queue **depth** only, and the task receives its own
message:

- The message stays in flight, invisible, for the whole run.
- The task deletes it only when the work is genuinely done.
- A crash lets visibility lapse and the item is redelivered.
- After `max_receive_count` attempts it lands in that agent's DLQ, the alarm
  fires, and `AGENT=implementer make redrive` replays it.

The dispatcher IAM roles deliberately grant `sqs:GetQueueAttributes` and nothing
else — they *cannot* receive or delete a message even by mistake.

The cost is that a run longer than the visibility timeout would be redelivered
mid-flight and duplicated, so every agent extends visibility on a heartbeat
(`onProgress` in `AgentTaskContext`). The reviewer is the one most likely to
need it — test suites are slow.

**Trade-off:** up to ~60s of dispatch latency per hop, since dispatchers poll on
a schedule. Across the whole pipeline that is a few minutes, against a workflow
that pauses twice for a human.

## Why three queues instead of one

One queue with an `agent` discriminator would be less Terraform. But each agent
has a different concurrency ceiling, a different timeout profile, and a
different failure mode. Sharing a queue means a backlog of reviews starving
refinements, one DLQ whose contents have to be sorted by hand, and one alarm
that cannot tell you which stage is broken.

Separate queues also let each agent's IAM role reach exactly one queue. A
reviewer that could read the implementer queue would be able to claim
implementation work and stall the pipeline silently.

## Runtime selection

The implementer verifies its change before pushing and the reviewer runs the
suite before approving. Both execute the *target repo's* commands, so both need
that repo's toolchain — `mvn`, `pytest`, `npm` — actually present in the
container. A reviewer that cannot run the suite is reduced to reading the diff,
which is most of the value gone.

Three things had to be decided: where the answer lives, how it reaches the
right image, and what the images look like.

### Where the answer lives: the repo

`.cloud-harness.yml` at the repo root declares `stack` plus optional setup,
build, test, and lint commands. In the repo rather than in this deployment's
Terraform, because the team that owns the code owns the answer, it is reviewed
in the same PR as the build change it describes, and it is versioned with the
branch it applies to. Omitted commands fall back to the stack's configured
defaults; explicit values always win.

The watcher reads it with a **single file fetch** from the Bitbucket API, not a
clone — it runs on 0.25 vCPU with no git, and pulling a repo to learn which
runtime it needs would defeat the point of keeping it small.

### How it reaches the right image: the queue

This is the constraint that shapes everything. The dispatcher Lambda **only
reads queue depth** — it never opens a message, deliberately, so that SQS retry
semantics stay meaningful (see above). So it cannot look at a work item to
decide which task definition to launch.

The queue therefore *is* the decision. Runtime-needing agents get one queue per
stack, each feeding a task definition with that stack's image:

```
implementer-node    →  agents-node    image  (Node + corepack + node-gyp)
implementer-python  →  agents-python  image  (Python + venv + uv)
implementer-jvm     →  agents-jvm     image  (JDK 21 + Maven)
reviewer-node       →  …
refiner             →  agents-base    image  (reads source; builds nothing)
```

The watcher resolves the stack, then routes. With the default three stacks that
is 1 + 3 + 3 = **seven units**, each a queue, a DLQ, a task definition, a
dispatcher Lambda, and three alarms. That multiplication is the honest price of
the depth-only dispatcher. `local.agent_units` computes the product, so adding a
stack is one Terraform entry plus one Dockerfile.

**A repo naming an unknown stack fails the ticket with a comment listing the
valid options** rather than falling back to the default. It tried to say
something and got it wrong; quietly running its Java build in a Node image would
produce a baffling review instead of an actionable error. A repo with *no*
manifest does fall back to `default_stack` — saying nothing is different from
saying something wrong.

### What the images look like

One base image carries the agent code, git, and Node. Stack images are `FROM`
that base and add only their toolchain, so the TypeScript compile happens once
rather than once per stack.

**Debian slim, not Alpine.** The agents execute arbitrary test suites from
target repos, and musl breaks a long tail of native Node addons and most
manylinux Python wheels. The extra ~40 MB is far cheaper than debugging why a
repo's suite passes locally and not here.

The per-stack Dockerfiles carry the non-obvious bits: `python3-venv` because
Debian's PEP 668 marking makes bare `pip install` fail; `build-essential` and
`python3`/`make`/`g++` for repos with native extensions; warm writable Maven and
Gradle caches so the first build in every task is not a cold download of the
whole dependency tree; `MaxRAMPercentage` so a JVM suite sizes its heap against
the task limit rather than the instance.

### What travels in the event

`RuntimeRef` on every work item — the resolved `stack`, plus the full manifest
with stack defaults merged in. The agent gets its build and test commands before
it finishes cloning, and a work item sitting in a DLQ is self-describing: you
can see what it was trying to do without re-fetching the repo.

`runCommand` / `prepareRepo` in `services/agents/src/runtime/exec.ts` execute
those commands. That part is implemented — it is mechanical process handling,
not agent behaviour. It resolves with a non-zero exit code rather than throwing,
because a failing suite is normal and informative here; it is the reviewer's
evidence. Output is tail-truncated because it is fed to a model and pasted into
Jira comments, and a failing suite puts the useful part at the end.

## Why one base image for three agents

The three agents share almost everything: the SQS consume loop, workspace
management, the Jira and Bitbucket clients, the model seam. Separate images per
agent would be copies of identical layers and three build pipelines to keep in
step.

One image, three entrypoints, selected by `command` in each task definition.
Sizing, concurrency, and IAM still differ per agent because those live in the
task definition, not the image — and the stack dimension differs on top of that,
as above.

## The attempt budget is derived, not stored

**Nothing writes a counter.** The budget is computed on demand as:

> transitions **from** `In Progress` **into** `Code Review`, since the most
> recent time a human ticked **DOR**

read from the Jira issue changelog — both halves of it.

**Why not a label or custom field.** Both are mutable by anyone with write
access to the ticket, and neither records that they were changed. A stray label
edit — accidental or deliberate — silently grants an agent an unlimited budget,
and nothing in the system would ever show it happened. The changelog has no edit
or delete affordance in the Jira UI or REST API, and every entry carries its
author and timestamp.

**Why this is better than merely tamper-resistant.** Counting the event we
actually care about makes two properties fall out for free:

- **The exemptions are structural.** Count the *edge*, not the destination. A
  genuine attempt always arrives from `In Progress`; a rebase never leaves `Code
  Review` and so produces no such edge, and neither does a consented fix, which
  parks in the same column for the same reason. There is no conditional to break
  — a future refactor literally cannot reintroduce the bug. A busy base branch
  would otherwise exhaust the entire budget without a single review round trip,
  failing a PR for something the implementer never did wrong.

  This is also why the gate-2 rebase, which arrives at `Code Review` from
  `Validation`, needs no special case of its own.
- **The reset is a real, audited human action.** Ticking `DOR` again grants a
  fresh budget. Jira records custom field changes with author and timestamp
  exactly as it records status changes, so that is a named account changing a
  named field, permanently visible — as opposed to someone quietly editing a
  number.

**IDs, not names, on both halves.** The changelog records both `to` (ID) and
`toString` (the display name *at the time of the transition*). Renaming a status
rewrites neither, but name-based counting would break on the rename.
`resolveStatusIds()` maps configured names to IDs once at startup and fails
loudly if the board is missing one. DOR is resolved by `fieldId` for the same
reason, and `verifyFields()` fails at startup on an id the site does not have —
a mistyped custom field id is not an error to Jira, it is simply absent from
every response, which reads as "DOR was never ticked" forever.

**Cost.** The changelog is a per-issue API call, so `needsHistory()` gates it to
the tickets whose decision actually depends on the count: anything in `Code
Review` or `Validation`, and anything in `In Progress` that already has a pull
request. An `In Progress` ticket with no pull request is the first pass off gate
1, and the DOR tick that put it there is also the reset — the count is zero by
construction and not worth a call.

**What this does not defend against.** Someone who can edit `DOR` can untick and
re-tick it to reset the budget. That is an authorised action by design — but unlike a label edit, it is recorded, attributed,
and visible in the ticket's history. Jira project permissions are the control
here; the changelog is the audit trail.

The same principle applies to the PR: `findPullRequestForIssue` locates it in
Bitbucket by the `agent/<issue-key>-*` branch convention rather than trusting a
Jira remote link. Deleting the link breaks nothing. **Every piece of state the
pipeline depends on can be rebuilt from Jira's changelog and Bitbucket's PR
list** — nothing an agent wrote into a mutable field is load-bearing.

## Merge conflict detection

Conflicts have no Jira-side signal — nothing about the ticket changes when
someone else merges to the base branch. The only way to notice is to ask
Bitbucket, so the watcher polls PR state for every ticket that has one. What it
learns goes two ways: mergeability rides onto the snapshot for `decide()`, and
`reconcilePullRequest` catches the two things that end a ticket — the human's
merge, and a declined pull request.

Two guards worth knowing about:

- **`undefined` means "unknown", not "conflicted".** Bitbucket reports merge
  status as PENDING while it computes; treating that as conflicted would queue a
  spurious rebase on every fresh PR.
- **Conflicts are ignored while an agent holds the branch.** Queuing a rebase
  under a running implementer or reviewer would put two tasks on one branch.
  That guard is now the in-flight marker in `decide()` rather than a rule in
  `reconcilePullRequest`: conflict state travels on the snapshot, so a rebase is
  dispatched by the state machine like everything else and the ticket never
  leaves `Code Review` to have one.

## Why state lives on the Jira board

There is no database. Workflow state is the ticket's column plus three of its
fields; human intent is a label; everything else is derived from history
(above).

Both services are therefore stateless and restart cleanly, and a human can
drive, retry, or override any transition from the Jira UI — including replaying
a stage by moving the ticket back. For a workflow with two human gates, the
board *is* the control plane, and a database would add a second source of truth
to keep in sync with it — plus a second place to tamper with, which is exactly
what deriving from the changelog avoids.

The gap: dispatch-once is enforced by the status transition that follows a
successful enqueue, not transactionally. A crash in between produces a duplicate
dispatch, so every agent must tolerate being handed the same item twice — hence
"reuse the branch", "return the existing PR rather than creating a duplicate",
and re-reviewing the same commit being harmless.

## Model access

Nothing above `packages/shared/src/llm.ts` knows which provider is in play. The
`ChatModel` interface has one method and two implementations selected by
`LLM_PROVIDER`:

- `OpenAiCompatibleChatModel` — a single `fetch` against `/chat/completions`,
  deliberately dependency-free so swapping gateways never means swapping an SDK.
- `BedrockChatModel` — stubbed. Bedrock's Converse API maps onto this interface
  directly: system messages move to the top-level `system` field, the rest map
  to `messages`.

Auth follows the provider: the OpenAI-compatible path uses a key from Secrets
Manager; Bedrock uses the task role and creates no key secret at all. Each agent
can run a different model (`agents[*].model`), which is the knob to reach for if
the reviewer wants a different model from the implementer that wrote the code.

## Network

All workloads run in private subnets with egress via NAT — they need Jira,
Bitbucket, and the model endpoint, and nothing needs to reach them. None listens
on a port, so the workload security group is egress-only with no ingress rules
at all.

Interface VPC endpoints cover ECR, S3, CloudWatch Logs, Secrets Manager, and
SQS, keeping image pulls (not small for a 16 GB task) and credential fetches off
the NAT gateway and off the public internet.

**Trade-off:** `single_nat_gateway = true` by default. Halves NAT cost, makes one
AZ a single point of failure for egress. Correct for a POC, wrong for prod.

## Health checking

The watcher has no port, so its ECS health check runs
`node dist/healthcheck.js`, asserting the process wrote a heartbeat recently
(three poll intervals plus slack). A plain liveness check would report a watcher
wedged on a hung Jira call as healthy forever.

## Failure handling

| Failure | Behaviour |
|---|---|
| Repo declares an unknown stack | Ticket → failed with a comment naming the valid stacks |
| Repo has no manifest | Falls back to `default_stack` |
| Repo's test command fails | Normal outcome: a blocker finding, not an agent error |
| Repo declares no test command | Review reports `verification.attempted: false` rather than implying it verified |
| Test command hangs | `runCommand` timeout (default 15 min), SIGTERM then SIGKILL |
| Agent crashes / OOM / Spot interrupt | Visibility lapses, redelivered, DLQ after `max_receive_count` |
| Agent run exceeds visibility timeout | Heartbeat extends it; without one, duplicate work on the same branch |
| Malformed work item | Left to age into the DLQ rather than deleted — keeps the evidence |
| Crash between enqueue and status transition | Duplicate dispatch; agents must be idempotent |
| Jira transition fails mid-mutation | Status is applied last, so the ticket stays recoverable and the next tick retries |
| Reviewer exhausts attempts | Ticket → failed with a comment; PR and history left for a human |
| Base branch moves under an open PR | Watcher queues a rebase; no attempt consumed |
| Dispatcher fails | Per-agent alarm; queue holds; next tick recovers |
| One bad ticket | Logged and skipped; the rest of the board still processes |

## Deliberately out of scope for the POC

- Remote Terraform state (commented out in `infra/versions.tf`).
- Jira webhooks — polling avoids needing public ingress.
- Multi-repo routing — work items carry a repo ref, but the watcher fills it
  from configuration.
- Any authz on who may apply the kickoff or approval labels. Jira project
  permissions are the only enforcement point, and those labels are what stand
  between a Jira user and an agent pushing code.
- Whether the reviewer needs its own Bitbucket identity. Approving a PR as the
  same account that opened it may not satisfy the repo's merge checks.
