/**
 * Resolving which runtime a ticket's work needs.
 *
 * This has to happen in the watcher, before dispatch, because the stack selects
 * the queue — and each queue feeds a task definition with a different image.
 * By the time an agent is running it is already too late to discover it needed
 * a JDK.
 */

import {
  parseManifest,
  withStackDefaults,
  type Logger,
  type RepositoryRef,
  type RuntimeRef,
  type StackDefaults,
} from '@cloud-harness/shared';

import type { BitbucketReader } from './bitbucket.js';

export interface RuntimeResolverOptions {
  knownStacks: string[];
  /** Used when a repo has no manifest at all. */
  defaultStack: string;
  stackDefaults: StackDefaults;
}

export type RuntimeResolution =
  | { ok: true; runtime: RuntimeRef; source: 'manifest' | 'default' }
  | { ok: false; error: string };

/**
 * Resolve a repo's runtime, falling back to the configured default when the
 * repo says nothing.
 *
 * A *malformed or unknown-stack* manifest is an error rather than a silent
 * fallback: the repo tried to say something and got it wrong, and quietly
 * running its Java tests in a Node image would produce a confusing review
 * ("tests could not be run") instead of an actionable one ("your manifest names
 * a stack this deployment does not have").
 */
export async function resolveRuntime(
  repo: RepositoryRef,
  bitbucket: BitbucketReader,
  options: RuntimeResolverOptions,
  log: Logger,
): Promise<RuntimeResolution> {
  let source: string | undefined;
  try {
    source = await bitbucket.readManifest(repo);
  } catch (err) {
    return {
      ok: false,
      error: `could not read the repo manifest: ${(err as Error).message}`,
    };
  }

  if (source === undefined) {
    if (!options.knownStacks.includes(options.defaultStack)) {
      return {
        ok: false,
        error:
          `no .cloud-harness.yml in ${repo.workspace}/${repo.slug}, and the ` +
          `configured default stack "${options.defaultStack}" is not one of ` +
          `${options.knownStacks.join(', ')}.`,
      };
    }
    log.debug('no manifest; using default stack', { stack: options.defaultStack });
    return {
      ok: true,
      source: 'default',
      runtime: {
        stack: options.defaultStack,
        manifest: withStackDefaults(
          { stack: options.defaultStack },
          options.stackDefaults[options.defaultStack] ?? {},
        ),
      },
    };
  }

  const parsed = parseManifest(source, options.knownStacks);
  if (!parsed.ok) {
    return { ok: false, error: `.cloud-harness.yml is invalid: ${parsed.error}` };
  }

  return {
    ok: true,
    source: 'manifest',
    runtime: {
      stack: parsed.manifest.stack,
      manifest: withStackDefaults(
        parsed.manifest,
        options.stackDefaults[parsed.manifest.stack] ?? {},
      ),
    },
  };
}
