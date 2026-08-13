# Handoff — 2026-08-13

**All three agents are now built, and the third one has reviewed a real pull
request.** KAN-6 went To Do → Refining → Refinement Review → Ready for
Implementation → Implementing → Code Review, there is a real pull request on
`kwon-cloud/sandbox` with four files in it that the repo's own `npm test`
passes, and the reviewer has read that pull request, run its suite and reached
`approved` — against live Bitbucket, live Jira and a live model. What it has
**not** done yet is write: the run below was stopped deliberately before the
first comment. See "Where the reviewer is".

The sandbox repo is no longer empty, which retires the biggest caveat this
document used to carry — see "The repo now has code in it".

Reconciled against the tree on 2026-08-13: working tree clean, 201 tests
passing.

**Decision 9's anchoring rule was wrong about the mechanism and is corrected in
place.** It said a finding whose anchor Bitbucket rejects should degrade
outward. Bitbucket does not reject anchors — an inline comment on line 9999 of a
one-line file returns 201, as does one on a path the pull request never touches.
There is no rejection to catch, so the check moved in front of the write. This
is the third endpoint in this project that turned out not to behave the way this
document reasoned it would; see READ FIRST item 1 for the previous two.

**Decisions 9 and 10 are still the ones to read before touching the reviewer.**
Review findings live in Bitbucket as one comment per finding, not on the Jira
ticket and not as a single thread; and no agent may assume it is looking at
something for the first time. Between them they settled `reviewFeedback`
(now deleted), dissolved `publishReview` (now deleted), and required a
PR-comment read path that has since been built. Decision 9 **reverses** the
direction an earlier session was leaning — that reasoning is preserved in the
decision so it is not re-derived.

## READ FIRST

**0. Check what an endpoint does before designing around what it should do.**
This is now the most repeated lesson in this document and it has cost three
separate designs. `merge_status` does not exist; the diff endpoint answers a
different question than the one it looks like it answers; and — new this session
— **Bitbucket accepts an inline comment on a line that is not in the diff, and
on a path that is not in the pull request at all, with 201 and no complaint.**

The last one is the expensive shape, because the failure is silent on both
sides: the API says created, the comment exists, and it is attached to nothing a
human will ever scroll past. The only tell at creation is an empty
`context_lines`, and the list endpoint omits that field entirely, so there is not
even a post-hoc check. A finding lost this way is lost completely.

What it changed: the reviewer parses the pull request's own diff into the set of
addresses that exist (`reviewer/diff.ts`) and resolves every anchor against it
**at the moment the model reports the finding**, degrading line → file → pull
request and telling the model what happened while it can still aim again. The
degradation rule decision 9 asked for survives intact; only the trigger moved,
from "Bitbucket rejected it" to "this address does not exist".

The cheap probe that produced this is three POSTs and a GET against a real pull
request. Do that before writing the next client method.

**1. When a ticket "fails processing", walk the tick from the top of the loop,
not from the action it was going to take. ** ~~`getPullRequest` is a stub, and it
blocks every ticket that has a PR.~~ **Resolved** — it is implemented, and the
tick now reaches `dispatch_review` for both KAN-6 and KAN-8 against the live
board. The shape it left behind is worth keeping, because it has now bitten
twice: a stub *upstream* of the thing being blamed, hidden by the per-ticket
`catch`. `rehydrate` before `resolveRuntime` was the first — see item 2.

What made it invisible: `reconcile` runs *before* `decide`
([`index.ts:128`](../services/watcher/src/index.ts)) and fires on
`ticket.pullRequestId !== undefined`, which `rehydrate` populates from
`findPullRequestForIssue`. The moment the implementer opened PR #1, a stub this
document had called unreachable was on the hot path for every ticket with a PR,
throwing into a `catch` that logged "ticket processing failed" and moved on.

**What the mergeability question turned out to be**, since it was the open part
and the answer was not the one this document guessed at. Both approaches
suggested here were wrong, and both were checked against live Bitbucket rather
than reasoned about:

- **There is no merge-status field.** `?fields=merge_status` on the PR resource
  returns `{}`. So the PENDING → unknown mapping this document worried about
  never arises, because nothing reports PENDING.
- **The diff endpoint does not answer it either.** `.../pullrequests/{id}/diff`
  302s to a *three-dot* diff (`topic=true`), computed from the merge base, which
  succeeds whether or not the merge would. Treating a 555 as the conflict signal
  would have detected timeouts, not conflicts.
- **`.../pullrequests/{id}/conflicts` is the answer.** It redirects to
  `/file-conflicts/{spec}` and pages the conflicting paths —
  `{"values": [], "size": 0}` for a clean PR, and entries like
  `{"path": "package.json", "scenario": "content"}` for a dirty one. Asked only
  of OPEN PRs, with `pagelen=1` (which survives the redirect) since only the
  count matters.

**Every case the poll cannot answer confidently returns `undefined`, never
"conflicted"** — PR deleted, a state we do not model (`SUPERSEDED`), the
conflicts call failing. A rebase queued on a guess costs an implementer run and
an attempt; a skipped tick costs a minute. A refused read of the PR *itself*
still throws, because that is a credential or repo problem and belongs on the
board.

Note `findPullRequestForIssue` fills `mergeable: true` as a placeholder, which is
safe *only* because `reconcilePullRequest` is never handed that object — it
re-fetches through `getPullRequest`. Do not start reading `mergeable` off the
lookup path.

