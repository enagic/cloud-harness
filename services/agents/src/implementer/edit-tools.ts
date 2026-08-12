/**
 * The implementer's write access to the workspace: create, overwrite, delete.
 *
 * Paired with the read tools in runtime/repo-tools.ts, which every agent gets.
 * These are the implementer's alone, and they are deliberately the whole of its
 * write surface — there is no `run_command` here, so a model cannot reach for
 * `sed` or `git` or a package installer to do something these tools do not
 * express. What it changes, it changes by writing a file.
 *
 * Whole-file writes rather than patches. A patch tool needs the model to
 * reproduce surrounding context exactly, and when it does not, the failure is a
 * rejected hunk mid-loop that the model then works around. Rewriting a file it
 * has just read costs output tokens and nothing else, and the truncation guard
 * in read_file is what stops it being asked to rewrite something enormous.
 *
 * Like the read tools, every tool returns a string on failure rather than
 * throwing: a model that writes to a bad path should be told so and get another
 * turn, not end the run.
 */

import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { Logger } from '@cloud-harness/shared';

import { describe, isSensitive, resolveWithin } from '../runtime/repo-tools.js';

/**
 * Generous, but not unbounded. A model rewriting a file it read back is capped
 * by read_file's own 64KB truncation; this exists to catch a model that has
 * started generating something pathological.
 */
const MAX_WRITE_BYTES = 256 * 1024;

/** Paths under here are git's own state, not the project's source. */
const GIT_DIRECTORY = '.git';

export interface EditToolsOptions {
  /** The workspace root. Nothing outside it is writable. */
  root: string;
  log: Logger;
  /** Called after each tool runs; wired to the SQS visibility heartbeat. */
  onProgress?: () => Promise<void>;
}

export interface EditTools {
  tools: ToolSet;
  /**
   * Repo-relative paths the model wrote or deleted, in sorted order.
   *
   * Advisory, for logs and the PR body. The commit is built from `git add -A`,
   * so this is what the model *says* it touched rather than the authority on
   * what actually changed — those agree unless something else wrote to the
   * workspace, and nothing else does.
   */
  changedPaths: () => string[];
}

/**
 * Resolve a path the model intends to write to.
 *
 * Stricter than the read side, and it has to be. `resolveWithin` proves
 * containment by realpath, which only works on something that already exists —
 * for a file being created it falls back to the lexical check alone, and a
 * checked-in symlink (`config -> /etc`) would let `config/passwd` resolve
 * lexically inside the repo and land outside it. So the nearest existing
 * ancestor is resolved too: that directory does exist, so its realpath is real,
 * and a write beneath it cannot escape what it contains.
 */
async function resolveWritable(
  root: string,
  candidate: string,
): Promise<{ ok: true; absolute: string } | { ok: false; error: string }> {
  const resolved = await resolveWithin(root, candidate);
  if (!resolved.ok) return resolved;

  const relativePath = relative(root, resolved.absolute);
  if (relativePath === GIT_DIRECTORY || relativePath.startsWith(GIT_DIRECTORY + sep)) {
    return {
      ok: false,
      error: `"${candidate}" is inside .git. Change the working tree; the commit is made for you.`,
    };
  }

  if (isSensitive(basename(resolved.absolute))) {
    return {
      ok: false,
      error:
        `"${candidate}" looks like a credentials file, so it cannot be written. ` +
        'Secrets belong in the deployment, not in the repository.',
    };
  }

  // Walk up to something that exists, and check *that* by realpath.
  let ancestor = dirname(resolved.absolute);
  for (;;) {
    const relativeAncestor = relative(root, ancestor);
    const existing = await resolveWithin(root, relativeAncestor || '.');
    if (!existing.ok) {
      // The failure is the ancestor's, but the model asked about `candidate` and
      // that is what it needs to hear about — being told "escape" is outside the
      // repository when it asked to write "escape/x.ts" reads like a different
      // problem.
      return {
        ok: false,
        error: `"${candidate}" is under "${relativeAncestor}", which is a symlink out of the repository.`,
      };
    }

    try {
      const info = await stat(existing.absolute);
      if (!info.isDirectory()) {
        return { ok: false, error: `"${candidate}" is inside "${relativeAncestor}", which is a file.` };
      }
      // resolveWithin realpath'd it and confirmed containment, so we are done.
      return { ok: true, absolute: resolved.absolute };
    } catch {
      const parent = dirname(ancestor);
      // Reached the root (or the filesystem root) without finding anything that
      // exists. The lexical check above already covered this case.
      if (parent === ancestor || ancestor === root) return { ok: true, absolute: resolved.absolute };
      ancestor = parent;
    }
  }
}

