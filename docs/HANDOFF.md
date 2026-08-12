# Handoff — 2026-08-12

**The refiner has run end to end on a real ticket.** KAN-6 went To Do →
Refining → Refinement Review, with a model-written story published into the
description, against live Jira and live Bitbucket. The refiner-only vertical
slice is done. What remains is the decisions below and the other two agents.

## READ FIRST

**1. The watcher's read path to dispatch is implemented and verified live.**
`BitbucketReader.readManifest` and `findPullRequestForIssue`
([`services/watcher/src/bitbucket.ts`](../services/watcher/src/bitbucket.ts))
are real, against live Bitbucket. `resolveRuntime` returns the sandbox's actual
manifest (`source: 'manifest'`, stack `node`, its four commands), and the refine
path runs `decide` → `resolveRuntime` → `buildWorkItem` to a `RefineWorkItem`
that passes `isRefineWorkItem`. The only untested step left in a dispatch is
`queues.send`, which needs SQS to exist — Terraform has still never been applied.

The earlier framing of this section was wrong about *where* the watcher died,
and the correction is worth keeping: **`rehydrate` runs before `resolveRuntime`
and calls `findPullRequestForIssue` for every ticket**, so the throw came from
there and was swallowed by the per-ticket `catch` — the ticket was logged as
"ticket processing failed" and left alone, never reaching the `Agent Failed`
marking that `resolveRuntime` would have caused. Both stubs were on the path;
only one was named.

The option that was *not* taken: skipping runtime resolution for agents that do
not need it (the refiner is `needs_runtime = false` in
[`locals.tf:6`](../infra/locals.tf), routes to a single `default` queue, and
never reads `item.runtime`). That remains available as a later optimisation —
it would save the refiner one Bitbucket call per dispatch — but it is no longer
unblocking anything, and it would have left `readManifest` to be written for the
implementer anyway. The open question it carried (what `runtime` holds on a
refine item) is moot: the refiner now gets a real one.

`getPullRequest` is **still a stub**, deliberately. It is only reached from
`reconcile`, which only runs when a ticket already has an agent PR — never true
on the refine path. Its unresolved part is mergeability, not HTTP: `PENDING`
must map to unknown rather than conflicted, or every fresh PR queues a spurious
rebase. Note `findPullRequestForIssue` fills `mergeable: true` as a placeholder,
which is safe *only* because `reconcilePullRequest` is never handed that object
— it re-fetches through `getPullRequest`. Do not start reading `mergeable` off
the lookup path.

**2. One lost source file survives only as a pinned git ref.** Written by an
earlier session, never committed, existing only as a dangling blob that
`git gc` would eventually prune:

```
git cat-file -p refs/recovered/refine-structured-rejected    # reference only
```

It is a `refine.ts` built on the rejected fenced-JSON format; it does not
compile against the current tree and is kept only as a record.

`refs/recovered/bitbucket-client-with-clone` has been **consumed** — its `clone`
is now in the tree, verified against real Bitbucket, and the ref can be deleted.

**3. Do not state sandbox ticket state from this file.** It goes stale in hours.
A previous session claimed a relabelling was outstanding when the user had
already done it. Query Jira — the dry run at the bottom prints the live board.

## Where the refiner actually is

Six steps. All six ran against KAN-6:

| # | Step | State |
|---|---|---|
| 1 | Clone the repo | Done — `BitbucketClient.clone`, verified live |
| 2 | Read the repo, write the story | Done — AI SDK tool loop, `refine.ts` |
| 3 | Re-check the ticket is still ours | Done — the lane guard |
| 4 | Write the story into the description | Done — `publishRefinement` |
| 5 | Move the card to `Refinement Review` | Done — `applyMutation` |
| 6 | Report the outcome | Done for the happy path |

### What the live run proved

