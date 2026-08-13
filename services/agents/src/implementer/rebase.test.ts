/**
 * The parts of a conflict resolution that do not need a model: what the model is
 * told, and whether what it wrote back is fit to stage.
 *
 * The check on the way out is the load-bearing half. `git add -A` believes
 * whatever it is handed, so a file still full of conflict markers stages
 * happily, commits, and pushes — a failure that looks like a successful rebase
 * from every angle except reading the diff.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { WORK_ITEM_SCHEMA_VERSION, type ImplementWorkItem } from '@cloud-harness/shared';

import { conflictPrompt, hasConflictMarkers, unresolvedPaths } from './rebase.js';

function workItem(overrides: Partial<ImplementWorkItem> = {}): ImplementWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    agent: 'implementer',
    reason: 'rebase',
    issueKey: 'KAN-6',
    issueId: '10005',
    title: 'Add a health endpoint',
    repository: { workspace: 'acme', slug: 'service', baseBranch: 'develop' },
    runtime: {
      stack: 'node',
      manifest: { stack: 'node', setupCommand: 'npm ci', testCommand: 'npm test' },
    },
    dispatchedAt: '2026-08-13T09:00:00.000Z',
    refinedDescription: '## Summary\n\nExpose /health returning 200.',
    attempt: 2,
    maxAttempts: 3,
    existingBranch: 'agent/kan-6-add-a-health-endpoint',
    ...overrides,
  };
}

const conflicted = `const a = 1;
<<<<<<< HEAD
const mode = "main";
=======
const mode = "feature";
>>>>>>> 4f2c1ab (feature work)
`;

describe('conflictPrompt', () => {
  it('names every conflicted file and the branch being rebased onto', () => {
    const prompt = conflictPrompt(workItem(), ['src/app.ts', 'package.json']);

    assert.match(prompt, /Ticket: KAN-6/);
    assert.match(prompt, /Base branch being rebased onto: develop/);
    assert.match(prompt, /- src\/app\.ts/);
    assert.match(prompt, /- package\.json/);
  });

  /**
   * Which of two competing edits is the one this branch exists for is often only
   * answerable from the story, so it travels even though the task is the
   * conflict rather than the story.
   */
  it('carries the story as context for which side is the point of the branch', () => {
    assert.match(conflictPrompt(workItem(), ['src/app.ts']), /Expose \/health returning 200\./);
  });

  it('says the story is empty rather than leaving a gap', () => {
    assert.match(
      conflictPrompt(workItem({ refinedDescription: '  ' }), ['src/app.ts']),
      /\(the story is empty\)/,
    );
  });
});

describe('hasConflictMarkers', () => {
  it('finds a conflict git left behind', () => {
    assert.equal(hasConflictMarkers(conflicted), true);
  });

  it('passes a file that was actually resolved', () => {
    assert.equal(hasConflictMarkers('const a = 1;\nconst mode = "feature";\n'), false);
  });

  /**
   * The reason `=======` is not one of the markers looked for: a row of equals
   * signs opens a setext heading in Markdown and underlines a section in
   * reStructuredText. Rejecting a correctly resolved README over one would be
   * maddening, and the angle-bracket markers have no such second life.
   */
  it('does not mistake a Markdown heading underline for a conflict', () => {
    assert.equal(hasConflictMarkers('Release notes\n=============\n\nAll good.\n'), false);
  });

  it('does not fire on angle brackets that are not at the start of a line', () => {
    assert.equal(hasConflictMarkers('const shift = a >>>>>>> b;\n'), false);
  });
});

describe('unresolvedPaths', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'rebase-check-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('passes a file the model wrote back clean', async () => {
    await writeFile(join(workdir, 'app.ts'), 'const mode = "feature";\n');

    const unresolved = await unresolvedPaths(workdir, ['app.ts'], new Set(['app.ts']));

    assert.deepEqual(unresolved, []);
  });

  it('catches a file the model wrote back with the markers still in it', async () => {
    await writeFile(join(workdir, 'app.ts'), conflicted);

    const unresolved = await unresolvedPaths(workdir, ['app.ts'], new Set(['app.ts']));

    assert.deepEqual(unresolved, [{ path: 'app.ts', reason: 'conflict_markers' }]);
  });

  /**
   * The case a marker scan alone would wave through. A binary conflict, or a
   * file deleted on one side and modified on the other, has no markers to find —
   * so an untouched conflicted path counts as unresolved whatever is in it,
   * rather than staging git's unresolved copy.
   */
  it('catches a conflicted file the model never touched', async () => {
    await writeFile(join(workdir, 'logo.png'), 'not really a png, but not marked up either');

    const unresolved = await unresolvedPaths(workdir, ['logo.png'], new Set());

    assert.deepEqual(unresolved, [{ path: 'logo.png', reason: 'untouched' }]);
  });

  /** Deleting is a resolution: the delete/modify conflict settled on the delete. */
  it('accepts a conflicted file the model resolved by deleting it', async () => {
    const unresolved = await unresolvedPaths(workdir, ['gone.ts'], new Set(['gone.ts']));

    assert.deepEqual(unresolved, []);
  });

  it('reports every unresolved path, not just the first', async () => {
    await writeFile(join(workdir, 'a.ts'), conflicted);
    await writeFile(join(workdir, 'b.ts'), conflicted);

    const unresolved = await unresolvedPaths(
      workdir,
      ['a.ts', 'b.ts'],
      new Set(['a.ts', 'b.ts']),
    );

    assert.equal(unresolved.length, 2);
  });
});
