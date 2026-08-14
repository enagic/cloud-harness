/**
 * Pre-deployment check against real credentials.
 *
 * Answers the questions that are painful to discover from CloudWatch after an
 * apply: does the token authenticate, does the board have the columns and the
 * four fields the state machine drives, can the bot actually be assigned, can
 * we reach the repo, does the model endpoint answer. Every check runs even if
 * an earlier one failed, because the useful output is the full list of what to
 * fix, not the first thing to break.
 *
 * Deliberately uses the same JiraClient the watcher runs, so a green result
 * says something about the deployed code path rather than about this script.
 *
 *   npm run preflight
 */

import {
  bitbucketTokenEnv,
  createChatModel,
  loadBitbucketConfig,
  loadJiraConfig,
  loadLlmConfig,
  loadPipelineConfig,
  optionalEnv,
  type BitbucketRole,
  type JiraConfig,
  type PipelineConfig,
} from '@cloud-harness/shared';

import { JiraClient } from './jira.js';

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return log;
  },
};

type Status = 'pass' | 'fail' | 'warn' | 'skip';

const results: Array<{ status: Status; name: string; detail: string }> = [];

const MARK: Record<Status, string> = { pass: '  ok  ', fail: ' FAIL ', warn: ' warn ', skip: ' skip ' };

