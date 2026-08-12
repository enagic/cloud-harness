# cloud-harness

POC for an autonomous ticket-to-PR pipeline on AWS. Three agents — refiner,
implementer, code reviewer — move a Jira ticket from rough draft to a reviewed,
mergeable Bitbucket PR, with a human gate at each end.

```
  human drafts ticket, adds kickoff label
              │
              ▼
        ┌───────────┐
        │  REFINER  │  clones repo, enriches ticket with code context
        └─────┬─────┘
              ▼
      ╔═══════════════╗
      ║ HUMAN GATE 1  ║  approve  ·  or send back with comments ──┐
      ╚═══════╤═══════╝                                            │
              │                                       (re-refine) ─┘
              ▼
        ┌─────────────┐
   ┌───▶│ IMPLEMENTER │  clones, implements, pushes PR
   │    └──────┬──────┘
   │           ▼
   │    ┌─────────────┐
   │    │  REVIEWER   │  checks out branch, reviews, runs tests
   │    └──────┬──────┘
   │           │
   └─ changes ─┤ approved
     (n of 3)  ▼
      ╔═══════════════╗
      ║ HUMAN GATE 2  ║  merge  ·  or send back
      ╚═══════════════╝
```

Merge conflicts route back to the implementer for a rebase **without** consuming
a review attempt. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why the
pieces fit together this way.

## Status

**The infrastructure and the workflow logic are done. The agent bodies are not.**

| Component | State |
|---|---|
| Terraform — VPC, ECS, 3 queues + DLQs, IAM, ECR, secrets, alarms | Complete |
| Dispatcher Lambdas (×3) | Complete |
| **Pipeline state machine** — attempt counter, rebase exemption, gates | Complete, tested (19 tests) |
| Watcher poll loop, reconciliation, dispatch | Complete |
| Agent SQS consume loop, visibility heartbeat, retry semantics | Complete |
| **Repo manifest** — `.cloud-harness.yml` parsing, stack defaults | Complete, tested |
| Stack images — base + node / python / jvm Dockerfiles | Complete |
| Command execution (`runCommand`, `prepareRepo`) with timeout + abort | Complete |
| Jira clients (read + write) | **Stub** |
| Bitbucket clients (read + write) | **Stub** |
| Refiner / implementer / reviewer bodies | **Stub** |
| Bedrock model client | **Stub** |

Every stub throws with a `TODO` naming the decisions to settle first. Deploying
today gives a running skeleton: the watcher polls, the state machine transitions
tickets, dispatchers scale tasks, queues retry — and each agent fails at its stub.

```bash
npm test   # the state machine, including the rules that are easy to get wrong
```

## Layout

```
infra/                     Terraform. The deployable part.
  lambda/dispatcher/       Backlog dispatcher (plain .mjs, no build step)
packages/shared/
  src/pipeline.ts          The state machine — pure, tested, no I/O
  src/llm.ts               Provider seam (OpenAI-compatible now, Bedrock later)
  src/types.ts             Work item contracts between watcher and agents
services/watcher/          Always-on ECS service, 0.25 vCPU / 512 MB
services/agents/           One image, three entrypoints
  src/runtime/consumer.ts  Shared SQS consume loop
  src/{refiner,implementer,reviewer}/main.ts
scripts/                   Secret population, image build/push
```

## Jira workflow

The pipeline drives Jira **status**; humans signal intent with **labels**. Every
name is configurable in `terraform.tfvars` — these must already exist on the
board, because Jira resolves transitions by name and a mismatch is a ticket that
silently never moves.

| Status | Meaning | Set by |
|---|---|---|
| `Refining` | Refiner working | Watcher |
| `Refinement Review` | **Human gate 1** | Refiner |
| `Ready for Implementation` | Approved | Human |
| `Implementing` | Implementer working | Watcher |
| `Code Review` | PR up — triggers reviewer | Implementer |
| `Reviewing` | Reviewer working | Watcher |
| `Changes Requested` | Back to implementer (+1 attempt) | Reviewer |
| `Rebase Required` | Back to implementer (no attempt) | Watcher |
| `Awaiting Merge` | **Human gate 2**, PR approved | Reviewer |
| `Done` / `Agent Failed` | Terminal | Watcher |

### Two lanes, one label

| Label | Meaning |
|---|---|
| `agent` | The agent lane. The pipeline may act on this ticket. |
| *(absent)* | The human lane. Nothing is dispatched, at any stage. |

The label is **standing consent, not a trigger**. It is checked before every
dispatch and is never consumed, so it stays on the ticket for as long as the
agents are welcome. The board column says which stage to run; the label says
whether to run at all.