The conflicted branch is the one thing **not** exercised against a live PR: the
sandbox has no conflicted PR to point at, and making one means moving `develop`
under an open PR. The response shape it is coded against is real, though — it
was read off a genuinely conflicting revspec, PR #2's head against PR #1's,
through the same `/file-conflicts` endpoint the PR path redirects to. Merging
either PR (see "The repo now has code in it") would make the other one a live
conflicted case, which is the cheapest way to close this.

**2. The watcher's read path to dispatch is implemented and verified live.**
`BitbucketReader.readManifest` and `findPullRequestForIssue`
([`services/watcher/src/bitbucket.ts`](../services/watcher/src/bitbucket.ts))
are real, against live Bitbucket. `resolveRuntime` returns the sandbox's actual
manifest (`source: 'manifest'`, stack `node`, its four commands), and the refine
path runs `decide` → `resolveRuntime` → `buildWorkItem` to a `RefineWorkItem`
that passes `isRefineWorkItem`.

This section used to end "the only untested step left in a dispatch is
`queues.send`, which needs SQS to exist — Terraform has still never been
applied." **That is stale and was contradicted elsewhere in this document.**
Terraform has been applied, 133 resources came up, and KAN-7 and KAN-8 both ran
dispatch → SQS → dispatcher Lambda → Fargate on the deployed stack. `queues.send`
is exercised. See the gotcha near the end for what the deployed runs cost and
what they caught.

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

`getPullRequest` was the last stub on the tick and is now implemented — see
item 1. Nothing on the watcher's poll path is a stub any more.

**3. One lost source file survives only as a pinned git ref.** Written by an
earlier session, never committed, existing only as a dangling blob that
`git gc` would eventually prune:

```
git cat-file -p refs/recovered/refine-structured-rejected    # reference only
```

It is a `refine.ts` built on the rejected fenced-JSON format; it does not
compile against the current tree and is kept only as a record.

`refs/recovered/bitbucket-client-with-clone` has been **consumed** — its `clone`
is now in the tree, verified against real Bitbucket, and the ref can be deleted.

**4. Do not state sandbox ticket state from this file.** It goes stale in hours.
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

## Where the implementer is

The `initial` reason is done and has run live. Six steps, all of which ran
against KAN-6:

| # | Step | State |
|---|---|---|
| 1 | Clone the repo, full depth | Done — `prepareWorkspace`, no `depth` |
| 2 | Branch off the base | Done — `createBranch`, `checkout -B` |
| 3 | Read, write, run the suite | Done — AI SDK tool loop, `implement.ts` |
| 4 | Re-check the ticket is still ours | Done — the lane guard |
| 5 | Commit, push, open the PR, link it | Done — all four verified live |
| 6 | Move the card to `Code Review` | Done — `applyMutation` |

`changes_requested` is **rejected up front** as unimplemented rather than half
handled: it needs the review findings in front of the model, and it is where
decision 5's unresolved consent question lands. It no longer refuses silently —
see "The rebase path" below for why that mattered.

### The rebase path

Built, and covered by tests that drive real git against real repositories
(`BitbucketClient — rebase`). Never run live: it needs a genuinely conflicted
pull request, which is the same gap READ FIRST item 1 flags for the watcher's
conflict poll.

What it does, in order: clone the existing branch at full depth →
`rebaseOntoBase` → resolve each conflicted step with a model → `continueRebase`
→ run the suite on the finished branch → lane guard → force-push → `Code
Review`. No attempt is consumed anywhere in it.

Four decisions in it worth not re-deriving:

1. **The rebase is left in progress when it conflicts.** An earlier draft of
   `rebaseOntoBase` said to abort before returning `conflicts` so the tree is
   left clean. That is backwards: the conflicted tree *is* what the implementer
   has to resolve, and aborting discards it along with git's record of which
   commit was being replayed. The caller owns the in-progress state and must
   `continueRebase` or `abortRebase`; nothing leaks past the run because the
   workspace is a mkdtemp directory that dies with the task.
2. **What the model wrote is checked before git is asked to stage it.**
   `git add -A` believes whatever it is handed, so a file still full of
   `<<<<<<<` stages, commits and pushes, and the result looks like a successful
   rebase from every angle except reading the diff. `unresolvedPaths` also
   rejects a conflicted path the model never *touched*, which is the case a
   marker scan alone waves through — a binary conflict has no markers to find.
3. **A failing suite is pushed anyway, then the ticket is failed.** The opposite
   of the `initial` path, deliberately. There, discarding costs a branch that
   never existed anywhere else; here the resolution is real work on a branch a
   human is already looking at, and throwing it away means they redo the rebase
   by hand. The reviewer is still never handed a branch whose suite fails.
4. **The identity is set before the rebase, not just before a commit.** A rebase
   re-commits every replayed change under the committer identity, the images
   carry no global git config, and the failure git gives — "unable to
   auto-detect email address" — reads like a credential problem.

### What stranded KAN-6, and the shape to watch for

The conflict was noticed correctly and dispatched correctly. The implementer
then declined the work (`reason !== 'initial'`), returned `retryable: false`,
and **wrote nothing** — so the consumer deleted the message as terminal and the
ticket sat in `Implementing`, which `decide()` reads as "an agent owns this" and
idles on forever. No DLQ, because the message was deliberately deleted; no
alarm, because nothing failed; nothing on the card, because nothing was written.