export function createEditTools(options: EditToolsOptions): EditTools {
  const { log } = options;
  const changed = new Set<string>();

  /**
   * The root, with symlinks resolved, memoised — the same trap the read tools
   * document. The workspace root is a mkdtemp directory, and where the temp
   * directory is itself a symlink (`/var` -> `/private/var`) every containment
   * check below would compare a canonical path against a non-canonical root and
   * refuse every write in the repository.
   */
  let rootPromise: Promise<string> | undefined;
  const repoRoot = (): Promise<string> =>
    (rootPromise ??= realpath(options.root).catch(() => resolve(options.root)));

  const progress = async (): Promise<void> => {
    await options.onProgress?.();
  };

  const record = (root: string, absolute: string, fallback: string): string => {
    const path = relative(root, absolute) || fallback;
    changed.add(path);
    return path;
  };

  const writeRepoFile = tool({
    description:
      'Create a file or replace its entire contents. Pass the complete file, not a diff ' +
      'and not a fragment — whatever you pass becomes the whole file. Read a file before ' +
      'overwriting it so you keep the parts you did not mean to change. Parent ' +
      'directories are created for you.',
    inputSchema: z.object({
      path: z.string().describe('Repository-relative file path, e.g. "src/cli.ts".'),
      content: z.string().describe('The complete new contents of the file.'),
    }),
    execute: async ({ path, content }): Promise<string> => {
      const root = await repoRoot();
      const resolved = await resolveWritable(root, path);
      if (!resolved.ok) return resolved.error;

      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        return (
          `Refusing to write ${bytes} bytes to "${path}"; the limit is ${MAX_WRITE_BYTES}. ` +
          'Split the change across smaller files.'
        );
      }

      try {
        await mkdir(dirname(resolved.absolute), { recursive: true });
        await writeFile(resolved.absolute, content, 'utf8');
        const recorded = record(root, resolved.absolute, path);
        log.info('wrote file', { path: recorded, bytes });
        return `Wrote ${bytes} bytes to ${recorded}.`;
      } catch (err) {
        return `Cannot write "${path}": ${describe(err)}.`;
      } finally {
        await progress();
      }
    },
  });

  const deleteRepoFile = tool({
    description:
      'Delete a file from the repository. Use this only when the story calls for removing ' +
      'something; do not delete a file to work around an error in it.',
    inputSchema: z.object({
      path: z.string().describe('Repository-relative file path.'),
    }),
    execute: async ({ path }): Promise<string> => {
      const root = await repoRoot();
      const resolved = await resolveWritable(root, path);
      if (!resolved.ok) return resolved.error;

      try {
        const info = await stat(resolved.absolute);
        if (info.isDirectory()) {
          // Recursive directory removal is a much larger blast radius than
          // anything a story needs, and a model reaching for it is usually
          // confused rather than right.
          return `"${path}" is a directory. Delete the files in it individually.`;
        }

        await rm(resolved.absolute);
        const recorded = record(root, resolved.absolute, path);
        log.info('deleted file', { path: recorded });
        return `Deleted ${recorded}.`;
      } catch (err) {
        return `Cannot delete "${path}": ${describe(err)}.`;
      } finally {
        await progress();
      }
    },
  });

  return {
    tools: {
      write_file: writeRepoFile,
      delete_file: deleteRepoFile,
    },
    changedPaths: () => [...changed].sort(),
  };
}
