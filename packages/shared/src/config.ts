/**
 * Environment parsing. Every value here is supplied by the ECS task definitions
 * in infra/ecs.tf and infra/agents.tf — keep the two in sync.
 */

import type { PipelineConfig } from './pipeline.js';
import type { AgentKind } from './types.js';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

export function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  // Deliberately not treating anything else as false: a flag that silently
  // reads "yes" as off is worse than one that refuses to start.
  throw new Error(`Environment variable ${name} must be true or false, got: ${raw}`);
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export interface JiraConfig {
  baseUrl: string;
  projectKey: string;
  userEmail: string;
  apiToken: string;
}

export function loadJiraConfig(): JiraConfig {
  return {
    baseUrl: requireEnv('JIRA_BASE_URL').replace(/\/+$/, ''),
    projectKey: requireEnv('JIRA_PROJECT_KEY'),
    userEmail: requireEnv('JIRA_USER_EMAIL'),
    apiToken: requireEnv('JIRA_API_TOKEN'),
  };
}

/**
 * Status and label names must match the Jira board exactly. They are supplied
 * as env vars rather than hardcoded so the pipeline can be pointed at a board
 * whose workflow is already named something else.
 */
export function loadPipelineConfig(): PipelineConfig {
  return {
    statuses: {
      refining: requireEnv('STATUS_REFINING'),
      refinementReview: requireEnv('STATUS_REFINEMENT_REVIEW'),
      readyToImplement: requireEnv('STATUS_READY_TO_IMPLEMENT'),
      implementing: requireEnv('STATUS_IMPLEMENTING'),
      codeReview: requireEnv('STATUS_CODE_REVIEW'),
      reviewing: requireEnv('STATUS_REVIEWING'),
      changesRequested: requireEnv('STATUS_CHANGES_REQUESTED'),
      rebaseRequired: requireEnv('STATUS_REBASE_REQUIRED'),
      awaitingMerge: requireEnv('STATUS_AWAITING_MERGE'),
      done: requireEnv('STATUS_DONE'),
      failed: requireEnv('STATUS_FAILED'),
    },
    labels: {
      refine: requireEnv('LABEL_REFINE'),
      changesRequested: requireEnv('LABEL_CHANGES_REQUESTED'),
    },
    maxAttempts: intEnv('MAX_IMPLEMENTATION_ATTEMPTS', 3),
  };
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/**
 * agent -> stack -> queue URL.
 *
 * Agents that need a language runtime (implementer, reviewer) have one queue
 * per stack, because each queue feeds a task definition with a different image.
 * Agents that do not (refiner) have a single `default` entry.
 */
export type QueueUrls = Record<AgentKind, Record<string, string>>;

/**
 * Watcher only: it produces to every queue.
 *
 * Passed as one JSON blob rather than a flat env var per queue, because the set
 * is a product of agents and stacks and grows whenever a stack is added.
 */
export function loadQueueUrls(): QueueUrls {
  const raw = requireEnv('AGENT_QUEUE_URLS');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`AGENT_QUEUE_URLS is not valid JSON: ${(err as Error).message}`);
  }

  const urls = parsed as Partial<QueueUrls>;
  for (const agent of ['refiner', 'implementer', 'reviewer'] as const) {
    const entry = urls[agent];
    if (entry === undefined || Object.keys(entry).length === 0) {
      throw new Error(`AGENT_QUEUE_URLS is missing queues for agent: ${agent}`);
    }
  }

  return urls as QueueUrls;
}

/**
 * Per-stack fallback commands, for repos whose manifest omits them.
 *
 * Supplied by the task definition from the Terraform `stacks` variable, so the
 * conventional command for an ecosystem lives in one place rather than being
 * copied into every repo's manifest.
 */
export type StackDefaults = Record<
  string,
  { setupCommand?: string; buildCommand?: string; testCommand?: string; lintCommand?: string }
>;

export function loadStackDefaults(): StackDefaults {
  const raw = optionalEnv('STACK_DEFAULTS');
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw) as StackDefaults;
  } catch (err) {
    throw new Error(`STACK_DEFAULTS is not valid JSON: ${(err as Error).message}`);
  }
}