The comment at the rejection claimed leaving it in `Implementing` was "visible
on the board rather than silently idle". It is not: `Implementing` is exactly
what a healthy running agent looks like. **Every dead end must write a status
the state machine can leave**, which is now what `failOnBoard` is for — and it
re-reads the lane first, so a failure report cannot stomp a ticket a human took
back mid-run.

### What the live run proved

- **The whole write path works.** Push, PR creation, remote link and transition
  all ran against live Bitbucket and live Jira on the first attempt.
- **The chain to the reviewer is closed.** After the run,
  `findPullRequestForIssue` returns PR #1 for KAN-6 and `buildWorkItem` produces
  a `ReviewWorkItem` that passes `isReviewWorkItem`. `dispatch_review` no longer
  bails — for an agent-authored PR. A human-authored one is still the open
  question in "Needs verifying".
- **The loop is cheap and terminates on its own.** 5 steps of a 30 budget,
  `finishReason: 'stop'`, ~26k in / 4.9k out, 117s wall clock including two full
  `npm ci`/build/test cycles. The model read `.cloud-harness.yml`, wrote four
  files, ran the suite itself, and stopped.
- **The model added a `package-lock.json` nobody asked for**, correctly — the
  manifest's setup command is `npm ci`, which fails without one. That is the
  same inference the refiner made about `package.json`, arrived at independently.

### KAN-8: the same slice, through the deployed stack, and the bug it found

KAN-8 ran the whole path in AWS — watcher dispatch, dispatcher Lambda, Fargate
implementer, PR #2 — with no local driver involved. Getting there turned up two
separate faults, and both are worth knowing.

**1. `agents-node` had never been pushed to ECR.** The repository existed and was
empty, so every implementer task died with `CannotPullContainerError` before the
container started. The message was therefore never *received*, which is why the
DLQ stayed empty and messages simply accumulated — a failure mode that looks
nothing like a crash from the queue's side. See the gotcha below; `agents-jvm` is
still empty and will do exactly the same thing.

**2. The verifier memoised setup *failure*, which poisoned the whole run.** This
one was mine and it is the more interesting of the two. `run_tests` cached the
result of `npm ci` so a slow setup was paid once per run rather than once per
call. Caching success is right. Caching failure is not, because of what a setup
failure usually means mid-loop: the model has written `package.json` and not yet
the lockfile, so `npm ci` fails on precisely the file it is about to add. The
cached error then replays on every later call, the model is told its fix changed
nothing, and a correct implementation is reported as a failing suite and thrown
away.

What makes it worth recording is how it presented. The model diagnosed it as
*"the harness appears to execute against the committed/HEAD snapshot of the
repo"* — a coherent, entirely wrong theory that would have sent anyone reading
the comment into the workspace and clone code. It was reading a ninety-second-old
cached string. KAN-6 had passed only because that run happened to write both
files before it first ran the tests.

Fixed by caching only success; `MAX_TEST_RUNS` already bounds the retries. The
test that pinned the old behaviour now pins the new one and names KAN-8.

### Two decisions in the implementer worth knowing before changing it

**A failing suite is not pushed.** No branch, no PR; the ticket goes to
`Agent Failed` with the failing command and output in a comment. The review
budget is three round trips and it exists for disagreements about a change, not
for code that does not run — the reviewer would execute the same command, reach
the same conclusion, and spend an attempt saying so. The cost is that the run's
work is discarded, which is the same call the refiner makes when it stands down.
The alternative considered and not taken: push the branch without a PR so a human
can salvage it. That breaks the invariant that a branch on the remote passed its
own suite, and it makes the next run's push a force-push.

**The post-loop verification is run again, by the harness.** The model's own last
`run_tests` is stale the moment it writes another file, and the loop's natural
last act is to fix what the run reported — so trusting it would mean reporting a
green suite for a tree that changed after it. Costs one extra test run per
implementation and makes `verification` true rather than usually true.

## Where the reviewer is

Built, and exercised against KAN-6's PR #1 up to the point where it would have
written. Six steps; five of them ran live.

| # | Step | State |
|---|---|---|
| 1 | Read the PR's diff and its existing comments | Done — live, before the clone |
| 2 | Clone the branch | Done — `prepareWorkspace`, full depth |
| 3 | Read the change, run the suite, record findings | Done — AI SDK tool loop, `review.ts` |
| 4 | Re-check the ticket is still ours | Done — the lane guard |
| 5 | Post one comment per finding, plus the summary | **Written, never run** |
| 6 | Approve and move to `Awaiting Merge`, or send back | **Written, never run** |

### What the no-write live run proved

Driven through the real `review()` against the real PR, stopped before
`handle.ts`'s write phase.

- **The read path is whole.** `dispatch_review` → `buildWorkItem` →
  `getPullRequestDiff` → `listPullRequestComments` → prompt, 6,369 characters,
  against live Bitbucket as the reviewer identity.
- **The loop is cheap and terminates on its own.** 5 steps of a 20 budget,
  `finishReason: 'stop'`, ~23k in / 1.2k out, 178s wall clock including two
  `npm ci`/build/test cycles.
- **The verdict came out `approved`** with `npm test` passing, one `minor`
  finding, and no blockers — which is the right answer for that pull request.