- **`clone` works.** Authenticates as `x-token-auth`, `--depth 1` yields exactly
  one commit, and the token is absent from `.git/config` and `git remote -v` —
  the `GIT_ASKPASS` route does what it claims.
- **Workflow transitions work.** This was previously unverified: `resolveStatusIds`
  only checked that statuses *exist* and no ticket had ever moved. Two real
  transitions now have (To Do → Refining → Refinement Review), so the gotcha
  about unverified transitions is retired.
- **The tool loop terminates on its own.** 12-step budget, `finishReason: 'stop'`,
  `exhaustedSteps: false`, ~6.3k in / 2.2k out tokens, ~59s wall clock. The
  model read `.cloud-harness.yml` and correctly inferred that a `package.json`
  is mandatory because the manifest's own commands are `npm ci` / `npm test`.
- **Gate 1 holds.** The board now idles the ticket with "awaiting human
  refinement review", which is exactly the intended stopping point.

Worth knowing: the sandbox repo is nearly empty — `.cloud-harness.yml` and
nothing else. The refiner behaved well on it, but this has *not* exercised
exploration of a real codebase, and `readPaths` was a single file.

### Restored `clone` — what is worth preserving in it

Recovered from the pinned ref and checked against the tree before use:
`runCommand` from `runtime/exec.ts` matches, and `BitbucketConfig.role` /
`.email` both exist with the semantics it assumed.

- The token goes through a throwaway **`GIT_ASKPASS`** script, never the URL —
  so it stays out of `.git/config`, `git remote -v`, and the process list.
- Handles **both** current credential types: access token authenticates as
  `x-token-auth`, Atlassian API token as the email. App passwords were removed
  in July 2026.
- **Shell-quotes** the branch name, which comes off a human-influenced work item
  and reaches `bash -lc`.
- A **`depth`** option, now plumbed through `prepareWorkspace`; the refiner
  passes `depth: 1`. Anything that rebases must leave it unset, because a
  shallow clone cannot replay commits onto a base branch it does not have.

Push, PR lifecycle and rebase remain stubs, deliberately.

### `handle` was split out of `main.ts`

`refiner/handle.ts` holds the work, `refiner/main.ts` is now only the `bootstrap`
call — the shape `consumer.ts` already described as "thin `main.ts` entrypoints".
The reason is testability: the handler is importable without starting the SQS
consume loop, which is what let the live run drive the real code path rather
than a reimplementation of it. Do the same for the implementer and reviewer.

## What landed this session

- **The refined story is prose** (decision 1). `RefinedStory` deleted;
  `RefineOutcome.succeeded` carries a string. `parseRefinedStory` deleted from
  the watcher rather than implemented — it was already a passthrough returning
  empty arrays.
- **Two lanes, one label** (decision 2, rewritten below). `LABEL_REFINE` and
  `LABEL_CHANGES_REQUESTED` replaced by a single `LABEL_AGENT` (`agent`), plus a
  new `STATUS_DRAFT` allowlist. Verified against live Jira.
- **Agents move their own cards.** The "watcher owns all status mutations" half
  of decision 2 was struck — see the note there before rebuilding it.
- **The agent-side Jira write path**, mirroring the watcher's verified client:
  `request`, `readLaneState`, `publishRefinement`, `applyMutation`,
  `transitionTo`.
- **One hand-back, carrying a confidence and a size** (decision 4, rewritten
  below). `RefineOutcome` unchanged; the `## Estimate` block and the
  `ask_human` buffered tool are new, `getHumanComments` became
  `getConversation`, and an empty story now throws instead of publishing
  nothing. Unit-tested; not yet exercised against a live board.
- **The pipeline signs its Jira comments** (`comments.ts`), and authorship is
  read off that signature rather than off the comment's author account. The
  account check could never work in the sandbox, where one personal account is
  the pipeline *and* the human — it returned an empty thread on every second
  pass. Both `applyMutation`s sign; `selfAccountId` and `/myself` are gone.