A ticket may change lanes at any point in its lifecycle, and the pipeline
assumes nothing about when. Removing the label is how a human takes a ticket
back — it stops the next dispatch immediately.

> **To edit a ticket the agents are working on, move it to the human lane
> first.** Editing it in the agent lane breaks the contract, and the agent's
> write wins. Expect to lose the edit and have to redo it.

That is deliberate. The alternative — agents backing off whenever a description
changed — makes every write a negotiation and the pipeline unpredictable. One
rule, enforced consistently, is easier to work with than a clever one.

`make workflow` prints what the current deployment expects.

Labels are used **only** for signals a human deliberately sends. No pipeline
state is stored in them — see below.

### Human gate 1: reviewing a refinement

A ticket in `Refinement Review` has the refined story in its **description** and
nothing else. That story is the spec — it is what the implementer builds and
what the reviewer tests against — so it holds the work and none of the
conversation about it. It ends with the refiner's own read on itself:

```
## Estimate

Confidence: medium — the retention window is a guess; see "Cleanup" above.
Story points: 5 — one new handler plus its tests, in a module that already exists.
```

Neither number blocks anything. They are there so you can tell a confident story
from a plausible one without re-deriving the ticket yourself. Anything the
refiner could not settle is a **comment**, numbered, not in the story.

Everything the pipeline writes is signed with a `— cloud-harness` line. That is
how the refiner tells its own questions from your answers when it reads the
thread back, and it is not decoration: the pipeline has one Jira account, and if
you point it at your own, the board is otherwise a conversation with yourself.

To answer: reply in the comments and move the ticket back to a draft column
(`Backlog` / `To Do`), still in the agent lane. That re-dispatches the refiner,
which reads the whole thread, folds your answers into the story as though they
had always been in the draft, and moves it back to `Refinement Review`. Editing
the description yourself works too — move to the human lane first, then back.

To approve, move it to `Ready for Implementation`.

### The attempt budget is derived, not stored

Nothing writes a counter anywhere. The budget is computed from the Jira
changelog as *transitions into `Changes Requested` since the last transition
into `Ready for Implementation`*.

A label or custom field would be editable by anyone with write access to the
ticket, with no record that it changed. The changelog cannot be edited or
deleted through Jira's UI or REST API, and every entry is attributed.

Counting the real event also makes two things fall out for free:

- **Rebases cannot consume budget** — they move through a different status, so
  there is no conditional that a future change could break.
- **Re-approving at human gate 1 grants a fresh budget**, and that reset is a
  named account performing a named transition, permanently visible in history.

The same idea covers the PR: it is located in Bitbucket by the
`agent/<issue-key>-*` branch convention rather than read from a Jira link. Every
piece of state the pipeline depends on can be rebuilt from Jira's changelog and
Bitbucket's PR list.

## Tech stacks and dynamic testing

The implementer verifies its change before pushing; the reviewer runs the suite
before approving. Both execute the *target repo's* commands, so both need that
repo's toolchain present in the container.

A repo declares itself in **`.cloud-harness.yml`** at its root — see
[docs/example-cloud-harness.yml](docs/example-cloud-harness.yml):

```yaml
stack: node          # selects the image, and therefore the runtimes available
setupCommand: npm ci
buildCommand: npm run build
testCommand: npm test    # without this, the reviewer can only read the diff
```

The watcher fetches that one file from the Bitbucket API (no clone — it runs on
0.25 vCPU) and routes the work to the queue for that stack. **The queue is what
selects the image**: the dispatcher Lambda only ever reads queue depth, never a
message, so by the time a task launches it is far too late to discover the work
needed a JDK.

