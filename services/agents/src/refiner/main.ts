/**
 * Refiner agent — entrypoint.
 *
 * Trigger:  a ticket in the agent lane sitting in a draft column — either never
 *           refined, or sent back from the review gate by a human.
 * Does:     clones the repo, reads it, writes the story into the description.
 * Leaves:   ticket in the refinement-review column, awaiting human gate 1.
 *
 * The work itself is in handle.ts, which is deliberately importable without
 * starting the consume loop. This file only wires it to the queue.
 *
 * STATUS: complete for the happy path. The hand-back cases (draft too thin,
 * work too large to be one story) still report as ordinary failures.
 */

import { isRefineWorkItem } from '@cloud-harness/shared';

import { bootstrap } from '../runtime/consumer.js';
import { handleRefine } from './handle.js';

bootstrap({
  kind: 'refiner',
  queueUrlEnv: 'REFINER_QUEUE_URL',
  validate: isRefineWorkItem,
  handle: handleRefine,
});
