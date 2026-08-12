/**
 * Per-item scratch directory on the task's ephemeral volume.
 *
 * Cleanup is real; the clone it wraps is not.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger, RepositoryRef } from '@cloud-harness/shared';

import type { BitbucketClient } from '../clients/bitbucket.js';

const workspaceRoot = process.env['WORKSPACE_DIR'] ?? '/workspace';

export async function prepareWorkspace(args: {
  issueKey: string;
  repo: RepositoryRef;
  branch?: string;
  bitbucket: BitbucketClient;
  log: Logger;
  /**
   * Truncate history to this many commits. A reader passes 1; anything that
   * rebases must leave it unset, because a shallow clone cannot replay commits
   * onto a base branch it does not have.
   */
  depth?: number;
}): Promise<string> {
  const dir = await mkdtemp(join(workspaceRoot, `${args.issueKey}-`));
  args.log.info('prepared workspace', { dir, branch: args.branch ?? args.repo.baseBranch });

  // TODO: configure git user.name / user.email for the commit author here, and
  // decide whether dependency install happens now or is left to the agent.
  await args.bitbucket.clone(
    args.repo,
    dir,
    args.branch,
    args.depth === undefined ? {} : { depth: args.depth },
  );

  return dir;
}

export async function cleanupWorkspace(dir: string, log: Logger): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    log.debug('cleaned workspace', { dir });
  } catch (err) {
    // The task is about to exit and the volume dies with it; not worth failing.
    log.warn('failed to clean workspace', { dir, err });
  }
}
