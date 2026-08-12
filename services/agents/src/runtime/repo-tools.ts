/**
 * An agent's view of the repository: list, read, search.
 *
 * This is the whole reason an agent clones anything. For the refiner, a story
 * that names the files the work lands in and the pattern to follow is worth
 * more to the implementer than any amount of restated prose; for the
 * implementer, code that reads like its neighbours can only be written by
 * something that has read them. The only way to get either is to let the model
 * actually look.
 *
 * Read-only by construction — there is no tool here that writes. That is what
 * makes it safe to hand to the refiner, which runs as the `read` Bitbucket
 * identity and must not "just fix it". An agent that is meant to change files
 * composes these with its own write tools (see implementer/edit-tools.ts)
 * rather than finding a write path in here.
 *
 * Every tool is bounded and every tool returns a string, including on failure.
 * A model that asks for a path that does not exist should get a sentence
 * telling it so and try again; throwing would end the loop over a typo.
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { Logger } from '@cloud-harness/shared';

/** Directories that are never worth a model's attention or its context budget. */
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.gradle',
  '.idea',
  '.mvn',
  '.next',
  '.terraform',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

/**
 * Files whose *contents* the refiner never sees.
 *
 * A checked-in `.env` is common, and the refiner has no use for one. What it
 * does have is a direct route from its context into a Jira ticket: anything the
 * model reads can end up quoted in the refined story, in front of everyone with
 * access to the board and inside the work item of every agent downstream.
 * Listing these is fine and sometimes useful — reading them is not.
 */
const SENSITIVE_FILES = [
  /^\.env($|\.)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|[-_.])secrets?([-_.]|$)/i,
];

/**
 * Exported for the write tools, which need the same answer for a different
 * reason: the refiner must not read a credential into its context, and the
 * implementer must not write one into a branch.
 */
export function isSensitive(name: string): boolean {
  return SENSITIVE_FILES.some((pattern) => pattern.test(name));
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 300;
const MAX_SEARCH_MATCHES = 60;
const MAX_SEARCH_FILES = 4000;
/** Above this a file is data, not source, and grepping it wastes the budget. */
const MAX_SEARCHABLE_BYTES = 512 * 1024;

export interface RepoToolsOptions {
  /** The workspace root. Nothing outside it is reachable. */
  root: string;
  log: Logger;
  /**
   * Called after each tool runs. Wired to the SQS visibility heartbeat: a slow
   * exploration must not let the work item be redelivered underneath us.
   */
  onProgress?: () => Promise<void>;
}

export interface RepoTools {
  tools: ToolSet;
  /** Repo-relative paths the model actually read. Useful for logs and audit. */
  readPaths: () => string[];
}

/**
 * Resolve a model-supplied path inside the workspace, or explain why not.
 *
 * Two distinct escapes to stop: a path that resolves outside the root (`..`,
 * or an absolute path), and a symlink inside the repo pointing out of it. The
 * second matters because the repo is third-party content — a checked-in
 * symlink to /etc or to the task's credentials file is a plausible thing to
 * find in a repo the pipeline was pointed at, deliberately or otherwise.
 */
export async function resolveWithin(
  root: string,
  candidate: string,
): Promise<{ ok: true; absolute: string } | { ok: false; error: string }> {
  const cleaned = candidate.trim().replace(/^\.\/+/, '');
  if (isAbsolute(cleaned)) {
    return { ok: false, error: `"${candidate}" is an absolute path; use a repository-relative one.` };
  }

  const absolute = resolve(root, cleaned);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    return { ok: false, error: `"${candidate}" is outside the repository.` };
  }

  try {
    const real = await realpath(absolute);
    if (real !== root && !real.startsWith(root + sep)) {
      return { ok: false, error: `"${candidate}" is a symlink out of the repository.` };
    }
    return { ok: true, absolute: real };
  } catch {
    // Does not exist. Not an error here — the caller reports it in its own
    // terms, since "no such file" and "no such directory" read differently.
    return { ok: true, absolute };
  }
}

export function describe(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'no such file or directory';
  if (code === 'EACCES') return 'permission denied';
  if (code === 'EISDIR') return 'that is a directory, not a file';
  if (code === 'ENOTDIR') return 'that is a file, not a directory';
  return err instanceof Error ? err.message : String(err);
}