- **Test hygiene.** `npm test` globbed only `packages/shared`, so 19 agent tests
  never ran; the glob now covers `services/*` too. Separately, the whole stale
  `dist/` went, taking 14 phantom tests with it — the suite went 68 → 54 → 77.

## Do not rebuild these

- **A results queue or any agent→watcher outcome channel.** Considered and
  rejected: agents move their own cards behind the lane guard. See decision 2.
- **`packages/shared/src/refined-story.ts`** and the fenced-JSON format. See
  decision 1 and `refs/recovered/refine-structured-rejected`.
- **`parseRefinedStory`.** Deleted deliberately; the watcher carries the
  description and never parses it.

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

### 2. Two lanes, one label — IMPLEMENTED

> Settled in a later session and now in the code. The earlier framing here was
> "standing consent, and rename the label"; what it became is a **lane model**,
> which answers the question that framing left open — when may a human edit?

`LABEL_REFINE` and `LABEL_CHANGES_REQUESTED` are both gone, replaced by a single
`LABEL_AGENT` (default `agent`). Present, the ticket is in the **agent lane**;
absent, it is in the **human lane** and nothing is dispatched at any stage.

The label is consent, not a doorbell. It is checked before every dispatch and
never consumed. The board column says which stage to run; the label says whether
to run at all. Per-stage labels were never necessary: label + a draft column
means refine, label + `Code Review` means review.

**A ticket may change lanes at any point in its lifecycle, and the pipeline
assumes nothing about when.** There is no designated edit window. The protocol
is: move to the human lane, edit, move back.

**Editing in the agent lane forfeits the edit.** If a human changes the story
while an agent is refining it, the agent's write wins. The human course-corrects
and learns the rule. The alternative — agents backing off whenever a description
changed under them — makes every write a negotiation and the pipeline
unpredictable. One rule enforced consistently beats a clever one.

Three consequences, all handled:

- **The "checked last" defence inverted, as predicted.** Kickoff used to run
  last so a lingering label could not pull a ticket backwards; under a
  persistent label that lingering state is normal. Kickoff now tests *label
  present **and** ticket in a draft column* — hence the new `draftStatuses`
  allowlist (`STATUS_DRAFT`, default `Backlog,To Do`). Without it, any column
  this state machine does not recognise would re-refine on every tick.
- **Gate 1 lost its label and gained a column.** Sending a story back was the
  changes-requested label; it is now moving the card to a draft column, which
  falls through to kickoff. One label cannot carry both the lane and the
  verdict, and the board already distinguishes them. `getHumanComments` now
  keys on *draft column + agent lane* rather than on the old label, which
  covers a first pass and a send-back identically — a first pass just finds no
  comments.
- **Mid-flight removal still collides**, and `decide()` cannot fix it: removing
  the label stops the *next* dispatch but the running agent is already gone. It
  stands down at its own **write guard**, re-reading the lane and column
  immediately before it writes. **Implemented** in the refiner.

> **Struck: "the watcher owns all status mutations."** That was this decision's
> proposed fix for the mid-flight collision, and the write guard solves the same
> problem at the source. Owning transitions centrally would have required a
> return channel from agent to watcher — a results queue or an inference scheme,
> neither of which exists — to convey something the agent already knows. It is
> also not a privilege boundary: publishing the story already requires editing
> the ticket, so transitioning it is not a bigger grant.
>
> **Agents move their own cards, behind the lane guard.** The watcher keeps
> owning the dispatch transition, which it already did. Do not rebuild the
> return path; it was considered and rejected deliberately.

What landed: `PipelineLabels.agentLane`, `PipelineConfig.draftStatuses`, the
lane guard at the top of `decide()`, the draft-column kickoff test, and the
config/Terraform/README surfaces. Four new tests cover the lane; 77 passing.

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

### 4. There is one hand-back, and it carries a confidence and a size — IMPLEMENTED