- **The authoritative re-run happened.** The suite ran twice: once because the
  model asked, once after the loop for the record. Same reason the implementer
  does it.

### The two things the run exposed, both prompt-level

- **The model reaches for the pull-request tier too readily.** Its one finding —
  four files missing a trailing newline — went in with no anchor at all. It is
  defensible for a claim that genuinely spans four files, but decision 9 is
  explicit that a reviewer which puts everything at PR level has fallen back to
  the single-thread shape the decision exists to prevent. Watch this on the next
  run before changing anything.
- **The model bundles, exactly as the refiner's `ask_human` did.** That one
  finding names four files and two distinct problems. The per-finding tool
  contract is right; the prompt does not yet insist on it. This is the same flaw
  in the same place twice, which makes it a prompt-writing lesson rather than a
  reviewer one.

### What has never run

**Nothing in the reviewer's write half.** Posting a finding, posting the summary,
approving, and both transitions are all unexercised. The single highest-value
next action is one live run of `handleReview` against KAN-6, which is the only
way `approvePullRequest` gets its answer — see "Two more Bitbucket identities
than the sandbox has", which predicts a refusal and which the code now treats as
an expected result rather than a fault.

## The repo now has code in it

`kwon-cloud/sandbox` was `.cloud-harness.yml` and nothing else for the whole of
the refiner's development, and this document used to caveat every refiner result
with it. That is retired: the KAN-6 PR adds `package.json`, `package-lock.json`,
`src/index.js` and `src/index.test.js` on `agent/kan-6-hello-world`.

It is still a very small repo. Once a PR is merged, the next refine pass is the
first one to read a repository with any structure at all — the step budget, the
prompt and `readPaths` have still never met a real codebase, and on a four-file
repo every story is still going to size as a 1 or a 3.