function record(status: Status, name: string, detail: string): void {
  results.push({ status, name, detail });
  console.log(`[${MARK[status]}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : String(err);
}

/** Run a check without letting a throw stop the rest of the run. */
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record('pass', name, await fn());
  } catch (err) {
    record('fail', name, reason(err));
  }
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

async function jiraChecks(jiraConfig: JiraConfig, pipeline: PipelineConfig): Promise<void> {
  const auth = `Basic ${Buffer.from(`${jiraConfig.userEmail}:${jiraConfig.apiToken}`).toString('base64')}`;

  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${jiraConfig.baseUrl}${path}`, {
      headers: { authorization: auth, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} on ${path}: ${(await response.text()).slice(0, 200)}`);
    }
    return response.json();
  };

  await check('jira: authenticate', async () => {
    const me = (await get('/rest/api/3/myself')) as { displayName?: string; emailAddress?: string };
    return `${me.displayName ?? '<no name>'} <${me.emailAddress ?? 'hidden'}>`;
  });

  await check('jira: project reachable', async () => {
    const project = (await get(
      `/rest/api/3/project/${encodeURIComponent(jiraConfig.projectKey)}`,
    )) as { name?: string; id?: string };
    return `${jiraConfig.projectKey} "${project.name ?? '?'}" (id ${project.id ?? '?'})`;
  });

  // The big one. Every configured column must exist on the board by exact
  // name, and a mismatch is a ticket that silently never moves.
  try {
    const byIssueType = (await get(
      `/rest/api/3/project/${encodeURIComponent(jiraConfig.projectKey)}/statuses`,
    )) as Array<{ statuses?: Array<{ name: string }> }>;

    const present = new Set<string>();
    for (const issueType of byIssueType) {
      for (const status of issueType.statuses ?? []) present.add(status.name);
    }

    const configured = Object.entries(pipeline.statuses);
    const missing = configured.filter(([, name]) => !present.has(name));

    if (missing.length === 0) {
      record('pass', 'jira: pipeline statuses', `all ${configured.length} present`);
    } else {
      record(
        'fail',
        'jira: pipeline statuses',
        `${missing.length} of ${configured.length} missing — create these on the board:\n` +
          missing.map(([key, name]) => `           • "${name}"  (${key})`).join('\n') +
          `\n         board currently has: ${[...present].sort().join(', ') || '<none>'}`,
      );
    }
  } catch (err) {
    record('fail', 'jira: pipeline statuses', reason(err));
  }

  // The quieter half, and the more dangerous one. A mistyped custom field id is
  // not an error to Jira: it is simply absent from every response, so DOR reads
  // as unticked forever and tickets wait at a gate a human has already passed.
  await check('jira: pipeline fields', async () => {
    const client = new JiraClient(jiraConfig, pipeline, log);
    await client.verifyFields();
    return 'all four field ids exist';
  });

  // The bot account is what marks a ticket as being worked on, and being
  // ASSIGNABLE is a separate permission from being able to write — so the bot
  // can edit fields and transition issues perfectly well while silently failing
  // to be assigned, which is this project's favourite failure shape.
  await check('jira: bot account is assignable', async () => {
    const params = new URLSearchParams({
      project: jiraConfig.projectKey,
      accountId: pipeline.fields.botAccountId,
    });
    const assignable = (await get(
      `/rest/api/3/user/assignable/multiProjectSearch?${params.toString()}`,
    )) as Array<{ accountId?: string; displayName?: string }>;

    const match = assignable.find((user) => user.accountId === pipeline.fields.botAccountId);
    if (match === undefined) {
      throw new Error(
        `${pipeline.fields.botAccountId} cannot be assigned issues in ${jiraConfig.projectKey}. ` +
          'Assignable User is a separate permission from write access — ask whoever owns the ' +
          'project permission scheme to grant it, or the in-flight marker will never stick.',
      );
    }
    return `${match.displayName ?? '<no name>'} can be assigned in ${jiraConfig.projectKey}`;
  });

  await check('jira: JQL search + snapshot mapping', async () => {
    const client = new JiraClient(jiraConfig, pipeline, log);
    const tickets = await client.listPipelineTickets();
    if (tickets.length === 0) {
      return 'query valid, 0 tickets in scope (add the kickoff label to one to test dispatch)';
    }
    const sample = tickets[0]!;
    return `${tickets.length} ticket(s); e.g. ${sample.issueKey} [${sample.status}] "${sample.summary.slice(0, 40)}"`;
  });

  // Both halves of it. The DOR half is the newer and the less certain: the
  // attempt budget resets on a multicheckbox change, and whether Jira records
  // one usably is the sort of thing this project has been wrong about before.
  await check('jira: changelog readable', async () => {
    const client = new JiraClient(jiraConfig, pipeline, log);
    const tickets = await client.listPipelineTickets();
    const sample = tickets[0];
    if (sample === undefined) return 'skipped — no ticket in scope to read history from';
    const history = await client.getIssueHistory(sample.issueKey);
    return (
      `${sample.issueKey}: ${history.transitions.length} status transition(s), ` +
      `${history.dorGrantedAt.length} DOR grant(s)`
    );
  });

  // ADF is the format the description actually arrives in; a silent failure
  // here means agents get empty specs.
  await check('jira: description decodes from ADF', async () => {
    const client = new JiraClient(jiraConfig, pipeline, log);
    const tickets = await client.listPipelineTickets();
    const withBody = tickets.find((t) => t.description.length > 0);
    if (withBody === undefined) {
      return 'no ticket in scope has a description yet — untested';
    }
    return `${withBody.issueKey}: ${withBody.description.length} chars decoded`;
  });
}

// ---------------------------------------------------------------------------
// Bitbucket
// ---------------------------------------------------------------------------

async function bitbucketChecks(): Promise<void> {
  let config;
  try {
    config = loadBitbucketConfig('read');
  } catch (err) {
    record('skip', 'bitbucket', reason(err));
    return;
  }

  const { workspace, defaultRepo, defaultBranch, token } = config;
  const base = `https://api.bitbucket.org/2.0/repositories/${workspace}/${defaultRepo}`;

  // Two credential types are current, and they authenticate differently:
  //   - a repository/workspace access token -> Bearer
  //   - an Atlassian API token with Bitbucket scopes -> Basic email:token
  // App passwords (the third historical option) were removed in July 2026.
  // Try Bearer first, then Basic if an email is configured to pair with.
  const email = optionalEnv('BITBUCKET_EMAIL');
  const attempt = async (path: string): Promise<Response> => {
    const bearer = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (bearer.status !== 401 || email === undefined) return bearer;
    return fetch(`${base}${path}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
  };

  await check('bitbucket: repo reachable', async () => {
    const response = await attempt('');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const repo = (await response.json()) as { full_name?: string; mainbranch?: { name?: string } };
    const actualDefault = repo.mainbranch?.name;
    const note =
      actualDefault && actualDefault !== defaultBranch
        ? ` (WARNING: repo default is "${actualDefault}", config says "${defaultBranch}")`
        : '';
    return `${repo.full_name ?? `${workspace}/${defaultRepo}`}${note}`;
  });

  await check('bitbucket: can list pull requests', async () => {
    const response = await attempt('/pullrequests?state=OPEN&pagelen=1');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const page = (await response.json()) as { size?: number };
    return `${page.size ?? 0} open PR(s)`;
  });

  // Not an error when absent — the configured default stack covers it.
  const manifest = await attempt(`/src/${encodeURIComponent(defaultBranch)}/.cloud-harness.yml`);
  if (manifest.ok) {
    record('pass', 'bitbucket: .cloud-harness.yml', `found on ${defaultBranch}`);
  } else if (manifest.status === 404) {
    record(
      'warn',
      'bitbucket: .cloud-harness.yml',
      `absent — repo will fall back to DEFAULT_STACK (${optionalEnv('DEFAULT_STACK') ?? 'unset!'})`,
    );
  } else {
    record('fail', 'bitbucket: .cloud-harness.yml', `HTTP ${manifest.status}`);
  }

  await identityChecks(workspace, defaultRepo, email);
}

/**
 * Each write identity must authenticate, and in production they must be
 * different accounts.
 *
 * Comparing the token values catches the mistake that actually happens: a
 * sandbox where one token was pasted into all three slots, promoted to an
 * environment with a minimum-approval merge check. There the reviewer's approve
 * call returns 200, the approval does not count, and the ticket sits in
 * Awaiting Merge with nothing in the logs to explain it.
 */
async function identityChecks(
  workspace: string,
  repo: string,
  email: string | undefined,
): Promise<void> {
  const roles: BitbucketRole[] = ['read', 'implementer', 'reviewer'];
  const tokens = new Map<BitbucketRole, string>();

  for (const role of roles) {
    try {
      tokens.set(role, loadBitbucketConfig(role).token);
    } catch (err) {
      record('fail', `bitbucket: ${role} identity`, reason(err));
    }
  }

  // Authenticate each one against the repo it will actually be used on.
  for (const [role, token] of tokens) {
    const url = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo}`;
    let response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 && email !== undefined) {
      response = await fetch(url, {
        headers: {
          authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });
    }
    if (response.ok) {
      record('pass', `bitbucket: ${role} token authenticates`, bitbucketTokenEnv(role));
    } else {
      record(
        'fail',
        `bitbucket: ${role} token authenticates`,
        `HTTP ${response.status} using ${bitbucketTokenEnv(role)}`,
      );
    }
  }

  const implementer = tokens.get('implementer');
  const reviewer = tokens.get('reviewer');
  if (implementer !== undefined && reviewer !== undefined) {
    if (implementer === reviewer) {
      record(
        'warn',
        'bitbucket: implementer and reviewer are distinct',
        'same token in both — fine for a sandbox, but in production the reviewer ' +
          "approves as the PR's own author and the approval will NOT count " +
          'towards a minimum-approval merge check',
      );
    } else {
      record('pass', 'bitbucket: implementer and reviewer are distinct', 'separate credentials');
    }
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

async function llmChecks(): Promise<void> {
  let config;
  try {
    config = loadLlmConfig();
  } catch (err) {
    record('skip', 'llm', reason(err));
    return;
  }

  await check('llm: endpoint answers', async () => {
    const model = createChatModel(config);
    // Generous on purpose. A reasoning model bills hidden thinking against the
    // same budget as the answer, so a tight cap here fails with an empty
    // completion and looks like a broken endpoint rather than a small number.
    const response = await model.complete({
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 1024,
    });

    const reasoning = response.usage?.reasoningTokens;
    const note =
      reasoning === undefined
        ? ''
        : ` [reasoning model: ${reasoning} reasoning tokens — agent prompts must budget for this]`;

    return `${config.provider}/${response.model ?? config.model}: "${response.content.trim().slice(0, 40)}"${note}`;
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('cloud-harness preflight\n');

  let jiraConfig: JiraConfig | undefined;
  let pipeline: PipelineConfig | undefined;
  try {
    jiraConfig = loadJiraConfig();
    pipeline = loadPipelineConfig();
    record('pass', 'config: jira + pipeline env', `${jiraConfig.baseUrl} project ${jiraConfig.projectKey}`);
  } catch (err) {
    record('fail', 'config: jira + pipeline env', reason(err));
  }

  if (jiraConfig && pipeline) {
    await jiraChecks(jiraConfig, pipeline);
  } else {
    record('skip', 'jira', 'config incomplete');
  }

  await bitbucketChecks();
  await llmChecks();

  const failed = results.filter((r) => r.status === 'fail');
  const warned = results.filter((r) => r.status === 'warn');

  console.log(
    `\n${results.length} checks — ${results.length - failed.length - warned.length} ok, ` +
      `${warned.length} warning(s), ${failed.length} failure(s)`,
  );

  if (failed.length > 0) {
    console.log('\nFix these before deploying:');
    for (const f of failed) console.log(`  • ${f.name}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('preflight crashed:', err);
  process.exit(1);
});
