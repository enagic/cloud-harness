/**
 * The implementer's write surface, which is the one place in the pipeline where
 * a model's output lands on a filesystem.
 *
 * Most of what is tested here is containment. The repository is third-party
 * content and the paths come from a model, so the interesting cases are the ones
 * where those two combine: a checked-in symlink pointing out of the repo, a path
 * that climbs out with `..`, a write aimed at git's own state. The read tools
 * have their own version of these tests; the write side needs its own because it
 * has to reason about paths that do not exist yet, where realpath cannot help.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { Tool } from 'ai';

import { createEditTools, type EditTools } from './edit-tools.js';

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

async function call(tools: EditTools, name: string, input: unknown): Promise<string> {
  const target = tools.tools[name] as Tool | undefined;
  assert.ok(target?.execute, `${name} has no execute`);
  const output = await target.execute(input as never, { toolCallId: 'test', messages: [] } as never);
  return output as string;
}

describe('createEditTools', () => {
  let fixture: string;
  let outside: string;
  let tools: EditTools;

  before(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'edit-tools-'));
    outside = await mkdtemp(join(tmpdir(), 'edit-outside-'));

    await mkdir(join(fixture, 'src'), { recursive: true });
    await mkdir(join(fixture, '.git'), { recursive: true });
    await writeFile(join(fixture, 'src', 'existing.ts'), 'export const a = 1;\n');
    await writeFile(join(fixture, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(outside, 'secret.txt'), 'do not touch\n');
    // The repo is third-party content, so a symlink out of it is a thing that
    // can genuinely be checked in.
    await symlink(outside, join(fixture, 'escape'));

    tools = createEditTools({ root: fixture, log: silent });
  });

  after(async () => {
    await rm(fixture, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('creates a file, making its parent directories', async () => {
    const response = await call(tools, 'write_file', {
      path: 'src/deep/nested/cli.ts',
      content: 'export const run = () => {};\n',
    });

    assert.match(response, /Wrote \d+ bytes/);
    assert.equal(
      await readFile(join(fixture, 'src', 'deep', 'nested', 'cli.ts'), 'utf8'),
      'export const run = () => {};\n',
    );
  });

  it('replaces a file entirely rather than appending', async () => {
    await call(tools, 'write_file', { path: 'src/existing.ts', content: 'export const b = 2;\n' });

    assert.equal(await readFile(join(fixture, 'src', 'existing.ts'), 'utf8'), 'export const b = 2;\n');
  });

  it('records what it wrote and deleted, sorted and deduplicated', async () => {
    const local = createEditTools({ root: fixture, log: silent });

    await call(local, 'write_file', { path: 'src/z.ts', content: 'z\n' });
    await call(local, 'write_file', { path: 'src/a.ts', content: 'a\n' });
    await call(local, 'write_file', { path: 'src/a.ts', content: 'a2\n' });
    await call(local, 'delete_file', { path: 'src/z.ts' });

    assert.deepEqual(local.changedPaths(), [join('src', 'a.ts'), join('src', 'z.ts')]);
  });

  it('reports a delete of something that is not there without throwing', async () => {
    const response = await call(tools, 'delete_file', { path: 'src/never-existed.ts' });

    assert.match(response, /no such file/);
  });

  /**
   * A recursive directory removal is a far larger blast radius than any story
   * needs, and a model reaching for one is usually confused rather than right.
   */
  it('refuses to delete a directory', async () => {
    const response = await call(tools, 'delete_file', { path: 'src' });

    assert.match(response, /is a directory/);
    assert.equal((await readFile(join(fixture, 'src', 'existing.ts'), 'utf8')).length > 0, true);
  });

  describe('containment', () => {
    it('refuses a path that climbs out of the repository', async () => {
      const response = await call(tools, 'write_file', {
        path: '../escaped.ts',
        content: 'nope\n',
      });

      assert.match(response, /outside the repository/);
    });

    it('refuses an absolute path', async () => {
      const response = await call(tools, 'write_file', {
        path: join(outside, 'absolute.ts'),
        content: 'nope\n',
      });

      assert.match(response, /absolute path/);
    });

    /**
     * The case the lexical check alone would miss. `escape/` is a symlink out of
     * the repo and the file does not exist yet, so there is nothing to realpath
     * — containment has to come from resolving the nearest ancestor that does
     * exist, which is the symlink itself.
     */
    it('refuses a new file underneath a symlink that leaves the repository', async () => {
      const response = await call(tools, 'write_file', {
        path: 'escape/planted.txt',
        content: 'nope\n',
      });

      assert.match(response, /symlink out of the repository/);
      await assert.rejects(() => readFile(join(outside, 'planted.txt'), 'utf8'));
    });

    it('refuses to overwrite a file reached through such a symlink', async () => {
      const response = await call(tools, 'write_file', {
        path: 'escape/secret.txt',
        content: 'nope\n',
      });

      assert.match(response, /symlink out of the repository/);
      assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'do not touch\n');
    });

    /**
     * Editing git's own state is never the way to make a change. The commit is
     * made for the model, from whatever the working tree says.
     */
    it('refuses to write inside .git', async () => {
      const response = await call(tools, 'write_file', {
        path: '.git/HEAD',
        content: 'ref: refs/heads/hijacked\n',
      });

      assert.match(response, /inside \.git/);
      assert.equal(await readFile(join(fixture, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    });

    it('refuses to write a credentials file into the branch', async () => {
      for (const path of ['.env', 'config/secrets.yml', 'deploy/id_rsa', 'certs/server.pem']) {
        const response = await call(tools, 'write_file', { path, content: 'nope\n' });
        assert.match(response, /credentials file/, `${path} was not refused`);
      }
    });

    it('refuses a write larger than the cap, without truncating it', async () => {
      const response = await call(tools, 'write_file', {
        path: 'src/huge.ts',
        content: 'x'.repeat(300 * 1024),
      });

      assert.match(response, /Refusing to write/);
      await assert.rejects(() => readFile(join(fixture, 'src', 'huge.ts'), 'utf8'));
    });

    /** None of the refusals may end the loop — the model gets told and tries again. */
    it('reports every refusal as a string rather than throwing', async () => {
      const responses = await Promise.all([
        call(tools, 'write_file', { path: '../x.ts', content: 'x' }),
        call(tools, 'delete_file', { path: '../x.ts' }),
        call(tools, 'delete_file', { path: '.git/HEAD' }),
      ]);

      for (const response of responses) assert.equal(typeof response, 'string');
    });
  });
});
