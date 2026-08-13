/**
 * The parts of a review that do not need a model: what the reviewer is told,
 * what happens to a finding it aims badly, and how a verdict is reached.
 *
 * The verdict tests are the load-bearing ones. Severity is the model's call and
 * the outcome is not — the thing that spends one of a small number of attempts
 * should be arithmetic over what the model said, not a second judgement by it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Tool } from 'ai';

import {
  WORK_ITEM_SCHEMA_VERSION,
  type PullRequestComment,
  type ReviewWorkItem,
} from '@cloud-harness/shared';

import { parseDiff } from './diff.js';
import {
  createFindingTools,
  describeThreads,
  reviewPrompt,
  verdict,
  type RecordedFinding,
  type Severity,
} from './review.js';

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const DIFF = [
  'diff --git a/src/index.js b/src/index.js',
  '--- a/src/index.js',
  '+++ b/src/index.js',
  '@@ -1,2 +1,3 @@',
  " console.log('hello');",
  '+const x = 1;',
  ' export default 1;',
  '',
].join('\n');

function workItem(overrides: Partial<ReviewWorkItem> = {}): ReviewWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    agent: 'reviewer',
    issueKey: 'KAN-6',
    issueId: '10005',
    title: 'Hello World',
    repository: { workspace: 'acme', slug: 'widgets', baseBranch: 'main' },
    runtime: { stack: 'node', manifest: { stack: 'node', testCommand: 'npm test' } },
    dispatchedAt: '2026-08-13T09:00:00.000Z',
    refinedDescription: '## Summary\n\nPrint hello to stdout.',
    branch: 'agent/kan-6-hello-world',
    pullRequestUrl: 'https://bitbucket.org/acme/widgets/pull-requests/1',
    pullRequestId: 1,
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

function finding(severity: Severity): RecordedFinding {
  return { severity, message: 'x', anchor: { tier: 'pull_request' } };
}

describe('createFindingTools', () => {
  const build = () =>
    createFindingTools({ log: silent, files: parseDiff(DIFF) });

  const report = async (
    tools: ReturnType<typeof build>,
    input: Record<string, unknown>,
  ): Promise<string> => {
    const target = tools.tools['report_finding'] as Tool | undefined;
    assert.ok(target?.execute, 'report_finding has no execute');
    return (await target.execute(input as never, {
      toolCallId: 'test',
      messages: [],
    } as never)) as string;
  };

  it('records a finding at the line it was aimed at', async () => {
    const tools = build();

    const response = await report(tools, {
      severity: 'major',
      path: 'src/index.js',
      line: 2,
      message: 'x is unused.',
    });

    assert.match(response, /Recorded finding 1 of at most 15, on src\/index\.js:2/);
    assert.deepEqual(tools.findings(), [
      {
        severity: 'major',
        message: 'x is unused.',
        anchor: { tier: 'line', path: 'src/index.js', line: 2 },
      },
    ]);
  });

  /**
   * The case Bitbucket will not catch. A comment on a line outside the diff is
   * accepted with 201 and attached to nothing, so the degradation happens here —
   * and the model is told, while it can still aim again.
   */
  it('degrades a finding aimed outside the diff and tells the model so', async () => {
    const tools = build();

    const response = await report(tools, {
      severity: 'blocker',
      path: 'src/index.js',
      line: 400,
      message: 'This is wrong.',
    });

    assert.match(response, /not where you aimed it/);
    assert.match(response, /report it again with one that is in the diff/);

    const recorded = tools.findings()[0];
    assert.equal(recorded?.anchor.tier, 'file');
    // The note travels in the message, because that is where a human reads it.
    assert.match(recorded?.message ?? '', /This is wrong\./);
    assert.match(recorded?.message ?? '', /line 400/);
  });

  it('degrades to the pull request when the path is not in the diff at all', async () => {
    const tools = build();

    await report(tools, { severity: 'minor', path: 'other.js', line: 1, message: 'hm' });

    assert.equal(tools.findings()[0]?.anchor.tier, 'pull_request');
  });

  /**
   * A budget message rather than a thrown tool error: throwing ends the loop and
   * loses the whole review, where a sentence leaves the model able to finish.
   */
  it('caps the findings and tells the model what to do instead', async () => {
    const tools = build();

    for (let i = 0; i < 15; i += 1) {
      await report(tools, { severity: 'minor', message: `finding ${i}` });
    }
    const response = await report(tools, { severity: 'blocker', message: 'one more' });

    assert.match(response, /budget of 15 is spent/);
    assert.equal(tools.findings().length, 15);
  });
});

