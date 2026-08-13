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
 * STATUS: the `initial` and `rebase` reasons are complete. `changes_requested`
 * is rejected as unimplemented rather than half handled — it needs the review
 * findings in front of the model, and the ticket is failed onto the board so
 * the refusal is visible rather than looking like a run still in progress.
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
