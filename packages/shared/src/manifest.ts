/**
 * `.cloud-harness.yml` — the repo's declaration of how to build and test itself.
 *
 * This lives in the target repository, not in this deployment's config, because
 * the team that owns the repo owns the answer. It is version-controlled,
 * reviewable, and changes in the same PR as the build change it describes.
 *
 * The `stack` field is load-bearing beyond documentation: it selects which
 * container image the implementer and reviewer run in, and therefore which
 * language runtimes are available to actually execute the test suite. See
 * docs/ARCHITECTURE.md → Runtime selection.
 *
 * Example:
 *
 *   stack: node
 *   setupCommand: npm ci
 *   buildCommand: npm run build
 *   testCommand: npm test
 *   lintCommand: npm run lint
 */

import { parse as parseYaml } from 'yaml';

/** Filenames checked, in order. */
export const MANIFEST_FILENAMES = ['.cloud-harness.yml', '.cloud-harness.yaml'] as const;

export interface RepoManifest {
  /** Must match a stack configured on this deployment. */
  stack: string;
  /** Install dependencies. Run once, before build or test. */
  setupCommand?: string;
  buildCommand?: string;
  /**
   * How the reviewer exercises the change. Without this the reviewer can read
   * the diff but cannot verify it does what the story asked, which is most of
   * the value of having a reviewer at all.
   */
  testCommand?: string;
  lintCommand?: string;
  /**
   * Paths the agents should not modify, as a courtesy signal. Advisory only —
   * nothing enforces it, so do not rely on it as a security control.
   */
  protectedPaths?: string[];
}

export type ManifestResult =
  | { ok: true; manifest: RepoManifest }
  | { ok: false; error: string };

function asOptionalString(value: unknown, field: string): string | undefined | Error {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parse and validate a manifest. Pure — takes the file contents, returns a
 * result rather than throwing, because a malformed manifest should fail one
 * ticket with a useful comment on the board, not crash the watcher.
 *
 * @param knownStacks stacks this deployment has images and queues for. An
 *   unknown stack is rejected here rather than at dispatch, so the ticket gets
 *   a message naming the valid options instead of vanishing into a queue that
 *   does not exist.
 */
export function parseManifest(source: string, knownStacks: string[]): ManifestResult {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    return { ok: false, error: `not valid YAML: ${(err as Error).message}` };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'must be a YAML mapping at the top level' };
  }

  const record = raw as Record<string, unknown>;

  const stack = record['stack'];
  if (typeof stack !== 'string' || stack.trim() === '') {
    return { ok: false, error: 'missing required field: stack' };
  }
  const normalizedStack = stack.trim();

  if (!knownStacks.includes(normalizedStack)) {
    return {
      ok: false,
      error:
        `unknown stack "${normalizedStack}". This deployment supports: ` +
        `${knownStacks.join(', ')}. Add a stack to the Terraform \`stacks\` ` +
        `variable and rebuild the agent images to support a new one.`,
    };
  }

  const manifest: RepoManifest = { stack: normalizedStack };

  for (const field of ['setupCommand', 'buildCommand', 'testCommand', 'lintCommand'] as const) {
    const value = asOptionalString(record[field], field);
    if (value instanceof Error) return { ok: false, error: value.message };
    if (value !== undefined) manifest[field] = value;
  }

  const protectedPaths = record['protectedPaths'];
  if (protectedPaths !== undefined && protectedPaths !== null) {
    if (!Array.isArray(protectedPaths) || protectedPaths.some((p) => typeof p !== 'string')) {
      return { ok: false, error: 'protectedPaths must be a list of strings' };
    }
    manifest.protectedPaths = protectedPaths as string[];
  }

  return { ok: true, manifest };
}

/**
 * Fill in whatever the manifest left out from the stack's configured defaults.
 *
 * A repo that follows its ecosystem's conventions can get away with a two-line
 * manifest; anything unusual overrides. Explicit manifest values always win —
 * the deployment never overrides what a repo said about itself.
 */
export function withStackDefaults(
  manifest: RepoManifest,
  defaults: Partial<Omit<RepoManifest, 'stack'>>,
): RepoManifest {
  const merged: RepoManifest = { ...manifest };

  // Assigned conditionally rather than with `??` into an object literal: under
  // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
  // absent key, and downstream code distinguishes "no test command" from
  // "test command present but undefined".
  for (const field of ['setupCommand', 'buildCommand', 'testCommand', 'lintCommand'] as const) {
    const value = manifest[field] ?? defaults[field];
    if (value !== undefined) merged[field] = value;
  }

  return merged;
}
