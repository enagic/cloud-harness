/**
 * Anchoring, which is the one thing between a finding and a comment nobody sees.
 *
 * The fixture is a real Bitbucket three-dot diff, read off PR #1 of
 * kwon-cloud/sandbox — the pull request the implementer opened for KAN-6. It is
 * kept verbatim, trailing "\ No newline at end of file" markers and all, because
 * the parser's job is to survive what Bitbucket actually emits rather than what
 * a diff looks like in the abstract.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeDiff, parseDiff, resolveAnchor } from './diff.js';

/** Verbatim from GET /repositories/kwon-cloud/sandbox/pullrequests/1/diff. */
const SANDBOX_DIFF = `diff --git a/package.json b/package.json
new file mode 100644
index 0000000..13da25e
--- /dev/null
+++ b/package.json
@@ -0,0 +1,12 @@
+{
+  "name": "sandbox",
+  "version": "1.0.0",
+  "private": true,
+  "type": "module",
+  "scripts": {
+    "build": "node --check src/index.js",
+    "start": "node src/index.js",
+    "test": "node --test",
+    "lint": "node --check src/index.js"
+  }
+}
\\ No newline at end of file
diff --git a/src/index.js b/src/index.js
new file mode 100644
index 0000000..afda078
--- /dev/null
+++ b/src/index.js
@@ -0,0 +1 @@
+console.log('Hello, world!');
\\ No newline at end of file
`;

describe('parseDiff', () => {
  it('indexes every file in a real Bitbucket diff', () => {
    const files = parseDiff(SANDBOX_DIFF);

    assert.deepEqual([...files.keys()], ['package.json', 'src/index.js']);
    assert.equal(files.get('package.json')?.status, 'added');
    assert.equal(files.get('src/index.js')?.status, 'added');
  });

  it('addresses every added line, and no line past the end', () => {
    const files = parseDiff(SANDBOX_DIFF);

    assert.deepEqual([...(files.get('package.json')?.lines ?? [])], [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    assert.deepEqual([...(files.get('src/index.js')?.lines ?? [])], [1]);
  });

  /**
   * The hunk header's `+c,d` is the new file's numbering, and a removed line
   * does not advance it. Getting this wrong shifts every anchor below the first
   * deletion, which is the failure that looks like the model hallucinating.
   */
  it('counts new-file lines, so deletions do not shift the numbering', () => {
    const files = parseDiff(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,5 +10,5 @@',
        ' const a = 1;',
        '-const b = 2;',
        '-const c = 3;',
        '+const b = 20;',
        ' const d = 4;',
        '',
      ].join('\n'),
    );

    // 10 context, 11 added, 12 context. The two deletions consume old-file
    // lines only.
    assert.deepEqual([...(files.get('src/app.ts')?.lines ?? [])], [10, 11, 12]);
    assert.equal(files.get('src/app.ts')?.status, 'modified');
  });

  /**
   * A deleted file has no new-file side, so there is no line to anchor to. It
   * still has to be in the index — "this file is dead code now, delete it" is
   * decision 9's own example of a file-level finding.
   */
  it('keeps a removed file with no addressable lines', () => {
    const files = parseDiff(
      [
        'diff --git a/src/old.ts b/src/old.ts',
        'deleted file mode 100644',
        '--- a/src/old.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-const gone = true;',
        '-export default gone;',
        '',
      ].join('\n'),
    );

    const file = files.get('src/old.ts');
    assert.equal(file?.status, 'removed');
    assert.equal(file?.lines.size, 0);
  });

  it('reads a path containing a space off the marker lines', () => {
    const files = parseDiff(
      [
        'diff --git a/docs/my notes.md b/docs/my notes.md',
        '--- a/docs/my notes.md',
        '+++ b/docs/my notes.md',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    );

    assert.ok(files.has('docs/my notes.md'));
  });

  it('returns nothing for an empty diff rather than throwing', () => {
    assert.equal(parseDiff('').size, 0);
  });
});

describe('resolveAnchor', () => {
  const files = parseDiff(SANDBOX_DIFF);

  it('takes the line tier when the line is in the diff', () => {
    assert.deepEqual(resolveAnchor(files, { path: 'src/index.js', line: 1 }), {
      tier: 'line',
      path: 'src/index.js',
      line: 1,
    });
  });

  it('takes the file tier when no line is given', () => {
    assert.deepEqual(resolveAnchor(files, { path: 'package.json' }), {
      tier: 'file',
      path: 'package.json',
    });
  });

  it('takes the pull request tier when there is no path', () => {
    assert.deepEqual(resolveAnchor(files, {}), { tier: 'pull_request' });
  });

  /**
   * The case that matters, and the one Bitbucket will not catch: `to: 9999` on
   * a one-line file is accepted with 201 and shown to nobody. Degrading to the
   * file keeps the finding where a human will read it.
   */
  it('degrades a line that is not in the diff to the file, and says so', () => {
    const anchor = resolveAnchor(files, { path: 'src/index.js', line: 9999 });

    assert.equal(anchor.tier, 'file');
    assert.equal(anchor.path, 'src/index.js');
    assert.match(anchor.note ?? '', /line 9999/);
  });

  /** Same failure one tier out: a path the PR does not touch at all. */
  it('degrades an unknown path to the pull request, and says so', () => {
    const anchor = resolveAnchor(files, { path: 'does/not/exist.js', line: 1 });

    assert.equal(anchor.tier, 'pull_request');
    assert.equal(anchor.path, undefined);
    assert.match(anchor.note ?? '', /does not change/);
  });

  it('tolerates a leading ./ on a model-supplied path', () => {
    assert.equal(resolveAnchor(files, { path: './src/index.js', line: 1 }).tier, 'line');
  });
});

describe('describeDiff', () => {
  it('summarises consecutive addresses as ranges', () => {
    assert.match(describeDiff(parseDiff(SANDBOX_DIFF)), /package\.json \(added\) — commentable lines 1-12/);
  });

  it('says so when a file has nowhere to anchor', () => {
    const files = parseDiff(
      ['diff --git a/x b/x', '--- a/x', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone', ''].join('\n'),
    );

    assert.match(describeDiff(files), /no commentable lines/);
  });

  it('says so when the pull request changes nothing', () => {
    assert.match(describeDiff(new Map()), /changes no files/);
  });
});