describe('verdict', () => {
  const passed = { attempted: true, command: 'npm test', passed: true };
  const failed = { attempted: true, command: 'npm test', passed: false };
  const absent = { attempted: false };

  it('sends the change back for a blocker', () => {
    assert.equal(verdict([finding('blocker')], passed), 'changes_requested');
  });

  /** Severity is the model's call; whether major and minor block is not. */
  it('approves over major and minor findings', () => {
    assert.equal(verdict([finding('major'), finding('minor')], passed), 'approved');
  });

  /**
   * The one fact in a review that is not an opinion, so it does not need the
   * model to agree with it.
   */
  it('sends the change back for a failing suite even with no blockers', () => {
    assert.equal(verdict([finding('minor')], failed), 'changes_requested');
  });

  /**
   * An absent suite is a property of the repository, not a fault in the change.
   * The summary says the change was never executed; it does not block on it.
   */
  it('does not block on a repository that declares no test command', () => {
    assert.equal(verdict([], absent), 'approved');
  });

  it('approves a clean review', () => {
    assert.equal(verdict([], passed), 'approved');
  });
});

describe('describeThreads', () => {
  const comment = (overrides: Partial<PullRequestComment>): PullRequestComment => ({
    id: 1,
    author: 'agent',
    text: 'something',
    resolved: false,
    ...overrides,
  });

  /** A first pass has to be able to tell that it is one. */
  it('says plainly when there is no history', () => {
    assert.match(describeThreads([]), /no comments on this pull request/);
  });

  it('tags each side rather than dropping either', () => {
    const rendered = describeThreads([
      comment({ id: 1, author: 'agent', text: 'This drops the error.' }),
      comment({ id: 2, author: 'human', text: 'It is handled upstream.', parentId: 1 }),
    ]);

    assert.match(rendered, /You: This drops the error\./);
    assert.match(rendered, /Human: It is handled upstream\./);
  });

  /**
   * Decision 10, and the whole reason resolution travels as metadata. A resolved
   * thread is what stops the reviewer raising a settled point again, so hiding
   * it is the expensive option, not the tidy one.
   */
  it('shows resolved threads, marked as resolved', () => {
    const rendered = describeThreads([
      comment({ id: 1, text: 'Rename this.', resolved: true, path: 'src/index.js', line: 2 }),
    ]);

    assert.match(rendered, /RESOLVED/);
    assert.match(rendered, /Rename this\./);
  });

  it('groups replies under the comment they answer, with its anchor', () => {
    const rendered = describeThreads([
      comment({ id: 1, text: 'root', path: 'src/index.js', line: 2 }),
      comment({ id: 2, text: 'reply', parentId: 1 }),
      comment({ id: 3, text: 'standalone' }),
    ]);

    const threads = rendered.split('--- Thread').slice(1);
    assert.equal(threads.length, 2);
    assert.match(threads[0] ?? '', /on src\/index\.js:2/);
    assert.match(threads[0] ?? '', /root[\s\S]*reply/);
    assert.match(threads[1] ?? '', /on the pull request/);
  });

  /** An orphaned reply must still be shown; losing it loses half an exchange. */
  it('treats a reply whose parent is missing as its own thread', () => {
    const rendered = describeThreads([comment({ id: 2, text: 'reply', parentId: 999 })]);

    assert.match(rendered, /reply/);
  });
});

describe('reviewPrompt', () => {
  const files = parseDiff(DIFF);

  it('carries the story, the addressable lines, the history and the diff', () => {
    const prompt = reviewPrompt(workItem(), { diff: DIFF, files, comments: [] });

    assert.match(prompt, /Print hello to stdout\./);
    assert.match(prompt, /src\/index\.js \(modified\) — commentable lines 1-3/);
    assert.match(prompt, /no comments on this pull request/);
    assert.match(prompt, /\+const x = 1;/);
    assert.match(prompt, /Review attempt 1 of 3/);
  });

  it('says the story is empty rather than leaving a gap', () => {
    const prompt = reviewPrompt(workItem({ refinedDescription: '  ' }), {
      diff: DIFF,
      files,
      comments: [],
    });

    assert.match(prompt, /\(the story is empty\)/);
  });

  /** A huge diff must not eat the context the story and the threads need. */
  it('truncates a very large diff and says where to look instead', () => {
    const huge = `${DIFF}\n${'+x\n'.repeat(40_000)}`;

    const prompt = reviewPrompt(workItem(), { diff: huge, files, comments: [] });

    assert.ok(prompt.length < huge.length);
    assert.match(prompt, /diff is truncated here/);
  });
});
