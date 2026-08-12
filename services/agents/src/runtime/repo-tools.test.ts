import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { Tool } from 'ai';

import { createRepoTools, type RepoTools } from './repo-tools.js';

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

/**
 * Call a tool the way the AI SDK would. The execution options are irrelevant to
 * these tools, so a placeholder stands in for the whole envelope.
 */
async function call(tools: RepoTools, name: string, input: unknown): Promise<string> {
  const target = tools.tools[name] as Tool | undefined;
  assert.ok(target?.execute, `tool ${name} has no execute`);
  const output = await target.execute(input, {
    toolCallId: 'test',
    messages: [],
  } as never);
  return output as string;
}

describe('repo tools', () => {
  let root: string;
  let outside: string;
  let tools: RepoTools;

  before(async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'repo-tools-'));
    root = join(fixture, 'repo');
    outside = join(fixture, 'outside');

    await mkdir(join(root, 'src', 'auth'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(join(root, 'README.md'), '# Fixture\n');
    await writeFile(
      join(root, 'src', 'auth', 'session.ts'),
      'export function loadSession() {\n  return cache.get(SESSION_KEY);\n}\n',
    );
    await writeFile(join(root, 'src', 'auth', 'tenant.ts'), 'export const SESSION_KEY = "s";\n');
    await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'SESSION_KEY everywhere\n');
    await writeFile(join(root, '.env'), 'STRIPE_KEY=sk-live-abcdef\n');
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'prod.pem'), '-----BEGIN PRIVATE KEY-----\n');
    await writeFile(join(outside, 'secrets.env'), 'BITBUCKET_TOKEN=hunter2\n');
    await symlink(join(outside, 'secrets.env'), join(root, 'escape.env'));

    tools = createRepoTools({ root, log: silent });
  });

  after(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  describe('list_directory', () => {
    it('lists the root and marks directories', async () => {
      const output = await call(tools, 'list_directory', { path: '' });
      assert.match(output, /^src\/$/m);
      assert.match(output, /^README\.md$/m);
    });

    it('hides dependency directories', async () => {
      const output = await call(tools, 'list_directory', { path: '.' });
      assert.ok(!output.includes('node_modules'), output);
    });

    it('explains a missing directory instead of throwing', async () => {
      const output = await call(tools, 'list_directory', { path: 'src/nope' });
      assert.match(output, /Cannot list "src\/nope": no such file or directory\./);
    });
  });

  describe('read_file', () => {
    it('reads a file and records that it was read', async () => {
      const output = await call(tools, 'read_file', { path: 'src/auth/session.ts' });
      assert.match(output, /loadSession/);
      assert.ok(tools.readPaths().includes('src/auth/session.ts'), tools.readPaths().join(','));
    });

    it('redirects to list_directory when handed a directory', async () => {
      const output = await call(tools, 'read_file', { path: 'src' });
      assert.match(output, /is a directory/);
    });

    it('does not count a failed read as a read path', async () => {
      await call(tools, 'read_file', { path: 'src/auth/missing.ts' });
      assert.ok(!tools.readPaths().includes('src/auth/missing.ts'));
    });
  });

  describe('containment', () => {
    // The repository is third-party content. Each of these is a way out of it.
    it('refuses to climb out with ..', async () => {
      const output = await call(tools, 'read_file', { path: '../outside/secrets.env' });
      assert.match(output, /outside the repository/);
      assert.ok(!output.includes('hunter2'));
    });

    it('refuses an absolute path', async () => {
      const output = await call(tools, 'read_file', { path: join(outside, 'secrets.env') });
      assert.match(output, /absolute path/);
      assert.ok(!output.includes('hunter2'));
    });

    it('refuses a symlink that points out of the repository', async () => {
      const output = await call(tools, 'read_file', { path: 'escape.env' });
      assert.match(output, /symlink out of the repository/);
      assert.ok(!output.includes('hunter2'));
    });

    it('refuses to search outside the repository', async () => {
      const output = await call(tools, 'search_repo', { pattern: 'TOKEN', path: '../outside' });
      assert.match(output, /outside the repository/);
      assert.ok(!output.includes('hunter2'));
    });
  });

  describe('credentials', () => {
    // Anything the model reads can be quoted back into the Jira ticket, so a
    // checked-in .env must not reach its context in the first place.
    it('refuses to read a file that may hold credentials', async () => {
      const output = await call(tools, 'read_file', { path: '.env' });
      assert.match(output, /may hold credentials/);
      assert.ok(!output.includes('sk-live'));
    });

    it('refuses regardless of the suffix', async () => {
      const output = await call(tools, 'read_file', { path: 'config/prod.pem' });
      assert.match(output, /may hold credentials/);
      assert.ok(!output.includes('PRIVATE KEY'));
    });

    it('does not leak them through search either', async () => {
      // The pattern itself is echoed in the no-match message, so assert on the
      // secret values rather than on the pattern.
      const output = await call(tools, 'search_repo', { pattern: 'sk-live|BEGIN' });
      assert.match(output, /No matches/);
      assert.ok(!output.includes('abcdef'), output);
      assert.ok(!output.includes('PRIVATE KEY'), output);
    });

    it('still lists them, so the model knows they exist', async () => {
      const output = await call(tools, 'list_directory', { path: '' });
      assert.match(output, /^\.env$/m);
    });
  });

  describe('search_repo', () => {
    it('returns path, line number and the matching line', async () => {
      const output = await call(tools, 'search_repo', { pattern: 'SESSION_KEY' });
      assert.match(output, /src\/auth\/tenant\.ts:1: export const SESSION_KEY/);
      assert.match(output, /src\/auth\/session\.ts:2:/);
    });

    it('does not search dependency directories', async () => {
      const output = await call(tools, 'search_repo', { pattern: 'SESSION_KEY' });
      assert.ok(!output.includes('node_modules'), output);
    });

    it('scopes to a subdirectory when given one', async () => {
      const output = await call(tools, 'search_repo', { pattern: 'Fixture', path: 'src' });
      assert.match(output, /No matches/);
    });

    it('reports a bad regular expression rather than failing the run', async () => {
      const output = await call(tools, 'search_repo', { pattern: '([unclosed' });
      assert.match(output, /is not a valid regular expression/);
    });
  });

  it('heartbeats after every tool call', async () => {
    let beats = 0;
    const beating = createRepoTools({ root, log: silent, onProgress: async () => void beats++ });

    await call(beating, 'list_directory', { path: '' });
    await call(beating, 'read_file', { path: 'README.md' });
    await call(beating, 'read_file', { path: 'does-not-exist' });
    await call(beating, 'search_repo', { pattern: 'Fixture' });

    assert.equal(beats, 4, 'a failed tool call must heartbeat too');
  });
});
