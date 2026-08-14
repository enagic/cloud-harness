/**
 * Watcher — always-on ECS service, 0.25 vCPU / 512 MB.
 *
 * The only long-running component, and the only thing that talks to Jira on a
 * schedule. Each tick it:
 *
 *   1. Rehydrates each ticket's derived state — the pull request and its
 *      conflict state from Bitbucket, the attempt budget from the Jira
 *      changelog. Neither is stored in a mutable field, so a hand-edited ticket
 *      cannot grant extra attempts or claim a branch merges cleanly.
 *   2. Reconciles the two things that end a ticket — a human's merge and a
 *      declined pull request. Both have no Jira-side signal, so they can only
 *      be discovered by asking Bitbucket.
 *   3. Runs the state machine and dispatches to whichever agent queue the
 *      decision names.
 *
 * Most dispatches no longer move the card. The stage lives in the column and
 * the rest of the state lives on Assignee, Code Reviewer and DOR, so taking a
 * ticket is usually a field write rather than a transition — see
 * @cloud-harness/shared/pipeline.
 *
 * It holds no workflow logic of its own — that lives in
 * @cloud-harness/shared/pipeline, which is pure and tested. This file is I/O
 * and sequencing.
 *
 * STATUS: all three steps are real, as is everything they read — the Jira
 * client, and the Bitbucket manifest read, PR lookup and PR poll. No stub is
 * left on the tick.
 */

import {
  countAttempts,
  createLogger,
  decide,
  intEnv,
  loadBitbucketConfig,
  loadJiraConfig,
  loadKnownStacks,
  loadPipelineConfig,
  loadQueueUrls,
  loadStackDefaults,
  needsHistory,
  reconcilePullRequest,
  requireEnv,
  type PipelineConfig,
  type PullRequestState,
  type RepositoryRef,
  type StatusIds,
  type TicketSnapshot,
} from '@cloud-harness/shared';

import { BitbucketReader } from './bitbucket.js';
import { recordHeartbeat } from './health.js';
import { JiraClient } from './jira.js';
import { WorkQueues } from './queues.js';
import { resolveRuntime, type RuntimeResolverOptions } from './runtime.js';
import { buildWorkItem } from './work-items.js';

const log = createLogger({ service: 'watcher' });

interface Deps {
  jira: JiraClient;
  bitbucket: BitbucketReader;
  queues: WorkQueues;
  config: PipelineConfig;
  statusIds: StatusIds;
  repository: RepositoryRef;
  runtimeOptions: RuntimeResolverOptions;
}

/**
 * Fill in the parts of a snapshot that are derived rather than stored.
 *
 * The attempt budget comes from the changelog, which users cannot rewrite, and
 * everything about the pull request comes from Bitbucket — found by branch
 * convention, then re-read for its real state. Neither is trusted from a
 * mutable Jira field, so a hand-edited ticket cannot grant an agent extra
 * attempts, hide a pull request, or claim one merges cleanly when it does not.
 *
 * Order matters here: the pull request is looked up first because whether the
 * changelog is worth fetching now depends on whether one exists.
 *
 * The fetched PR is returned alongside so reconcile() does not fetch it again.
 * `decide()` needs its mergeability and reconcile() needs its state, and that
 * used to be two calls per ticket per tick for the same object.
 */
async function rehydrate(
  ticket: TicketSnapshot,
  deps: Deps,
): Promise<{ ticket: TicketSnapshot; pr?: PullRequestState }> {
  const hydrated: TicketSnapshot = { ...ticket };

  const found = await deps.bitbucket.findPullRequestForIssue(deps.repository, ticket.issueKey);
  let pr: PullRequestState | undefined;

  if (found !== undefined) {
    hydrated.pullRequestUrl = found.url;
    hydrated.pullRequestId = found.id;
    hydrated.branch = found.branch;

    // The lookup does not report conflict state — see findPullRequestForIssue,
    // which fills `mergeable: true` as a placeholder nothing may read. This is
    // the call that answers it, and it answers `undefined` for everything it
    // cannot be sure of.
    pr = await deps.bitbucket.getPullRequest(deps.repository, found.id);
    if (pr !== undefined) hydrated.pullRequestMergeable = pr.mergeable;
  }

  if (needsHistory(hydrated, deps.config)) {
    const history = await deps.jira.getIssueHistory(ticket.issueKey);
    hydrated.attempts = countAttempts(history, deps.statusIds);
  }

  return pr === undefined ? { ticket: hydrated } : { ticket: hydrated, pr };
}

/**
 * Apply any PR-driven status change. Returns true if the ticket was mutated, in
 * which case the caller skips the state machine this tick — the snapshot is now
 * stale, and the next tick acts on the new status.
 *
 * Only a merge and a decline reach here now. A conflict used to as well, as a
 * transition into a `Rebase Required` status; it travels on the snapshot
 * instead, so the rebase happens without the ticket leaving Code Review.
 */
async function reconcile(
  ticket: TicketSnapshot,
  pr: PullRequestState | undefined,
  deps: Deps,
): Promise<boolean> {
  if (pr === undefined) return false;

  const mutation = reconcilePullRequest(ticket, pr, deps.config);
  if (mutation === undefined) return false;

  await deps.jira.applyMutation(ticket.issueKey, mutation);
  log.info('reconciled pull request', {
    issueKey: ticket.issueKey,
    prState: pr.state,
    mergeable: pr.mergeable,
    newStatus: mutation.status,
  });
  return true;
}

