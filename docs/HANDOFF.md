# Handoff — 2026-08-11

A design session. One line of code changed; the rest is decisions that were
previously either open or made silently by an earlier session without a
discussion. Delete this file once the work it describes lands.

**Nothing below is implemented.** The decisions are settled, the code does not
reflect them yet. Read "What these decisions delete" before writing anything —
several of them remove work rather than add it.

## What changed this session

| Area | State |
|---|---|
| `packages/shared/src/config.ts` | **`boolEnv` added.** Unblocked the build |
| Refined-story format (was open decision #2) | **Settled: prose.** Not fenced JSON |
| Agent label semantics | **Changed:** standing consent, not a one-shot trigger |
| Attempt counter | **Moving** from status changelog to labels |
| Atlassian access | **Going behind tools**, agent side only |
| Fixer agent | **Ruled out.** The implementer already is one |

## The build was broken; it isn't now

`services/agents/src/runtime/model.ts` imported `boolEnv` from
`@cloud-harness/shared`, which did not exist — only `requireEnv`,
`optionalEnv`, and `intEnv`. Since `npm test` builds first, one missing export
was blocking the entire suite.

Added at [`config.ts`](../packages/shared/src/config.ts), following `intEnv`'s
idiom: it throws on an unrecognised value rather than quietly treating it as
false. A flag that reads "yes" as off is worse than one that refuses to start.
It reaches the agents through the existing `export * from './config.js'`.

`npm test` is now **68/68 passing**.

## A lost file you should not recover

`packages/shared/src/refined-story.ts` does not exist. Its compiled output
does — `packages/shared/dist/refined-story.js` and `.test.js`, timestamped
2026-08-10 16:45. `dist/` is gitignored and the source was **never committed**,
so there is no commit to restore from.

Because the test script runs `node --test "packages/shared/dist/**/*.test.js"`,
eight `renderRefinedStory` / `parseRefinedStory` tests in that 68 are executing
stale compiled JS with no source behind it. `tsc --build` does not remove
orphaned outputs, which is why nothing complained.

It implemented the fenced-JSON format. **That approach was rejected this
session** — see decision 1. Delete the stale artifacts rather than
reconstructing the source. The last session built it without having the
discussion; this session had the discussion and went the other way.

## Decisions made this session

### 1. The refined story is prose

Not a fenced JSON block, not custom fields.

The reason is workflow, not serialisation. This system integrates machines into
an existing human workflow, and the ticket has to stay interchangeable between
the two — a human must be able to pick it up at any point and carry it, and an
agent must be able to read what a human wrote. A JSON block makes the ticket the
agent's private scratch space and makes the human's edit at gate 1 either
awkward or silently ignored.

The only thing that could have justified a machine format is not there:
**`decide()` never reads `ticket.description`.** It routes entirely on
`ticket.status`, `ticket.labels`, and `ticket.attempts`
([`pipeline.ts:234`](../packages/shared/src/pipeline.ts)). The one consumer in
this system that is not a model is completely content-blind. Everything that
actually reads the story is a model, and models read prose.

Structure is still welcome — headings, bullets, a table. The distinction that
matters is **conventional structure versus syntactic structure**. A heading is
something a human writes anyway and a model reads for free; a parser's grammar
breaks the moment someone edits around it. This document is the intended model:
prose a person would write, structured enough that a machine gets oriented fast.

### 2. The agent label is standing consent, not a trigger

Today the label is self-consuming: dispatching the refiner removes it in the
same mutation ([`pipeline.ts:349`](../packages/shared/src/pipeline.ts)). It is a
doorbell. Nothing downstream ever checks for it again.

It becomes a flag that persists and is checked before **every** dispatch. No
label, no agent. `decide()` gains an early guard and the pipeline turns into
opt-in at every stage rather than opt-in at the front door.

The label should also be renamed to something generic — not `agent-refine`.
Per-stage labels are unnecessary because **the board column already says which
stage to run**: label + `To Do` means refine, label + `Code Review` means
review. Status carries the stage, the label carries the consent.

Two consequences that are easy to miss:

- **The "checked last" defence inverts.** The comment at
  [`pipeline.ts:346`](../packages/shared/src/pipeline.ts) explains that kickoff
  runs last so a lingering label cannot pull a ticket backwards. That assumes a
  lingering label is a mistake. Under this model it is the normal state, so the
  kickoff branch must become *label present **and** ticket is in a draft
  status*. Otherwise any board column the state machine does not recognise — and
  a real kanban board will have some — falls through to kickoff and re-refines
  on every tick.
- **Mid-flight removal still collides.** A human pulls the label while the
  refiner is running. Nothing new dispatches, but the running agent finishes and
  applies its own terminal mutation, yanking the ticket out from under the
  person who just took it over. Fix: **the watcher owns all status mutations**
  and agents only report outcomes. That fits the existing shape, since the
  watcher is already the only thing that transitions tickets on dispatch.

### 3. Leaving the pipeline is a human act

There is no "this isn't for an agent" outcome and no status for it. That is not
a judgement an agent should be making.

In practice it is the organic result of a human saying *hold my beer* — because
explaining the work takes longer than doing it, or because the evaluation turned
up something unwieldy that wants cleaning up before stochastic agents go in and
make it worse. Removing the label pulls the ticket out of the pipeline, and the
human moves it through the board with zero collision.

This supersedes an earlier suggestion in this session that the refiner should
have a terminal "hand off to a human developer" status. It should not.

### 4. The refiner needs a vocabulary for handing back

`RefineOutcome` is currently exactly two things
([`types.ts:188`](../packages/shared/src/types.ts)):

```
succeeded { refined }   |   failed { reason, retryable }
```

"Here's your story" or "I crashed." Two real cases fit neither:

- **Not enough detail to proceed.** Not a failure, and retrying will not help —
  it needs a human to add information.
- **Enough detail, but the effort is too large.** The output is a proposed
  breakdown, not a story.

Both are gate 1: comment on the ticket, move to `Refinement Review`, human acts.
That loop already exists — the human sends it back with the changes-requested
label, which re-dispatches the refiner
([`pipeline.ts:262`](../packages/shared/src/pipeline.ts)). What is missing is
the outcome variant and the fact that today the ticket would look identical to a
successful refinement; the human only learns the difference by reading the
comment.

### 5. Agents may review anyone's code; they may only write with consent

The rule is **ask the PR author**, and it resolves cleanly in both directions.
On an agent-authored PR the author is the implementer identity, so asking is a
no-op and the normal pipeline runs autonomously. On a human-authored PR the
author is a person, and consent is required.

This exists because there will genuinely be times a human developer wants an
agent to fix trivial things — failing tests, typos, merge conflicts. Banning
agents from human branches outright would kill the case worth having.

The ticket status only says whose turn it is. **What** to fix lives in the PR
review comments, which is a different question and the current design conflates
them.

- **Consent is per review comment, not per PR.** That is what makes "fix these
  three, I'll handle the fourth" expressible, and partial fixes are the most
  valuable property here.
- **Granted by replying in-thread** on the specific comment. The human answers
  where the question was asked, and threading gives per-item consent for free. A
  single channel carrying N independent topics forces the reader to
  demultiplex — a PR with five review comments has that problem natively.

**This is the largest architectural consequence in this document.** The
implementer today is dispatch → work → done, one task, one shot. This makes it
dispatch → propose → *wait, possibly hours* → work. A container cannot sit idle
waiting for a human, so it becomes two dispatches with the human in between:

- a state meaning "agent has proposed, awaiting the author's answer" — a third
  human gate, living in the PR rather than on the board
- the watcher polling PR **comments**, not just PR state; `reconcilePullRequest`
  currently looks at the latter only
- an outcome for "fixed 3 of 5, here's what I left and why," which nothing in
  `ImplementOutcome` can express

Scope this before writing the implementer.

### 6. No separate fixer agent

The implementer already is one. `ImplementReason` is
`'initial' | 'changes_requested' | 'rebase'` — two of three are already "fix
something on a branch that exists," and the handler already takes
`existingBranch` and `pullRequestUrl`. A consented fix is a fourth reason on a
path that is already built.

Splitting it would cost another task definition and SQS queue **per stack**
(`for_each = local.agent_units` in [`agents.tf:19`](../infra/agents.tf), three
stacks), a task role, a work item type and validator, an outcome type, and a
Bitbucket identity decision — and if the answer to the last is "the
implementer's," you have deployed the same service twice with a different
prompt. Per-agent model and reasoning-effort config already exists in the task
definition, so the usual reason for splitting is already handled.

The one serious argument for splitting is blast radius: a full implementer
pointed at a human's branch is a bigger thing than a fixer that may only touch
files the PR already touches. That is a **constraint**, and constraints can be a
function of the invocation reason — narrower tools and a lower step budget when
the reason is a consented fix. Expressing it in the deployment only guarantees
it drifts from the implementer over time.

Also: all three agents are still stubs. A fourth before one works end to end is
speed in the wrong direction.

### 7. The attempt counter moves to labels

**The model must not be the thing that counts it.** A loop-breaker that depends
on a stochastic component fails in the one direction that matters: when it is
wrong, it is wrong toward "keep going." Whatever else is uncertain here, the
thing that stops runaway spend should be arithmetic.

`TicketMutation` already carries `addLabels` and `removeLabels`
([`pipeline.ts:201`](../packages/shared/src/pipeline.ts)), and the watcher
already does swap-style mutations, so
`removeLabels: ['agent-attempt-2'], addLabels: ['agent-attempt-3']` rides along
on the dispatch that is already happening. No new storage, and the current count
is visible on the card.

This also decouples the counter from status transitions, which is now
*necessary*: a consented fix (decision 5) must **not** consume an attempt. The
budget exists to stop an agent looping unproductively against a reviewer, and a
human explicitly asking for a fix is not that.

One correction to the reasoning currently in the code. The comment at
[`pipeline.ts:69`](../packages/shared/src/pipeline.ts) justifies the changelog
approach by saying a label can be edited by anyone "and nothing records that it
happened." That last part appears to be wrong — Jira's changelog records label
field changes the same way it records status changes, with author and timestamp.
A label-based counter keeps its audit trail. **Verify this against the sandbox
before relying on it** (see below).

What remains true is that a human can edit a label and reset the budget. Under
this design that is a feature, not a hole — it is the same override as removing
the agent label. The person taking responsibility for the ticket is allowed to
give it another go.

### 8. Atlassian access goes behind tools — agent side only

The end goal is Atlassian through MCP. It is not available yet, but wrapping
agent-side access in tools now creates the seam that makes the migration cheap.

**The watcher is explicitly excluded.** MCP exposes tools to a model and the
watcher is not one — `decide()` is arithmetic over statuses and labels. There is
also a concrete risk: `getStatusHistory` ([`jira.ts:237`](../services/watcher/src/jira.ts))
returns changelog entries with **status IDs**, and the comment above it explains
why that precision is load-bearing. That is exactly the kind of unglamorous
exact shape a model-facing tool surface does not preserve. The watcher's Jira
client is also the one piece that is implemented and verified against live
credentials; it should stay out of the migration path entirely.

The agent side is free to change: every method in
[`clients/jira.ts`](../services/agents/src/clients/jira.ts) and the API half of
[`clients/bitbucket.ts`](../services/agents/src/clients/bitbucket.ts) is still a
stub. There is nothing to migrate — this is a shape choice for code that has not
been written.

The honest framing: an abstraction layer built only for an undated migration
would be speculative. What makes it right here is that **the agents need tools
regardless** — they are AI SDK tool-loop agents and `createRepoTools` already
returns a `ToolSet`. MCP just makes an already-correct decision pay twice.

**Shape the tools around intent, not transport.** `jira_transition_issue(key,
transitionId)` is a renamed REST endpoint; on migration day the MCP server's
tools will have different names, schemas and return shapes, so you rewrite the
wrappers *and* retune the prompts that reference them. `hand_back_to_human(reason)`
is defined by the workflow — you re-implement its body on MCP primitives and the
prompt does not change by a word.

Balance: **intent-shaped for writes, primitive-shaped for reads.** Writes are
few and each means something specific in the pipeline. Reads are exploratory and
the model should be free to poke around, exactly as `list_directory` /
`read_file` / `search_repo` already work.

Two things make this cheaper than it sounds. Decision 2's "watcher owns all
mutations" collapses most of the agent's Jira surface — what is left is roughly
comment, publish the refined story, and report an outcome. And `BitbucketClient`
is currently two unrelated things in one class: `clone` / `pushBranch` /
`rebaseOntoBase` are git over the wire and will never be MCP no matter what
Atlassian ships, while `openPullRequest` / `approvePullRequest` /
`commentOnPullRequest` are the actual migration candidates. Splitting those is
worth doing on its own merits.

## What these decisions delete

Read this before implementing anything — several of these are subtractions.

- **`parseRefinedStory`** ([`work-items.ts:41`](../services/watcher/src/work-items.ts))
  — delete it, do not implement it. The watcher stops pretending to understand
  the ticket and just carries it.
- **`acceptanceCriteria: string[]` and `relevantPaths: string[]`** on
  `ImplementWorkItem` and `ReviewWorkItem` — they collapse into the description
  the agent reads.
- **`removeLabels: [labels.refine]`** on the kickoff dispatch
  ([`pipeline.ts:352`](../packages/shared/src/pipeline.ts)) — the label must
  survive.
- **`packages/shared/dist/refined-story.*`** — stale artifacts of a rejected
  approach.
- **Possibly `countAttempts` and `getStatusHistory`**, if the label counter
  fully replaces the changelog basis. Decide deliberately rather than leaving
  two counters.

## Still open

- **Does the refiner create child tickets when it recommends a split, or only
  propose the breakdown in a comment?** It has no Jira issue-creation path
  today, and this is a write-permission question as much as a workflow one.
- **The generic label name.** `agent-refine` is going away; what replaces it is
  unchosen. Note `LABEL_REFINE` in config and the `refine` field on
  `PipelineLabels` both rename with it. The changes-requested label is a
  separate thing and stays.
- **Whether a consented fix gets its own `ImplementReason` or reuses
  `changes_requested`** with a flag. Leaning toward its own, since it must not
  consume an attempt.
- **Whether agent-in-flight should stay a status or become a label.** The
  `Refining` / `Implementing` / `Reviewing` statuses are the watcher's
  bookkeeping, and they put machine-internal states on a human's board. Not
  urgent; noted because "zero collision" is the goal.

## Needs verifying against the sandbox

Both are cheap with the credentials already in hand, and both are things this
session asserted from reasoning rather than observation. The preflight harness
is the natural place for them.

1. **Does Jira's changelog record label changes** with author and timestamp?
   Decision 7 leans on this.
2. **How to find a human-authored PR for a ticket.** Atlassian links branches,
   commits and PRs to an issue when the key appears in the name, message or
   title — that part is standard. The question is how to read it back. The
   `dev-status` endpoint is widely used but effectively internal and only works
   if the workspace is connected to the Jira site. Querying Bitbucket directly
   for open PRs matching the issue key is fully supported and needs no Jira
   configuration. Try both against a known key and take the robust one.

This matters because `dispatch_review` bails out entirely when `branch`,
`pullRequestUrl` and `pullRequestId` are missing
([`work-items.ts:104`](../services/watcher/src/work-items.ts)) — and those are
populated by the implementer when *it* opens the PR. A human-authored PR leaves
them empty and the watcher silently does nothing. Decision 5's "apply the label
at code review" does not work until this is solved.

## Suggested next step

Unchanged in spirit: a **refiner-only vertical slice**, one agent working end to
end on a real ticket. The uncommitted work already covers the model seam
(`runtime/model.ts`) and the repo tools (`refiner/repo-tools.ts`).

What this session changed about it: the refiner now needs a prose renderer
rather than a JSON serialiser, a hand-back vocabulary (decision 4), and its Jira
writes shaped as intent-level tools (decision 8). The subtractions in "What
these decisions delete" should land first — they make the slice smaller.

The label semantics (decision 2) are watcher work and can be done in parallel;
they are self-contained and well covered by the existing state machine tests.

## Decisions from earlier sessions that still hold

- **Bitbucket identities are split three ways** (read / implementer / reviewer),
  because Bitbucket does not count an approval from a PR's own author towards a
  minimum-approval merge check. Production uses separate service accounts;
  sandbox writes one token to all three via
  `./scripts/put-secrets.sh --shared-bitbucket`. Decision 5 now leans on this
  for a second reason: the system can tell its own branches from a human's.
- **Model-agnosticism is a hard requirement.** The Claude ecosystem is off the
  table in production. The `ChatModel` seam is load-bearing.
- **DeepSeek via OpenRouter is a sandbox cost choice**, not a production model
  decision.
- **The agent framework is the Vercel AI SDK** (was open decision #1). Adopted
  in the uncommitted `runtime/model.ts`, which implements both the
  openai-compatible and Bedrock providers. Mastra, the Claude Agent SDK, Vercel
  Eve, Strands and LangGraph.js were all considered and set aside; the AI SDK
  supplies the one genuinely missing thing, the tool loop inside a single agent
  invocation. **Pin the major version.** Not a one-way door — Mastra's
  `withMastra()` wraps an AI SDK model if orchestration is ever wanted.
- **The pipeline stores no workflow state of its own.** Jira is the store. This
  is what made decision 1 decidable — if the watcher had needed structure out of
  the description, prose would have cost something.

## Gotchas

- **`source .env.local` fails in zsh.** Values contain spaces (`Refinement
  Review`) and are unquoted. Use `node --env-file=.env.local`.
- **Shell env beats `--env-file`**, so the Atlassian token never needs to be
  written to disk: `export JIRA_API_TOKEN="$ATLASSIAN_PAT"`.
- **A ticket in `Refining` / `Implementing` / `Reviewing` is treated as
  in-flight** and idles forever. That status is the watcher's own receipt, not a
  request. Kickoff is the label on a draft ticket. KAN-4 and KAN-5 were stuck
  this way; KAN-6 is staged as `To Do` + `agent-refine`.
- **Workflow transitions are unverified.** `resolveStatusIds` only checks that
  statuses *exist*. The user confirmed no transition restrictions were
  configured, but nothing has actually moved a ticket yet.
- **`terraform fmt`** flags pre-existing issues in `locals.tf` and
  `variables.tf`, unrelated to recent edits.
- **`tsc --build` leaves orphaned output in `dist/`.** That is how a deleted
  source file kept passing its tests. If test counts ever look surprising, check
  `dist/` against `src/`.
- **Terraform has never been applied. No AWS resources exist.**

## Verifying the state machine without deploying

This dry-run prints what the watcher *would* do against the live board. It was
useful enough to keep, but was never promoted out of scratch — the user declined
an `npm run dryrun` script.

```js
const R = '/Users/mkwon/Code/cloud-harness';
const { loadJiraConfig, loadPipelineConfig, decide, needsHistory, countAttempts } =
  await import(`file://${R}/packages/shared/dist/index.js`);
const { JiraClient } = await import(`file://${R}/services/watcher/dist/jira.js`);

const noop = { debug(){}, info(){}, warn(){}, error(){}, child(){ return noop; } };
const jira = new JiraClient(loadJiraConfig(), loadPipelineConfig(), noop);
const pipeline = loadPipelineConfig();
const statusIds = await jira.resolveStatusIds();

for (const t of await jira.listPipelineTickets()) {
  if (needsHistory(t.status, pipeline)) {
    t.attempts = countAttempts(await jira.getStatusHistory(t.issueKey), statusIds);
  }
  const a = decide(t, pipeline);
  console.log(t.issueKey, `[${t.status}]`, a.kind, a.kind === 'idle' ? a.reason : `-> ${a.mutation.status}`);
}
```

Run with `node --env-file=.env.local <file>.mjs`.