**KAN-6 and KAN-8 are the same ticket written twice**, and their PRs (#1 and #2)
both add `package.json`, a lockfile, an entry point and a test at the repo root.
They cannot both merge — whichever goes second conflicts on every file. Merge one
and decline the other before either is treated as a rebase problem.

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

## What landed in the implementer session

- **`services/agents/src/implementer/`** — `implement.ts` (prompt, tool loop,
  verifier), `edit-tools.ts` (`write_file` / `delete_file`), `handle.ts` (the
  write order and the lane guard), and `main.ts` reduced to a bootstrap. Same
  split as the refiner, for the same reason: the handler is importable without
  the SQS consume loop, which is what let the live run drive the real code path.
- **The read tools moved** from `refiner/repo-tools.ts` to
  `runtime/repo-tools.ts`. Both agents need list/read/search, and the implementer
  composes them with its own write tools rather than there being a write path in
  the read tools. `resolveWithin`, `describe` and `isSensitive` are now exported
  for that.
- **Four Bitbucket stubs are real**: `createBranch`, `commitAll`, `pushBranch`,
  `openPullRequest`. The class now carries a REST half as well as a git half,
  with the same Bearer-then-Basic scheme discovery the watcher's reader uses.
- **`JiraWriter.linkPullRequest` is real.** This is the one that unblocked the
  reviewer: `dispatch_review` returns undefined without a PR on the ticket.
- **Tests went 105 → 145.** The write tools' containment cases, `commitAll`
  against real git repositories, PR idempotency, and the auth fallback.

Two bugs the tests caught, both of which would have been silent in production:

- **The workspace root was not canonicalised** in the write tools, so on any host
  where the temp directory is a symlink (`/var` -> `/private/var`, i.e. every
  Mac) *every* write in the repository was refused as an escape attempt. The read
  tools document this exact trap; the write tools had to learn it separately.
- **`tsc --build` orphaned the moved test file** in `dist/`, which is the
  phantom-test gotcha below, hit again by a plain `git mv`.

## What landed in the refiner session

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
- **Review findings on the Jira ticket**, in any form — a structured comment, a
  rendered block, or prose the implementer parses back. Decision 9. They live in
  the pull request, one comment per finding, anchored at the code. Jira carries
  whose turn it is and nothing else.
- **A filter that hides an agent's own prior output from itself.** Decision 10,
  and the refiner already shipped this bug once as `getHumanComments`. Tag
  context, never drop it — including resolved PR threads.
- **`JiraWriter.publishReview`.** Deleted, not implemented. Decision 9.
- **An author-account check for pull request comment authorship.** Considered
  and rejected on evidence, not symmetry: the sandbox runs all three Bitbucket
  identities off one token, so every comment reports the same `account_id` and
  the check inverts exactly as it did in Jira. The signature in `comments.ts` is
  the signal on both sides.
- **Retry-and-degrade on a rejected inline comment.** There is no rejection —
  see READ FIRST item 0. The anchor is validated against the diff before the
  write, in `reviewer/diff.ts`. Do not add a catch that will never fire.

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
transition note and the watcher's own notes when those land.

**This is a Jira mechanism and does not automatically extend to the pull request
comments decision 9 introduces.** The signature exists because Jira has a single
pipeline identity that may also be a person's. Bitbucket does not have that
problem by design — the identities are split three ways precisely so the system
can tell its own branches from a human's — so the author account is a real signal
there, not an inverted one. It *is* inverted in the sandbox today, where one
token is all three identities; see "Two more Bitbucket identities than the sandbox
has". Decide the PR-side authorship signal on Bitbucket's own terms rather than
assuming this one carries over.

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

> **Decision 9 absorbed the mechanism half of this.** What follows was written as
> a consent scheme for human-authored PRs, and per-comment threading is now the
> general transport for *every* review finding, on every PR. That makes consent a
> property of a structure that already exists rather than a second mechanism to
> build, and this decision gets smaller. What stays here is the consent rule
> itself: who may be written to, and on whose say-so.

- **Consent is per review comment, not per PR.** That is what makes "fix these
  three, I'll handle the fourth" expressible, and partial fixes are the most
  valuable property here.
- **Granted by replying in-thread** on the specific comment. The human answers
  where the question was asked, and threading gives per-item consent for free. A
  single channel carrying N independent topics forces the reader to
  demultiplex — a PR with five review comments has that problem natively. This
  argument generalised: it is the reason decision 9 puts every finding on its own
  thread, not just the ones awaiting a human's answer.

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

Also, as this was written, all three agents were stubs and a fourth before one
worked end to end was speed in the wrong direction. Two of the three now run
live, so that argument has weakened — but the reviewer still has never run, and
it is what closes the loop. The ordering conclusion is unchanged.

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

### 9. Review findings live in Bitbucket, one comment per finding

**Jira tracks the status of the work. It does not carry the payload.** The
ticket's job is to tell the watcher that something needs the implementer's
attention. What that something *is* belongs in the pull request, next to the code
it is about.

This settles the question the previous session left open and **reverses the
answer that session was leaning toward**, which was to put the findings in the
Jira comment thread and have the implementer rehydrate from it the way the
refiner does. Same store as the refiner, same mechanism, pleasingly symmetric —
and wrong, because it moves the detail of a code change onto the board.

Two separate claims, both load-bearing.

**One comment per finding, anchored at the code.** Not one comment listing five
things. The reason is that every finding is a thread someone will reply to — the
implementer disagreeing, a human granting consent under decision 5 — and a single
comment carrying five findings forces every reply to say *which* of the five it
is about. That is the demultiplexing problem decision 5 already identified, and
the fix is the one decision 5 already named: put each topic on its own thread and
let threading do the pairing for free. Decision 5 scoped that to consent on
human-authored PRs. It is the general shape, and consent is one case of it.

**Anchoring has three tiers, and the reviewer takes the tightest one that is
true:**

- **Line** — `inline` at `path` and line. The default, and where most findings
  belong.
- **File** — `inline` at `path` with no line. The right shape for a claim about
  the file as a whole: *this file is now dead code, delete it.* Pinning that to
  an arbitrary line inside it would be a lie about where the problem is.
- **Pull request** — no anchor. For claims about the change as a whole, which is
  usually architecture. Should be rare; a reviewer that puts everything here has
  fallen back to the single-thread shape this decision exists to prevent.

The existing type already encodes this without a new field: `path` + `line` is
inline, `path` alone is file-level, neither is PR-level. **Verified against a
live PR** — `inline: {path, to}`, `inline: {path}`, and no `inline` do exactly
what this says, and a reply carries `parent: {id}` and inherits its parent's
anchor.

**An anchor that fails must degrade, never drop.** That rule stands. The
mechanism this paragraph originally gave for it does not, and the correction
matters more than the rule did:

> ~~Bitbucket rejects an inline comment on a line outside the diff... On
> rejection, fall back line → file → pull request.~~

**Bitbucket does not reject it.** `to: 9999` on a one-line file returns 201. So
does a path the pull request does not contain. The comment is created and
orphaned, `context_lines` comes back empty, and the list endpoint does not return
that field at all — so there is no rejection to catch and no way to notice
afterwards either. Waiting for a rejection would have meant every mis-aimed
finding was silently lost, which is the precise outcome this paragraph was
written to prevent.

So the check moved in front of the write. `reviewer/diff.ts` parses the pull
request's own three-dot diff into the set of addressable lines per file, and
`resolveAnchor` picks the tightest tier that actually exists. It runs when the
model **reports** the finding rather than when the caller posts it, which buys
something the post-time version could not: the model is told its line was not in
the diff while it is still in the loop and can aim again.

Two consequences worth keeping:

- **The addressable lines go in the prompt.** A model told up front which lines
  it may anchor to degrades fewer findings than one told afterwards.
- **Context lines are treated as addressable, not just added lines.** A finding
  about an unchanged line next to a change is legitimate. Only the added case is
  verified live; if orphaned comments ever appear on unchanged lines, narrow it.

#### What this settles and what it costs

**`reviewFeedback` comes off `ImplementWorkItem`** — see "What these decisions
delete". The findings never travel through the watcher at all, so there is
nothing to fill it with and nothing to parse anywhere. The watcher stays
content-blind, which is the property decision 1 bought and this preserves for
free.

There is a second reason beyond tidiness, and it is the stronger one. **A payload
on the work item is a snapshot taken at dispatch; comments read off the PR are
current at the moment the implementer runs.** Under decision 5 a human may reply
to a finding — granting consent, or arguing with it — between the dispatch and
the container starting. A snapshot is stale exactly when it matters most.

What it cost: **reading PR comments did not exist anywhere in this codebase.**
That gap is now closed on the agent side — `listPullRequestComments` returns the
thread structure, resolution state and signature-based authorship, paged; and
`commentOnPullRequest` takes one finding and an optional `parentId` to reply.
`BitbucketReader` still has no comment path, and would need one only if decision
5's comment-polling returns, which is still open.

**Authorship on the PR side is the signature, not the account** — and this
reverses the guess in decision 4's closing note, which reasoned that Bitbucket's
three-way identity split made the account a real signal there. It would be, in a
deployment that has three tokens. The sandbox has one, so every comment on PR #1
comes back as the same `account_id` and the same `display_name`, and an author
check inverts exactly the way it does in Jira. The signature works in both
deployments; the account check works in neither of the ones that exist. Same
mechanism as `comments.ts`, reused rather than reinvented.

Both signatures that were wrong are now right:

- ~~**`commentOnPullRequest(repo, id, feedback: ReviewFeedback)`**~~ — **DONE.**
  Takes one `PullRequestCommentDraft`, called once per finding.
- ~~**`ReviewFeedback.verification.output`** says "this rides in a Jira
  comment"~~ — **DONE.** It rides in a pull request comment, along with
  `summary`; those two are the genuinely PR-level pair.

~~**`JiraWriter.publishReview` mostly dissolves.**~~ **DONE — it dissolved
entirely and is deleted.** What was left for Jira is a transition and a one-line
pointer at the pull request, and `applyMutation` already did exactly that.

### 10. No agent assumes it is the first pass

The refiner already works this way and the reasoning was written down as if it
were a refiner concern. It is not. **It is an invariant for all three agents**,
and the implementer and reviewer both currently violate it — each is written as a
cold start.

The reviewer is the one that makes it urgent: it will look at PRs it has already
reviewed, and the implementer will sometimes disagree with it, and that exchange
loops. But the same is true of an implementer picking up `changes_requested` on a
branch carrying its own previous work, and it is already true of the refiner.

**Do not hide resolved context.** A resolved thread, a finding the implementer
pushed back on, a thread that was resolved and reopened — those are precisely
what stops the reviewer re-raising something already argued down. Re-raising it
is how the attempt budget gets burned on a disagreement neither side remembers
having.

**This is the same bug the refiner already shipped and fixed.** `getHumanComments`
filtered out the pipeline's own comments, and a second pass therefore received
the human's answers with the questions removed — "yes, use the existing one"
attached to nothing. The fix was to return everything **tagged** rather than to
drop half. Hiding resolved PR threads is that filter again, wearing different
clothes.

So: **tag, don't filter.** Thread state (`open` / `resolved`) travels as metadata
the way `author` already does on `TicketComment`. Having been arrived at
independently twice, it is worth stating as a rule rather than as two fixes.

#### Inject the history; do not trust the model to go and find it

The choice is between putting prior context in the prompt and giving the model a
tool to fetch it. **Inject** — and this codebase has already run the experiment.
From the refiner's live runs: three consecutive passes called `ask_human` zero
times. A working, well-described, genuinely needed tool that the model simply
declined to reach for until the prompt forced the issue. Relying on a model to
volunteer that it should go read its own history is betting on the exact behaviour
that has already failed here once.

The split that makes this cheap: **awareness must be deterministic, depth can be
lazy.** The threads go in the prompt — path, line, state, messages — so the model
cannot fail to know a prior pass happened and what was said. A tool can serve full
detail when a thread is long enough to be worth truncating.

Cost is not currently a concern and should be checked rather than assumed: the
refiner runs ~6.3k tokens in, the implementer ~26k, and a few rounds of PR
comments is noise against either. When it stops being noise, truncate oldest-first
— the same call the 20-comment Jira cap already makes, and for the same reason:
the oldest exchanges are the settled ones.

This is also what the refiner already does. `conversation` arrives *on the work
item*; it is not fetched.

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
- ~~**`reviewFeedback` on `ImplementWorkItem`**~~ — **DONE.** Deleted, and the
  type now carries a note saying why there is no such field, so it is not added
  back by someone reading `changes_requested` and looking for the payload. The
  implementer reads the PR's comments itself. `ReviewFeedback` itself stays — the
  reviewer still produces one, it just posts it rather than shipping it.
- ~~**`JiraWriter.publishReview`**~~ — **DONE.** Deleted rather than
  implemented; see decision 9.
- **A `needs_information` / `too_large` outcome variant.** Considered and
  rejected — decision 4. Both are the same board gesture as a success, and what
  distinguishes them belongs in the story a human reads, not in an enum nothing
  branches on.
- **Possibly `countAttempts` and `getStatusHistory`**, if the label counter
  (decision 7) fully replaces the changelog basis. Still open — decide
  deliberately rather than leaving two counters. Note `statuses.changesRequested`
  is untouched by the label deletion in decision 2; only the *label* went.

## Still open

- **What combination of conditions makes the watcher dispatch the implementer,
  now that the findings are not on the ticket.** **Resolved for the agent path,
  by building it:** the reviewer transitions the ticket into `Changes Requested`
  itself, and `decide()` firing on that status alone
  ([`pipeline.ts:342`](../packages/shared/src/pipeline.ts)) is exactly right —
  Jira carries "the implementer's attention is needed" and nothing else, which is
  decision 9's division of labour working as intended. Nothing was added to the
  watcher and nothing needed to be.

  What is still genuinely unresolved is the human-authored and consent case from
  decision 5, which is where "the watcher polls PR comments" came from. Work out
  whether that polling is needed at all before building it — and note the agent
  path now demonstrates that a status transition can carry the whole signal.
- **Early abort on the heartbeat.** The write guard is in — in *both* agents now
  — but it fires only at the end: a run whose ticket left the agent lane in
  minute one still burns the whole model call before discovering it.
  `ctx.onProgress()` already runs on a timer and `ctx.signal` already reaches
  `generateText`, so checking the lane there would abort early. Throttle it — the
  heartbeat fires after every tool call, and that is a Jira GET each time. This
  is worth more now than it was: an implementer run is minutes and several
  `npm ci` cycles, not one model call.
- **Nothing marks a ticket failed when an agent crashes.** A thrown handler
  leaves the SQS message for redelivery and eventually the DLQ, but the ticket
  stays in `Implementing` / `Refining`, where `decide()` idles it as "agent in
  flight" forever. The lane-guard and failing-suite paths both handle themselves;
  an unexpected throw does not. Cheapest fix is probably the watcher noticing a
  ticket that has been in flight far too long.
- **Two more Bitbucket identities than the sandbox has.** The implementer pushed
  and opened its PR as the shared sandbox token, which is also the read identity
  and the reviewer identity. Decision 5 and the approval rules both assume these
  are distinct. **Expect the first live `approvePullRequest` on KAN-6's PR #1 to
  be refused**, because Bitbucket does not accept an approval from a PR's own
  author. That is the sandbox's shape, not a bug in the reviewer.

  **Decided, so it is not debugged mid-flight:** treat the refusal as expected.
  `approvePullRequest` returns `{status: 'refused', reason}` on a 400 or 409
  rather than throwing, the reviewer's verdict stands regardless, and the summary
  comment says out loud that Bitbucket would not record the approval and why —
  because a PR sitting in `Awaiting Merge` with no approval on it otherwise looks
  like the reviewer forgot. Every other status still throws: a reviewer whose
  approval silently does not land is worse than one that stops.

  This is unverified. Nobody has called the endpoint, and it is the single
  cheapest thing the next live run settles. The confirmed half is that all three
  identities really are one account today — every comment on PR #1 comes back
  with the same `account_id`, which is also why PR authorship is read off the
  pipeline's signature rather than off the account.
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
4. **Does a real conflicted PR come back as `mergeable: false`?** The clean case
   is verified against PRs #1 and #2 and the conflicted response shape was read
   off a crossed revspec, but no PR has ever been conflicted here. Merging one of
   the two duplicate PRs makes the other one the fixture. See READ FIRST item 1.
5. **How to find a human-authored PR for a ticket.** Atlassian links branches,
   commits and PRs to an issue when the key appears in the name, message or
   title — that part is standard. The question is how to read it back. The
   `dev-status` endpoint is widely used but effectively internal and only works
   if the workspace is connected to the Jira site. Querying Bitbucket directly
   for open PRs matching the issue key is fully supported and needs no Jira
   configuration. Try both against a known key and take the robust one.

This matters because `dispatch_review` bails out entirely when `branch`,
`pullRequestUrl` and `pullRequestId` are missing
([`work-items.ts:104`](../services/watcher/src/work-items.ts)). For an
*agent-authored* PR this is now solved and verified: the implementer opens the
PR, `findPullRequestForIssue` matches it on the `agent/<issue-key>` branch
prefix, and a valid `ReviewWorkItem` comes out the other side. A human-authored
PR is on no such branch, so the lookup finds nothing and the watcher silently
does nothing. Decision 5's "apply the label at code review" still does not work
until this is solved.

## Suggested next step

**One live write run of the reviewer against KAN-6.** The reviewer is built and
its read half is verified live, but every line of its write half — posting a
finding, posting the summary, approving, and both transitions — has never
executed. That is the last unexercised code on the happy path of the whole
pipeline, and it is one run away.

What that run settles, none of which can be settled any other way:

1. **Whether `approvePullRequest` is refused**, which this document has predicted
   twice and never checked. The code now treats a 400 or 409 as an expected
   result rather than a fault, says so in the summary comment, and lets the
   verdict stand — so a refusal is no longer a mid-flight debugging session. If
   it is *not* refused, that is worth knowing too, because a reviewer that can
   approve its own implementer's PR makes the three-identity split look
   optional when it is not.
2. **Whether the transitions the workflow allows include `Reviewing` →
   `Awaiting Merge`.** `resolveStatusIds` only checks that statuses exist. The
   refiner's and implementer's transitions are proven; these two are not.
3. **Whether an anchored comment lands where the diff index says it will.** The
   anchoring is verified for a hand-written probe; it is not yet verified for a
   finding the model aimed itself.

The reviewer's own findings are the natural fixture for the next slice, because
completing that run leaves KAN-6 in `Awaiting Merge` and closes the loop. To get
the *interesting* half — a reviewer that sends work back — the cheapest route is
a ticket whose implementation genuinely fails its own suite, not a contrived
blocker.

### Then: the implementer's `changes_requested`

This is what the reviewer's write half unblocks, and it is now the only thing
between here and a machine-to-machine round trip. The work item carries no
findings by design (decision 9), so the implementer must do what the reviewer
already does — list the pull request's comments and read the threads, including
the resolved ones. `listPullRequestComments` and `describeThreads` are both
built and both reusable; `describeThreads` may want to move to `runtime/`
alongside the verifier and the read tools when the second consumer appears.

Two things settled during the reviewer's build that this inherits:

- **The reviewer does not manage the attempt counter, and nor should the
  implementer.** `countAttempts`
  ([`pipeline.ts:136`](../packages/shared/src/pipeline.ts)) derives it by
  counting entries into `Changes Requested` in Jira's changelog, which works no
  matter who moved the card. The reviewer's transition *is* the increment. This
  survives decision 2's "agents move their own cards" precisely because the
  count is derived rather than written; if decision 7 moves it to labels, that
  stops being true and the label swap has to ride on the watcher's dispatch.
- **`generateObject` was not used, and the reason generalises.** This list used
  to say the reviewer is "the first agent that needs structured output" and
  should be where `AgentModel.structuredOutputs` finally gets used. It was not,
  and the reasoning is worth keeping: a findings pass has to interleave with
  exploration — read the diff, look at the caller, run the suite, then say what
  is wrong — and a schema call is a single shot at the end that cannot use
  tools. It would have meant two model calls, the second re-deriving what the
  first already knew. `report_finding` is the same buffered-tool shape as the
  refiner's `ask_human`, which was already proven, and it is intent-shaped per
  decision 8. `structuredOutputs` remains unused by anything; the note on the
  field is still accurate and still worth reading before someone reaches for it.

Deploying is not on this path — Terraform has been applied once and the whole
pipeline ran in AWS, but everything since has been driven locally. Note the
reviewer runs on the stack images, so a deploy needs `agents-node` pushed; see
the ECR gotcha.

Not on the critical path, and fine to leave: the attempt counter moving to
labels (decision 7), the Atlassian tool shapes (decision 8), and the
implementer's `rebase` path.

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
  in `runtime/model.ts` — committed in `ec8dbbc`, not uncommitted as this line
  used to say — which implements both the openai-compatible and Bedrock
  providers. Mastra, the Claude Agent SDK, Vercel
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
  written to disk: `export JIRA_API_TOKEN="$ATLASSIAN_PAT"`. The same precedence
  bites the other way: exporting the variable *empty* silently beats the value in
  the file, and the failure reads as "missing required environment variable"
  pointing at a file that plainly contains it.
- **A missing stack image looks like "only the implementer is broken".** The
  refiner runs on `agents-base`; the implementer and reviewer run on
  `agents-<stack>`. So an unpushed stack image leaves refinement working
  perfectly and everything after it silently stalled, with an empty DLQ, because
  the container never starts and the SQS message is never received. Check
  `aws ecr list-images --repository-name cloud-harness-poc/agents-node` before
  believing anything else. `./scripts/build-and-push.sh agents-node` fixes it.

  **`destroy` deletes the ECR repositories and every image in them**
  (`disposable_deployment = true` forces it), so this is not a one-off mistake —
  it is the default state after every teardown. Run
  `./scripts/build-and-push.sh` with no arguments after an apply, which builds
  the watcher, the base and *every* configured stack. Pushing only `agents-node`
  leaves `agents-jvm` empty and the trap re-armed for the first jvm ticket.
- **`WORKSPACE_DIR` is read at module load**, not per call
  ([`workspace.ts:14`](../services/agents/src/runtime/workspace.ts)). Anything
  driving an agent handler directly has to set it *before* importing the handler,
  or the run dies on `mkdtemp '/workspace/...'`.
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

  **Deleting `dist/` is not enough to force a rebuild**, and the failure is
  confusing: `tsconfig.tsbuildinfo` still says everything is current, so `tsc
  --build` prints nothing, emits nothing, and every downstream package then fails
  with "Cannot find module '@cloud-harness/shared'" as though the workspace were
  broken. Delete both:

  ```
  find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
  ```

  Then build `packages/shared` first — the root `npm run build` does not order
  the workspaces, so a from-scratch build of everything at once fails on
  whichever service goes first.
- **Terraform has been applied and the whole pipeline ran in AWS.** 133
  resources; KAN-7 went To Do → Refining → Refinement Review with a 5,142-char
  story, driven by the deployed watcher, the SQS queue, the dispatcher Lambda
  and a Fargate refiner task. `stackSource: "manifest"` in the dispatch log is
  `readManifest` working against live Bitbucket. Queue drained, DLQ empty.
- **`npm ci` failed in the image build: `zod@4.4.3` was missing from
  `package-lock.json`.** Pre-existing drift — `packages/shared` and
  `services/agents` both declare zod and the lock was never regenerated. Local
  `npm test` passes regardless because `node_modules` already has it, so only
  `npm ci` in Docker catches it. Fixed with `npm install --package-lock-only`.
  **Retired:** the lockfile carrying `zod@4.4.3` is committed as of `4436386`,
  and the working tree is clean. The trap itself stands — a new dependency that
  only local `node_modules` satisfies still passes `npm test` and still fails the
  image build.
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
KAN-6   [To Do             ] labels=["agent"]  dispatch_refine   -> Refining
KAN-6   [Refinement Review ] labels=["agent"]  idle  awaiting human refinement review
KAN-6   [Code Review       ] labels=["agent"]  dispatch_review   -> Reviewing
```

Those are the three states the two working agents leave behind and the gate
between them. The last one is what the implementer produced and is where the
reviewer picks up — but the board moves, so query it.

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