| Stack | Image carries |
|---|---|
| `node` | Node 22, corepack (pnpm/yarn), node-gyp toolchain |
| `python` | Python 3, venv, uv, build-essential |
| `jvm` | Temurin JDK 21, Maven (Gradle via the repo's wrapper) |

Adding a stack: an entry in the Terraform `stacks` variable, a
`services/agents/Dockerfile.<name>`, `apply`, `make images`. Each stack adds two
units (implementer + reviewer), and each unit is a queue, DLQ, task definition,
Lambda, and alarms — so trim the list to stacks you actually have repos for.

A repo with **no** manifest falls back to `default_stack`. A repo whose manifest
names an **unknown** stack fails the ticket with a comment listing the valid
ones — it tried to say something and got it wrong, and running its build in the
wrong image would produce a baffling review instead of an actionable error.

```bash
make stacks   # what this deployment can build and test
make units    # every (agent, stack) unit
```

## Bitbucket identities

Three separate credentials, one per identity — not one per deployment:

| Secret | Used by | Needs |
|---|---|---|
| `bitbucket-token-read` | Watcher, refiner | Read repo + PRs |
| `bitbucket-token-implementer` | Implementer | Push branches, open PRs |
| `bitbucket-token-reviewer` | Reviewer | Comment, approve |

**The implementer and reviewer must be different service accounts in
production.** Bitbucket does not count an approval from a pull request's own
author towards a minimum-approval merge check. Share one account between them
and the reviewer's `approve` call returns 200, the approval does not count, and
the ticket sits in `Awaiting Merge` with nothing in the logs to explain why —
the failure looks identical to success.

There is deliberately no fallback between the three environment variables. A
fallback would save one line in a sandbox and let a production deployment
collapse two identities silently. A sandbox writes the same value to all three
explicitly:

```bash
./scripts/put-secrets.sh --shared-bitbucket   # one token -> all three
```

`npm run preflight` warns whenever the implementer's and reviewer's tokens
match, so the compromise stays visible rather than becoming the default.

Each container receives only its own credential. The ECS execution role can
read all three because it is what performs the injection, but it is not
reachable from inside a container — so a compromised implementer holds nothing
that can approve its own pull request. That containment is the point of the
split, and it is why the identity is chosen by the task definition rather than
by a runtime flag.

App passwords were removed in July 2026. Use a **repository access token**
(Bearer, git username `x-token-auth`) or an **API token with scopes** (Basic
`email:token`, set `BITBUCKET_EMAIL`).

## Model access

Agents talk to a configurable **OpenAI-compatible** `/chat/completions` endpoint
through the `ChatModel` interface in `packages/shared/src/llm.ts`. Bedrock is the
intended destination: `BedrockChatModel` is stubbed in the same file, and
switching is `llm_provider = "bedrock"` + `enable_bedrock_access = true`, which
grants the agent task roles `bedrock:InvokeModel` and stops creating the API key
secret. No calling code changes.

Each agent can run a different model via `agents[*].model`.

The watcher makes no model calls at all — it has no model config and no Bedrock
grant.

## Getting started

```bash
# 1. Configure — and create the statuses in Jira first
cp infra/terraform.tfvars.example infra/terraform.tfvars
$EDITOR infra/terraform.tfvars

# 2. Create the infrastructure (ECR repos must exist before the first push)
make tf-init
make apply

# 3. Populate credentials — prompts, nothing echoed or written to tfvars/state
make secrets
# ...or, for a sandbox where one Bitbucket account plays all three parts:
./scripts/put-secrets.sh --shared-bitbucket

# 4. Build and push images, then roll the watcher
make images
make restart-watcher
```

## Day-to-day

```bash
make queue-depth                    # every unit's queue + DLQ at a glance
make units                          # list the (agent, stack) units
make logs-watcher                   # also logs-refiner
UNIT=implementer-node make logs-agent
UNIT=implementer-node make redrive  # replay one DLQ
make stacks                         # stacks this deployment supports
make workflow                       # statuses/labels this deployment expects
make outputs
```

## Cost

Roughly $75–95/month idle, dominated by the NAT gateway (~$32) and the
always-on watcher (~$9). Agent tasks bill only while running — the implementer
at 4 vCPU / 16 GB is about $0.20/hour.

To trim: set `use_fargate_spot = true` per agent (~70% off; SQS redelivery
already covers interruptions). To harden: `single_nat_gateway = false`.

## Decisions I made that you should sanity-check

These were unspecified and I picked a default rather than blocking:

1. **The attempt budget is derived from the Jira changelog**, not stored — see
   above. The remaining exposure is that anyone who can transition a ticket into
   `Ready for Implementation` resets the budget; that is authorised by design and
   is recorded, but Jira project permissions are the only control on *who* can.
2. **Statuses drive the machine, labels carry human intent.** Your description
   mixed both ("adds a label", "code review status"), so I used statuses for the
   pipeline and labels for the two human signals plus the counter.
3. **The refined story's structured form is unsolved.** The refiner writes to
   Jira and the implementer and reviewer need it back out machine-readable. I
   recommend a fenced JSON block under a known heading; `parseRefinedStory` in
   `services/watcher/src/work-items.ts` currently returns the raw description.
4. **Sizing for refiner and reviewer** (1 vCPU/4 GB, 2 vCPU/8 GB) is a guess.
   Only the implementer's 4 vCPU / 16 GB came from you.

## Known gaps

- **No idempotency store.** Dispatch-once relies on the status transition after
  enqueue; a crash in between duplicates a dispatch, so agents must tolerate
  being handed the same item twice.
- **Polling, not webhooks** — ~60s per hop. Fine for a twice-human-gated flow.
- **`enable_execute_command` is on** for the watcher, for POC debugging.