async function tick(deps: Deps): Promise<void> {
  const tickets = await deps.jira.listPipelineTickets();
  log.info('polled board', { tickets: tickets.length });

  for (const raw of tickets) {
    const ticketLog = log.child({ issueKey: raw.issueKey });

    try {
      const { ticket, pr } = await rehydrate(raw, deps);

      if (await reconcile(ticket, pr, deps)) continue;

      const action = decide(ticket, deps.config);

      if (action.kind === 'idle') {
        ticketLog.debug('no action', { status: ticket.status, reason: action.reason });
        continue;
      }

      if (action.kind === 'fail' || action.kind === 'complete') {
        await deps.jira.applyMutation(ticket.issueKey, action.mutation);
        ticketLog.warn('pipeline stopped for ticket', {
          kind: action.kind,
          attempts: ticket.attempts,
          reason: action.kind === 'fail' ? action.reason : 'complete',
        });
        continue;
      }

      // Resolve the runtime before building the item: the stack selects the
      // queue, and the queue selects the image the agent runs in. A repo whose
      // manifest names a stack this deployment cannot run must fail here with a
      // message on the board, not by dispatching into a queue that does not
      // exist or, worse, running a Java build in a Node image.
      const runtime = await resolveRuntime(
        deps.repository,
        deps.bitbucket,
        deps.runtimeOptions,
        ticketLog,
      );
      if (!runtime.ok) {
        await deps.jira.applyMutation(ticket.issueKey, {
          status: deps.config.statuses.blocked,
          comment: `Cannot determine how to build this repository: ${runtime.error}`,
        });
        ticketLog.error('runtime resolution failed', { error: runtime.error });
        continue;
      }

      const item = buildWorkItem(action, {
        ticket,
        repository: deps.repository,
        runtime: runtime.runtime,
        maxAttempts: deps.config.maxAttempts,
      });
      if (item === undefined) {
        ticketLog.error('cannot build work item; leaving ticket for human triage', {
          action: action.kind,
          status: ticket.status,
        });
        continue;
      }

      await deps.queues.send(item);

      // Only after a successful send. Crashing between send and mutation means
      // a duplicate dispatch next tick, which every agent must tolerate;
      // mutating first would risk dropping the ticket entirely.
      await deps.jira.applyMutation(ticket.issueKey, action.mutation);

      ticketLog.info('dispatched', {
        agent: item.agent,
        stack: item.runtime.stack,
        stackSource: runtime.source,
        // `to` is absent whenever the stage does not change column, which is
        // most of them now — a rebase and a send-back both dispatch without
        // moving the card, and the marker below is what actually changed.
        from: ticket.status,
        to: action.mutation.status ?? ticket.status,
        marker: action.mutation.codeReviewer !== undefined ? 'codeReviewer' : 'assignee',
        reason: action.kind === 'dispatch_implement' ? action.reason : undefined,
        attempts: ticket.attempts,
      });
    } catch (err) {
      // One bad ticket must not stall the rest of the board. The ticket keeps
      // its status, so the next tick retries it.
      ticketLog.error('ticket processing failed', { err, status: raw.status });
    }
  }
}

async function main(): Promise<void> {
  const jiraConfig = loadJiraConfig();
  // Read-only identity: the watcher polls PR state and fetches manifests, and
  // must never be able to push or approve.
  const bitbucketConfig = loadBitbucketConfig('read');
  const config = loadPipelineConfig();
  const pollIntervalMs = intEnv('POLL_INTERVAL_SECONDS', 60) * 1000;

  const jira = new JiraClient(jiraConfig, config, log);
  const bitbucket = new BitbucketReader(bitbucketConfig, log);
  const queues = new WorkQueues(loadQueueUrls(), log);

  // TODO: multi-repo. Work items carry a repository ref per ticket, but until
  // tickets declare a repo this comes from configuration.
  const repository: RepositoryRef = {
    workspace: bitbucketConfig.workspace,
    slug: bitbucketConfig.defaultRepo,
    baseBranch: bitbucketConfig.defaultBranch,
  };

  const knownStacks = loadKnownStacks();
  const runtimeOptions: RuntimeResolverOptions = {
    knownStacks,
    defaultStack: requireEnv('DEFAULT_STACK'),
    stackDefaults: loadStackDefaults(),
  };

  // Resolved once, at startup. Both fail fast and loudly if the board is
  // missing a configured status or field, rather than one ticket at a time in
  // production — and a mistyped field id is the quieter of the two failures,
  // because Jira simply omits an unknown field rather than complaining.
  const statusIds = await jira.resolveStatusIds();
  await jira.verifyFields();

  const deps: Deps = { jira, bitbucket, queues, config, statusIds, repository, runtimeOptions };

  log.info('watcher starting', {
    project: jiraConfig.projectKey,
    pollIntervalMs,
    maxAttempts: config.maxAttempts,
    repository: `${repository.workspace}/${repository.slug}`,
    knownStacks,
    defaultStack: runtimeOptions.defaultStack,
  });

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info('shutdown signal received, finishing current tick', { signal });
      stopping = true;
    });
  }

  recordHeartbeat();

  while (!stopping) {
    const startedAt = Date.now();
    try {
      await tick(deps);
      recordHeartbeat();
    } catch (err) {
      // Never let one bad tick kill the service. The health check catches a
      // watcher that stops making progress entirely.
      log.error('poll cycle failed', { err });
    }

    const sleepMs = Math.max(0, pollIntervalMs - (Date.now() - startedAt));
    if (!stopping && sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  log.info('watcher stopped');
}

main().catch((err: unknown) => {
  log.error('fatal', { err });
  process.exit(1);
});