> Settled and in the code. The original framing — "the refiner needs a
> vocabulary for handing back", meaning new `RefineOutcome` variants for
> *not enough detail* and *too large* — was **the wrong shape**, and the
> reasoning it was built on is what gave it away. It had already noticed that
> both cases are the same board gesture as a success: publish, comment, move to
> `Refinement Review`, human decides. An enum whose variants all do the same
> thing is not a vocabulary; the thing that actually needed a vocabulary is the
> **story**, which is what a human reads.

`RefineOutcome` stays two variants — "here is the story" or "I crashed". What
was missing is not an outcome the pipeline branches on but two facts the model
knows and never wrote down:

- **Confidence** — how sure the refiner is that this story is what the requester
  wants. Low means it had to guess at something material, and the guess is in
  the story.
- **Story points** — the size of the work, on the fibonacci scale. Above 13 is
  not a story; it is told to say 13, describe the natural split in one line, and
  propose it as a question.

Both go in the prose, in a closing `## Estimate` section. Neither blocks
anything and nothing machine-reads them — `decide()` is still content-blind.
They exist so the human at gate 1 can tell a confident story from a plausible
one without re-deriving the ticket, which is the judgement that was previously
being asked of the outcome enum and could never have been answered by it.

**The prose is the spec, and only the spec.** It is what the implementer builds
and what the reviewer tests against, so everything in it reads as a requirement.
The conversation about the ticket — open questions, the human's answers, what
was asked last pass — stays out of it and lives in comments. A story that
accumulates its own negotiation makes every downstream reader demultiplex the
requirements from the history of how they were arrived at.

**Questions go through `ask_human`, a buffered tool.** Intent-shaped, per
decision 8, so the move to MCP re-implements a body and changes no prompt. It is
a tool rather than a separator convention in the prose because a separator puts
a parser back on the path decision 1 took one off, and it fails toward
publishing the questions into the spec. It is buffered because **nothing may
write before the lane guard** — the questions accumulate in memory and the
caller posts them as a single comment, in the same `applyMutation` that moves
the card, after consent has been re-checked.

The refiner never splits a ticket, only proposes a split. Deciding one ticket
becomes three is a human act, same as decision 3.

#### Rehydration: how a second pass knows anything

The refiner keeps no state. A second pass is reconstructed entirely from the
ticket, and nothing counts the passes — a human may have edited any part of it
in between, so the ticket *is* the state:

- **The description is the previous story.** A send-back is a column move; it
  does not touch the description. So `draftDescription` on a second pass is the
  refiner's own last output, possibly with human edits on top, and the prompt
  says improve it rather than start over.
- **The comment thread is the conversation**, and the trigger for reading it is
  the one already in the watcher: draft column + agent lane, which covers a
  first pass and a send-back identically.
- **A prior pass is detected by an agent comment in that thread**, not by the
  thread being non-empty. A human adding context to a brand-new ticket must not
  make the refiner think it wrote the description.

One thing this broke and fixed: `getHumanComments` filtered out the pipeline's
own comments, so answers would have come back with the questions removed —
"yes, use the existing one" attached to nothing. It is now `getConversation`,
returning the recent thread **tagged** `agent` / `human`, oldest first. Tagging
preserves what the filter was for (the pipeline's own findings must not read
back as if a person wrote them) without discarding the half that makes a reply
legible. Jira issue comments are flat, so order plus authorship is the only
pairing available. `TicketSnapshot.reviewerComments` and
`RefineWorkItem.reviewerComments` are gone; both are `conversation:
TicketComment[]`.

#### The pipeline signs its comments; it does not infer authorship

The tag comes from a signature in the text — `AGENT_COMMENT_SIGNATURE`, appended
by both `applyMutation` implementations, matched by `isAgentComment`
([`comments.ts`](../packages/shared/src/comments.ts)). The author account is not
consulted, and the `/rest/api/3/myself` lookup and `selfAccountId` cache are
gone with it.

