# Handoff — 2026-08-10

Where the POC stands after wiring it to a live Atlassian sandbox, and what the
next session should pick up. Delete this file once the work it describes lands.

## What changed this session

All external dependencies are now verified against real credentials. `npm test`
is 54/54 and `npm run preflight` is 13 ok / 2 expected warnings / 0 failures.

| Area | State |
|---|---|
| `packages/shared/src/adf.ts` | **New.** Jira v3 ADF ↔ text. 11 tests |
| `packages/shared/src/llm.test.ts` | **New.** 7 tests over the OpenAI-compatible client |
| `services/watcher/src/jira.ts` | **Implemented.** Full read path + `applyMutation` |
| `services/watcher/src/preflight.ts` | **New.** Pre-deploy check against live credentials |
| Bitbucket per-identity credentials | **Implemented** in config, Terraform, and `put-secrets.sh` |
| `.env.example` | **New.** Template for `.env.local` |

### Why ADF exists

Jira REST v3 returns issue descriptions as an Atlassian Document Format tree and
accepts comments only as one, but `TicketSnapshot.description` is a `string`.
Without conversion at the client boundary, every agent would have received an
empty spec. The round-trip test that matters is the fenced-code-block one — that
is the carrier for the refined-story contract, so it must survive byte-identical.

### Two bugs fixed

1. **`llm.ts` guarded `content === undefined`**, but an empty completion returns
   `null`. The null escaped and failed later on `.trim()`, several frames from
   the cause. Now a nullish check with a diagnostic message naming the reason.
2. **Preflight asked for `maxTokens: 16`** against a reasoning model, which spent
   all 16 on hidden thinking. Raised to 1024. `ChatResponse.usage.reasoningTokens`
   now surfaces the cost.

### Interface changes to be aware of

- `JiraClient` takes `PipelineConfig` in its constructor — it cannot validate
  status names or build the JQL filter without them.
- `loadBitbucketConfig(role)` now **requires** a role of `read | implementer |
  reviewer`. There is deliberately no fallback between the three env vars; see
  the reasoning in the README's *Bitbucket identities* section.
- Terraform creates three Bitbucket secrets instead of one. `terraform validate`
  passes. **Nothing has been applied — no AWS resources exist yet.**

## Decisions already made

- **Bitbucket identities are split three ways** (read / implementer / reviewer),
  because Bitbucket does not count an approval from a PR's own author towards a
  minimum-approval merge check. Production uses separate service accounts;
  sandbox writes one token to all three via
  `./scripts/put-secrets.sh --shared-bitbucket`.
- **Model-agnosticism is a hard requirement.** The Claude ecosystem is off the
  table in production. The `ChatModel` seam is load-bearing.
- **DeepSeek via OpenRouter is a sandbox cost choice**, not a production model
  decision.

## Open decisions — settle these before writing agent bodies

### 1. Agent framework (blocking)

The user does not want to hand-roll the tool loop. Evaluated but **not
confirmed**. Standing recommendation: **the Vercel AI SDK**.

Mastra is *built on* the AI SDK — it uses its model routing, structured output
and tool calling underneath. So the choice is not Mastra or AI SDK; it is AI SDK
alone versus AI SDK plus Mastra's orchestration layer.

- **Vercel AI SDK** — recommended. Supplies the only thing actually missing: the
  tool loop *inside* one agent invocation (`ToolLoopAgent`,
  `stopWhen: stepCountIs(n)`). It also replaces `packages/shared/src/llm.ts`
  outright — the hand-rolled OpenAI-compatible client goes away and the
  never-implemented `BedrockChatModel` comes free, along with 25+ other
  providers. Deployment-neutral npm library. **Pin the major version**; it moves
  fast.
- **Mastra** — set aside. Workflow orchestration, durable execution, agent memory
  and observability all duplicate what this system already has in SQS, ECS and
  the tested state machine. Its memory layer runs against the project's core
  principle that the pipeline stores no workflow state of its own. Adopting it
  would mean two competing models of who owns control flow.
- **Claude Agent SDK** — ruled out. Best functional match, but Claude-only.
- **Vercel Eve** — ruled out; its durable runtime is Vercel-bound. This does
  **not** apply to the AI SDK, which is a plain library.
- **Strands (TypeScript)** — deferred. Bedrock-aligned, but the TS SDK was still
  experimental with expected breaking changes.
- **LangChain / LangGraph.js** — heavier than needed, wins nothing here.

Not a one-way door: Mastra's `withMastra()` wraps an AI SDK model, so its
features can be added later without a rewrite.

### 2. Refined-story format (README decision #3, still open)

The refiner writes a story into Jira; the implementer and reviewer need it back
structured. `parseRefinedStory` in `services/watcher/src/work-items.ts` still
returns the raw description with empty `acceptanceCriteria` and `relevantPaths`.

Recommended shape: a fenced JSON block under a known heading. The ADF round-trip
test already proves this survives Jira intact.

## Suggested next step

The user chose a **refiner-only vertical slice** — one agent working end to end
on a real ticket before touching the other two.

Worth knowing: the refiner is the agent a framework helps *least*. Its job is
read repo files → one structured output → write to Jira. No multi-step editing.
The framework earns its keep on the implementer. The only place the choice
touches the refiner is whether it picks files to read via tool calls or via a
heuristic.

Framework-neutral work needed under every option: the refined-story format,
`JiraWriter`, and the read-only parts of `BitbucketReader`.

## Gotchas

- **`source .env.local` fails in zsh.** Values contain spaces (`Refinement
  Review`) and are unquoted. Use `node --env-file=.env.local`.
- **Shell env beats `--env-file`**, so the Atlassian token never needs to be
  written to disk: `export JIRA_API_TOKEN="$ATLASSIAN_PAT"`.
- **A ticket in `Refining` / `Implementing` / `Reviewing` is treated as
  in-flight** and idles forever. That status is the watcher's own receipt, not a
  request. Kickoff is the `agent-refine` label on a draft ticket. KAN-4 and
  KAN-5 were stuck this way; KAN-6 is now correctly staged as `To Do` +
  `agent-refine`.
- **Workflow transitions are unverified.** `resolveStatusIds` only checks that
  statuses *exist*. The user confirmed no transition restrictions were
  configured, but nothing has actually moved a ticket yet.
- **`terraform fmt`** flags pre-existing issues in `locals.tf` and
  `variables.tf`, unrelated to this session's edits.

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
