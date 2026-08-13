/**
 * Code reviewer agent.
 *
 * Trigger:  ticket enters the code-review status.
 * Does:     reads the pull request's diff and its existing comment threads,
 *           checks out the branch, runs the repository's own suite, and reports
 *           each finding as its own comment anchored at the code.
 * Leaves:   either the changes-requested status (back to the implementer,
 *           spending an attempt) or the awaiting-merge status with the pull
 *           request approved (human gate 2).
 *
 * Nothing but the bootstrap lives here. The work is in handle.ts, so it can be
 * driven against a real ticket without starting the SQS consume loop — the same
 * split the refiner and implementer use, for the same reason.
 */

import { isReviewWorkItem } from '@cloud-harness/shared';

import { bootstrap } from '../runtime/consumer.js';
import { handleReview } from './handle.js';

bootstrap({
  kind: 'reviewer',
  queueUrlEnv: 'REVIEWER_QUEUE_URL',
  validate: isReviewWorkItem,
  handle: handleReview,
});
