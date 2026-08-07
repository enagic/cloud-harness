/**
 * Liveness via heartbeat file.
 *
 * The watcher has no listening port, so the ECS health check runs
 * `node dist/healthcheck.js`, which reads the file this module writes. A
 * process that is alive but wedged (stuck HTTP call, hung poll) stops touching
 * the file and gets replaced, which a plain process-alive check would miss.
 */

import { writeFileSync, readFileSync } from 'node:fs';

export const HEARTBEAT_PATH = process.env['HEARTBEAT_PATH'] ?? '/tmp/watcher-heartbeat';

export function recordHeartbeat(): void {
  writeFileSync(HEARTBEAT_PATH, String(Date.now()), 'utf8');
}

/**
 * @param maxAgeMs how stale the heartbeat may be before the task is unhealthy.
 *   Should be a few poll intervals — one slow Jira call must not cycle the task.
 */
export function isHealthy(maxAgeMs: number): boolean {
  try {
    const written = Number.parseInt(readFileSync(HEARTBEAT_PATH, 'utf8'), 10);
    if (Number.isNaN(written)) return false;
    return Date.now() - written < maxAgeMs;
  } catch {
    return false;
  }
}