export function createRepoTools(options: RepoToolsOptions): RepoTools {
  const { log } = options;
  const read = new Set<string>();

  /**
   * The root, with symlinks resolved, memoised.
   *
   * It has to be canonical before anything is compared against it: the
   * workspace root is a mkdtemp directory, and on a host where the temp
   * directory is itself a symlink (`/var` -> `/private/var`) every realpath
   * below it would fail the containment check and the refiner would find an
   * empty repository.
   */
  let rootPromise: Promise<string> | undefined;
  const repoRoot = (): Promise<string> =>
    (rootPromise ??= realpath(options.root).catch(() => options.root));

  const progress = async (): Promise<void> => {
    await options.onProgress?.();
  };

  const listDirectory = tool({
    description:
      'List the files and subdirectories at a repository-relative path. Use "" or "." ' +
      'for the repository root. Build directories and dependency directories are omitted.',
    inputSchema: z.object({
      path: z.string().describe('Repository-relative directory path, e.g. "src/auth".'),
    }),
    execute: async ({ path }): Promise<string> => {
      const root = await repoRoot();
      const resolved = await resolveWithin(root, path);
      if (!resolved.ok) return resolved.error;

      try {
        const entries = await readdir(resolved.absolute, { withFileTypes: true });
        const visible = entries
          .filter((entry) => !(entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

        if (visible.length === 0) return `${path || '.'} is empty.`;

        const shown = visible.slice(0, MAX_DIRECTORY_ENTRIES);
        const lines = shown.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
        const omitted = visible.length - shown.length;

        return (
          `${path || '.'}:\n${lines.join('\n')}` +
          (omitted > 0 ? `\n… ${omitted} more entries omitted` : '')
        );
      } catch (err) {
        return `Cannot list "${path}": ${describe(err)}.`;
      } finally {
        await progress();
      }
    },
  });

  const readRepoFile = tool({
    description:
      'Read a file from the repository. Long files are truncated, so prefer reading ' +
      'a specific file you have reason to believe is relevant over reading broadly.',
    inputSchema: z.object({
      path: z.string().describe('Repository-relative file path, e.g. "src/auth/session.ts".'),
    }),
    execute: async ({ path }): Promise<string> => {
      const root = await repoRoot();
      const resolved = await resolveWithin(root, path);
      if (!resolved.ok) return resolved.error;

      if (isSensitive(basename(resolved.absolute))) {
        return (
          `"${path}" may hold credentials, so its contents are not readable. ` +
          'Refine the ticket without it.'
        );
      }

      try {
        const info = await stat(resolved.absolute);
        if (info.isDirectory()) {
          return `"${path}" is a directory. Use list_directory on it instead.`;
        }

        const buffer = await readFile(resolved.absolute);
        const truncated = buffer.byteLength > MAX_FILE_BYTES;
        const text = buffer.subarray(0, MAX_FILE_BYTES).toString('utf8');

        read.add(relative(root, resolved.absolute) || path);

        return truncated
          ? `${text}\n\n… truncated at ${MAX_FILE_BYTES} bytes of ${info.size}.`
          : text;
      } catch (err) {
        return `Cannot read "${path}": ${describe(err)}.`;
      } finally {
        await progress();
      }
    },
  });

  const searchRepo = tool({
    description:
      'Search the repository for a regular expression and return matching lines with ' +
      'their file and line number. This is how to find prior art without guessing at paths.',
    inputSchema: z.object({
      pattern: z.string().describe('JavaScript regular expression, case-insensitive.'),
      path: z
        .string()
        .optional()
        .describe('Optional repository-relative directory to search within.'),
    }),
    execute: async ({ pattern, path }): Promise<string> => {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch (err) {
        return `"${pattern}" is not a valid regular expression: ${describe(err)}.`;
      }

      const root = await repoRoot();
      const resolved = await resolveWithin(root, path ?? '');
      if (!resolved.ok) return resolved.error;

      try {
        const matches = await search(resolved.absolute, root, regex);
        if (matches.length === 0) {
          return `No matches for /${pattern}/ in ${path || 'the repository'}.`;
        }
        const shown = matches.slice(0, MAX_SEARCH_MATCHES);
        return (
          shown.join('\n') +
          (matches.length > shown.length
            ? `\n… ${matches.length - shown.length} more matches; narrow the pattern.`
            : '')
        );
      } catch (err) {
        return `Cannot search "${path ?? '.'}": ${describe(err)}.`;
      } finally {
        await progress();
      }
    },
  });

  log.debug('repo tools ready', { root: options.root });

  return {
    tools: {
      list_directory: listDirectory,
      read_file: readRepoFile,
      search_repo: searchRepo,
    },
    readPaths: () => [...read].sort(),
  };
}

/**
 * Walk and match in-process rather than shelling out to grep.
 *
 * The pattern comes from a model, and handing model output to a shell is the
 * kind of thing that works until it does not. This also keeps behaviour
 * identical across the three stack images, which do not all ship the same grep.
 */
async function search(from: string, root: string, regex: RegExp): Promise<string[]> {
  const matches: string[] = [];
  const queue = [from];
  let filesScanned = 0;

  while (queue.length > 0 && matches.length < MAX_SEARCH_MATCHES * 2) {
    const dir = queue.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory; the rest of the tree is still useful.
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(full);
        continue;
      }
      // Symlinks are skipped rather than followed: they can leave the repo and
      // they can loop.
      if (!entry.isFile()) continue;
      // Same rule as read_file: a match line would quote the secret verbatim.
      if (isSensitive(entry.name)) continue;
      if (filesScanned >= MAX_SEARCH_FILES) return matches;

      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.size > MAX_SEARCHABLE_BYTES) continue;

      filesScanned += 1;

      let content;
      try {
        content = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      // A null byte means binary. utf8-decoding one does not throw, it just
      // produces line noise that would poison the model's context.
      if (content.includes('\0')) continue;

      const lines = content.split('\n');
      for (const [index, line] of lines.entries()) {
        if (!regex.test(line)) continue;
        matches.push(`${relative(root, full)}:${index + 1}: ${line.trim().slice(0, 200)}`);
        if (matches.length >= MAX_SEARCH_MATCHES * 2) break;
      }
    }
  }

  return matches;
}