/** Stacks this deployment has images and queues for. */
export function loadKnownStacks(): string[] {
  return requireEnv('KNOWN_STACKS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Model access
// ---------------------------------------------------------------------------

export interface LlmConfig {
  provider: 'openai_compatible' | 'bedrock';
  /** Only set for openai_compatible. Includes the version path, e.g. .../v1 */
  baseUrl?: string;
  /** Only set for openai_compatible. Bedrock authenticates with the task role. */
  apiKey?: string;
  model: string;
  /** Forwarded only when the endpoint supports it. */
  reasoningEffort?: string;
  timeoutMs: number;
  /** Only meaningful for provider === 'bedrock'. */
  region?: string;
}

export function loadLlmConfig(): LlmConfig {
  const provider = requireEnv('LLM_PROVIDER');
  if (provider !== 'openai_compatible' && provider !== 'bedrock') {
    throw new Error(`LLM_PROVIDER must be openai_compatible or bedrock, got: ${provider}`);
  }

  const base: LlmConfig = {
    provider,
    model: requireEnv('LLM_MODEL'),
    timeoutMs: intEnv('LLM_REQUEST_TIMEOUT_SECONDS', 300) * 1000,
  };

  const reasoningEffort = optionalEnv('LLM_REASONING_EFFORT');
  if (reasoningEffort !== undefined) base.reasoningEffort = reasoningEffort;

  if (provider === 'openai_compatible') {
    return {
      ...base,
      baseUrl: requireEnv('LLM_BASE_URL').replace(/\/+$/, ''),
      apiKey: requireEnv('LLM_API_KEY'),
    };
  }

  return { ...base, region: requireEnv('BEDROCK_REGION') };
}

// ---------------------------------------------------------------------------
// Bitbucket
// ---------------------------------------------------------------------------

/**
 * Which Bitbucket identity a component acts as.
 *
 * The implementer and the reviewer must be separate service accounts in
 * production. Bitbucket does not count an approval from the pull request's own
 * author towards a minimum-approval merge check, so a shared identity produces
 * a reviewer whose approve call succeeds while the PR stays unmergeable — a
 * failure that looks exactly like success in the logs.
 *
 * Read-only components (the watcher polling PR state, the refiner reading the
 * repo for context) share one account, since neither writes anything.
 */
export type BitbucketRole = 'read' | 'implementer' | 'reviewer';

const BITBUCKET_TOKEN_ENV: Record<BitbucketRole, string> = {
  read: 'BITBUCKET_TOKEN',
  implementer: 'BITBUCKET_IMPLEMENTER_TOKEN',
  reviewer: 'BITBUCKET_REVIEWER_TOKEN',
};

export interface BitbucketConfig {
  workspace: string;
  defaultRepo: string;
  defaultBranch: string;
  /** The identity this token belongs to. Carried so errors can name it. */
  role: BitbucketRole;
  token: string;
  /**
   * Only for an Atlassian API token with Bitbucket scopes, which authenticates
   * as Basic email:token. A repository or workspace access token is a Bearer
   * credential with no associated user, and leaves this unset.
   */
  email?: string;
}

/**
 * Deliberately no fallback to BITBUCKET_TOKEN when a role's own variable is
 * missing. A fallback would make the sandbox one line shorter and would let a
 * production deployment silently collapse two service accounts into one, which
 * is the exact failure this split exists to prevent. Sandbox sets the same
 * value twice, on purpose and visibly.
 */
export function loadBitbucketConfig(role: BitbucketRole): BitbucketConfig {
  const config: BitbucketConfig = {
    workspace: requireEnv('BITBUCKET_WORKSPACE'),
    defaultRepo: requireEnv('BITBUCKET_DEFAULT_REPO'),
    defaultBranch: requireEnv('BITBUCKET_DEFAULT_BRANCH'),
    role,
    token: requireEnv(BITBUCKET_TOKEN_ENV[role]),
  };

  const email = optionalEnv('BITBUCKET_EMAIL');
  if (email !== undefined) config.email = email;

  return config;
}

/** The env var a role's token is read from. Used by preflight and diagnostics. */
export function bitbucketTokenEnv(role: BitbucketRole): string {
  return BITBUCKET_TOKEN_ENV[role];
}

/** The identity an agent kind acts as. Only the two writers get their own. */
export function bitbucketRoleFor(agent: AgentKind): BitbucketRole {
  switch (agent) {
    case 'implementer':
      return 'implementer';
    case 'reviewer':
      return 'reviewer';
    case 'refiner':
      return 'read';
  }
}
