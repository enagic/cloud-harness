/**
 * Implementer agent — entrypoint.
 *
 * Trigger:  human approval of a refined story (initial), reviewer
 *           changes-requested, or a rebase.
 * Does:     clones the repo, implements the story, runs the repo's own suite,
 *           pushes a branch and opens a pull request.
 * Leaves:   ticket in the code-review column, which triggers the reviewer.
 *
 * The work itself is in handle.ts, which is deliberately importable without
 * starting the consume loop. This file only wires it to the queue.
 *
 * STATUS: the `initial` reason is complete. `changes_requested` and `rebase`
 * are rejected as unimplemented rather than half handled — both continue a
 * branch that already exists, which is a different job from starting one.
 */

import { isImplementWorkItem } from '@cloud-harness/shared';

import { bootstrap } from '../runtime/consumer.js';
import { handleImplement } from './handle.js';

bootstrap({
  kind: 'implementer',
  queueUrlEnv: 'IMPLEMENTER_QUEUE_URL',
  validate: isImplementWorkItem,
  handle: handleImplement,
});
