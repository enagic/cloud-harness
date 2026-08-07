/**
 * Entry point for the ECS container health check. Exits 0 when healthy.
 * Referenced by infra/ecs.tf as `node dist/healthcheck.js`.
 */

import { isHealthy } from './health.js';

const pollIntervalMs = Number.parseInt(process.env['POLL_INTERVAL_SECONDS'] ?? '60', 10) * 1000;

// Three missed cycles plus a minute of slack.
const maxAgeMs = pollIntervalMs * 3 + 60_000;

process.exit(isHealthy(maxAgeMs) ? 0 : 1);