**The author account was not a weak signal, it was an inverted one.** The
pipeline has one Jira identity and nothing says it is not also a person's — in
the sandbox that is exactly the setup, one personal account for the watcher, the
agents, and the human reviewing their work. Under it, `author === self` is true
for *every* comment on the ticket: the original filter therefore returned an
empty thread every time, and the tagged version that replaced it would have
labelled the human's own answers as the agent talking to itself. Both fail in
the environment this is actually being developed in, and neither fails loudly.

A signature is true wherever it is read, whoever posted it, and it does one more
thing the account check could not: on a board where the pipeline posts under a
person's account, it tells that person which comments are theirs. It is a plain
em-dashed line, the sort that ends a note anyway — prose, not syntax, per
decision 1 — and if a human strips it, one comment reads as human, which is the
gentle direction.

Sign at the write path, never at the caller. Both `applyMutation`s sign, so
every pipeline comment carries it: the refiner's questions today, the reviewer's
findings and the watcher's own notes when those land.

The 20-comment cap is taken from the newest end, so a long-lived ticket loses
its oldest exchanges — the settled ones — first.

Also resolved, because it was waiting on this decision: **an empty story from
the model throws** rather than handing back. A refiner with no story has nothing
to publish and nothing for a human to review; the throw leaves the SQS message
for redelivery, which re-runs the exploration, and the redrive policy bounds it.

#### What the live run showed, and the three prompt rules it bought

Run against KAN-6 and KAN-7 on the deployed stack. The mechanism worked on the
first try — signed comment, ADF round trip, thread read back, answers folded in.
The model's *judgement* is what needed work, and each fix below came from a real
observed failure. All are in `DEFAULT_SYSTEM_PROMPT`; none required a code change.

1. **It wrote a chat preamble into the spec.** KAN-7's description opened with
   "The repo is confirmed empty... Here is the refined story." The rule added:
   the entire output is the description, start at the first heading, nothing
   addressed to a reader. Fixed on the next run and has not recurred.
2. **It would not ask.** Three consecutive runs called `ask_human` zero times.
   KAN-6's draft said "app" without saying what kind, and the model resolved
   CLI-vs-HTTP-service itself. `ask_human` was verified working by a probe
   ticket that was genuinely unanswerable, so this was threshold, not wiring.
   The rule added draws the line at **how versus what**: framework, layout and
   port defaults are the refiner's; anything that changes what the finished
   thing *is* belongs to the requester, who is one comment away. Plus the cost
   argument — a question costs one reply before any code exists, a wrong guess
   costs an implementation and a second ticket to undo it.
3. **A guess became a requirement on the next pass — the important one.** Having
   chosen "CLI" on pass 1, pass 2 read its own story back and reported
   `Confidence: high — the stdout-CLI scope is already decided and documented in
   the ticket`. It was: the refiner had written it there. The description is the
   only state, so an unmarked guess is indistinguishable from a requirement
   forever after. Hence **`## Assumptions`**, listing what the refiner decided on
   the requester's behalf, and confidence being a function of that list rather
   than only of whether a question was asked.

**The `## Assumptions` rule does not repair a ticket that was already laundered**
— re-running KAN-6 over its own polished story produced "Assumptions: None
material", because nothing in that text says which parts were guesses. It only
works from a draft a human wrote. KAN-6 had to be reset to its original one-line
draft to test the loop, after which pass 1 asked the CLI question with
`Confidence: low`, and pass 2 — given a one-sentence human answer — folded it in
("it is **not** a web/HTTP service"), re-asked nothing, and moved to
`Confidence: high — explicitly answered by the requester`, `Story points: 1`.

Two residual flaws, both minor and both unfixed:

- **Answered items linger in `## Assumptions`** ("this was explicitly
  confirmed"). Once answered, a thing is a requirement and belongs only in the
  body; the section should shrink as answers arrive rather than become a
  changelog of them.
- **The model bundles.** On the probe it packed three distinct questions into a
  single `ask_human` call, so the comment's numbering does not match the
  questions. The per-question tool contract is right; the prompt does not yet
  insist on it.

**Standing down at the lane guard is not a hand-back** and deliberately stays an
ordinary non-retryable failure. It is the one path where the refiner has
something to say and no right to say it: the ticket is in the human lane or has
moved on, and posting a comment would be exactly the write the guard exists to
stop. The story goes to the log and nowhere else.

**No attempt budget on the refine path, and there is nothing to decide here.**
The budget exists to break a machine-to-machine loop — the implementer and the
reviewer can hand work back and forth indefinitely with nobody watching. The
refine loop has no such edge: every cycle goes refiner → `Refinement Review` →
**a human moves the card back** → refiner. A person acts between every pass, so
there is no runaway to stop, and a person who keeps sending a ticket back is
exercising the same override decision 7 already grants them.

This is already true by construction and should stay that way. `needsHistory`
([`pipeline.ts:161`](../packages/shared/src/pipeline.ts)) is true only for
`Changes Requested`, `Code Review` and `Rebase Required`, so `attempts` is never
populated on a refine tick, and `RefineWorkItem` carries no `attempt` or
`maxAttempts` at all — unlike both other work items. Do not add them.

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

**"The dispatch that is already happening" means the implement and review
dispatches only.** The counter is the implementer↔reviewer loop's loop-breaker
and nothing else's. Do not swap the label on a refine dispatch: a human moves
the card back into a draft column before every refine pass, so there is no
machine-to-machine cycle to break, and a counter there would only cap how many
times a person may ask for another pass. The counter must stay off the refine
path the way it is today — `needsHistory` excludes the draft columns and
`RefineWorkItem` has no attempt fields. See decision 4.

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

- ~~**`parseRefinedStory`**~~ — **DONE.** Deleted, not implemented. The watcher
  stops pretending to understand the ticket and just carries it.
- ~~**`acceptanceCriteria` and `relevantPaths`**~~ on `ImplementWorkItem` and
  `ReviewWorkItem` — **DONE.** Collapsed into `refinedDescription`. The
  structured `RefinedStory` went with them; it is a string now.
- ~~**`removeLabels: [labels.refine]`**~~ on the kickoff dispatch — **DONE.**
  The label survives dispatch, and a test pins that it does.
- ~~**`packages/shared/dist/refined-story.*`**~~ — **DONE.** The whole stale
  `dist/` went. It was hiding 14 phantom tests, not the 8 estimated here; the
  suite dropped 68 → 54 before new work took it back up.
- ~~**`getHumanComments` and `reviewerComments`**~~ — **DONE.** Not deleted but
  widened, to `getConversation` and `conversation: TicketComment[]`. The version
  that dropped the pipeline's own comments would have handed a second pass the
  human's answers with the questions removed. See decision 4.
- ~~**`selfAccountId` and the `/rest/api/3/myself` lookup**~~ — **DONE.**
  Deleted. Authorship comes from the pipeline's signature on the comment text,
  which is the only thing that works when the pipeline's Jira account is also a
  person's. Do not reintroduce an author check as a second signal: under a
  shared account it is true for every comment and would re-break what it is
  meant to reinforce.
- **A `needs_information` / `too_large` outcome variant.** Considered and
  rejected — decision 4. Both are the same board gesture as a success, and what
  distinguishes them belongs in the story a human reads, not in an enum nothing
  branches on.
- **Possibly `countAttempts` and `getStatusHistory`**, if the label counter
  (decision 7) fully replaces the changelog basis. Still open — decide
  deliberately rather than leaving two counters. Note `statuses.changesRequested`
  is untouched by the label deletion in decision 2; only the *label* went.

## Still open

- **Early abort on the heartbeat.** The write guard is in, but it fires only at
  the end: a run whose ticket left the agent lane in minute one still burns the
  whole model call before discovering it. `ctx.onProgress()` already runs on a
  timer and `ctx.signal` already reaches `generateText`, so checking the lane
  there would abort early. Throttle it — the heartbeat fires after every tool
  call, and that is a Jira GET each time.
- **Does the refiner create child tickets when it recommends a split, or only
  propose the breakdown in a comment?** It has no Jira issue-creation path
  today, and this is a write-permission question as much as a workflow one.
- **Whether a consented fix gets its own `ImplementReason` or reuses
  `changes_requested`** with a flag. Leaning toward its own, since it must not
  consume an attempt.
- **Whether agent-in-flight should stay a status or become a label.** The
  `Refining` / `Implementing` / `Reviewing` statuses are the watcher's
  bookkeeping, and they put machine-internal states on a human's board. Not
  urgent; noted because "zero collision" is the goal.

## Needs verifying against the sandbox

All cheap with the credentials already in hand, and all asserted from reasoning
rather than observation. The preflight harness is the natural place for them.

1. **Does Jira's changelog record label changes** with author and timestamp?
   Decision 7 leans on this.
2. **Does the issue history retain the previous description** after an edit?
   The lane rule says a human who edits in the agent lane loses that edit, and
   the justification for being relaxed about it is that Jira keeps the old value.
   Nothing has checked that.
3. **Is there any conditional-update mechanism on `PUT /rest/api/3/issue/{key}`?**
   The lane guard is check-then-write and therefore not atomic; the assumption
   is that Jira offers no `If-Match`/ETag equivalent. If one exists, the guard
   could close its remaining race entirely.
4. **How to find a human-authored PR for a ticket.** Atlassian links branches,
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

The refiner-only slice is done, and the watcher can now build its dispatch. The
next one is **that dispatch actually landing in a queue**:

1. ~~**Decide how the refine path gets past `resolveRuntime`**~~ — **DONE.**
   `readManifest` and `findPullRequestForIssue` are implemented and verified
   against the live sandbox; see READ FIRST. What is left before a watcher can
   dispatch for real is `queues.send`, and that needs SQS to exist.
2. ~~**Then decide the hand-back vocabulary**~~ — **DONE**, and it turned out
   not to be a vocabulary; see decision 4. Confidence and size go in the story,
   open questions go in a comment, and a second pass rehydrates from the ticket.
   **Verified on the deployed stack**, both passes: KAN-6 asked its question,
   took a human answer, and folded it in. Three prompt rules came out of that
   run — read "What the live run showed" before touching the prompt.
3. **Give the refiner a real repo to read.** Everything so far is one file. The
   step budget, the prompt, and `readPaths` are all untested against a codebase
   with actual structure. This is also where the `## Estimate` block gets its
   first honest test: on a one-file repo every story is a 3.

Deploying is not on this path and is still a long way off — Terraform has never
been applied.

Not on the critical path, and fine to leave: the attempt counter moving to
labels (decision 7), the Atlassian tool shapes (decision 8), and everything
about the implementer and reviewer.

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
  request. Kickoff is the label on a ticket in a draft column.
- **Do not state sandbox ticket state from this file.** It goes stale within
  hours and a previous session asserted a relabelling was outstanding when the
  user had already done it. Query Jira — the dry run below prints the board and
  what the state machine would do with it.
- ~~**Workflow transitions are unverified.**~~ Retired: KAN-6 has now moved
  To Do → Refining → Refinement Review through `applyMutation` against the live
  board. `resolveStatusIds` still only checks that statuses *exist*, but the
  transition path itself is proven.
- **`terraform fmt`** flags a pre-existing issue in `locals.tf`, unrelated to
  recent edits.
- **Bitbucket 404s a repo the credential cannot see**, with the same status as a
  file that is not there. `readManifest` therefore reported "no manifest" for
  `kwon-cloud/java-sandbox` — which the read token has no access to — and
  `resolveRuntime` fell back to the default stack, i.e. it was about to run a
  Java repo in the Node image. Fixed: after every filename 404s, the repo itself
  is probed, and an unreadable repo throws instead of reporting absence. The
  read identity is a **repository** access token scoped to `sandbox` alone; a
  second repo needs a workspace access token. Note `BITBUCKET_DEFAULT_REPO` is
  still single-repo config (multi-repo is a TODO at `index.ts:215`), so pointing
  the watcher at a different repo today means changing tfvars.
- **`kwon-cloud/java-sandbox` exists and is parked.** A real Maven project on
  `develop` — Java 21, JUnit 5, a passing suite, and a `.cloud-harness.yml`
  declaring `stack: jvm` — built as the fixture for a jvm end-to-end run later.
  **Its build has never been executed:** there is no JDK, no Maven and no Docker
  on the dev machine, so the POM and the three manifest commands are unverified.
  Run them once in the jvm agent image before trusting a jvm e2e result. Focus
  is the node repo (`kwon-cloud/sandbox`) until then.
- **macOS ships bash 3.2, so `declare -A` is a trap in `scripts/`.** It is not a
  syntax error there — it silently declares an *indexed* array and evaluates
  each subscript as arithmetic, so the script dies on its own first lookup with
  "unbound variable". `put-secrets.sh` had this and never ran on this machine;
  it now uses `case` functions instead. Do not reintroduce associative arrays
  without a version guard.
- **The stack is built to be destroyed daily** — `disposable_deployment = true`
  in `infra/terraform.tfvars`. Without it `destroy` fails on ECR repos holding
  images, and the secrets' 7-day recovery window reserves their names so the
  *next* apply fails. Container Insights is off for the same reason: it creates
  a performance log group outside Terraform's state that survives every destroy.
  Deregistered ECS task definitions still accumulate as INACTIVE revisions;
  nothing in Terraform can remove those.
- **`tsc --build` leaves orphaned output in `dist/`.** That is how a deleted
  source file kept passing its tests. If test counts ever look surprising, check
  `dist/` against `src/`.
- **Terraform has been applied and the whole pipeline ran in AWS.** 133
  resources; KAN-7 went To Do → Refining → Refinement Review with a 5,142-char
  story, driven by the deployed watcher, the SQS queue, the dispatcher Lambda
  and a Fargate refiner task. `stackSource: "manifest"` in the dispatch log is
  `readManifest` working against live Bitbucket. Queue drained, DLQ empty.
- **`npm ci` failed in the image build: `zod@4.4.3` was missing from
  `package-lock.json`.** Pre-existing drift — `packages/shared` and
  `services/agents` both declare zod and the lock was never regenerated. Local
  `npm test` passes regardless because `node_modules` already has it, so only
  `npm ci` in Docker catches it. Fixed with `npm install --package-lock-only`;
  **the updated lockfile is uncommitted.**
- **Do not force a watcher redeployment immediately after `apply`.** The first
  task died with `CannotPullContainerError` — a timeout to the ECR interface
  endpoint's IP, which was still settling. ECS retried and the next task came up
  clean, so it costs a couple of minutes, not a failure.

## Verifying the state machine without deploying

This dry-run prints what the watcher *would* do against the live board. It was
useful enough to keep, but was never promoted out of scratch — the user declined
an `npm run dryrun` script.

The lane model is confirmed end to end against real Jira, not just unit tests.
Illustrative only — **query the board, do not quote this**:

```
KAN-6   [To Do             ] labels=["agent"]  dispatch_refine  -> Refining
KAN-6   [Refinement Review ] labels=["agent"]  idle  awaiting human refinement review
```

The second line is the state the refiner leaves behind, and it is where KAN-6
was parked after the live run.

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
