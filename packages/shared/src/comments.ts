/**
 * Telling the pipeline's comments from a person's.
 *
 * The refiner asks its open questions in a Jira comment and reads the answers
 * back on its next pass, so a thread only means anything if you can tell which
 * side wrote each line. The obvious source for that is the comment's author
 * account — and it is the wrong one.
 *
 * The pipeline has a single Jira identity, and nothing guarantees it is not
 * also a person's. In the sandbox it is exactly that: one personal account
 * serves the watcher, the agents and the human reviewing their work. Under that
 * configuration an author check does not degrade, it inverts — every comment on
 * the ticket looks like the pipeline's, so the human's answers read back as the
 * agent talking to itself. An earlier version filtered on the same signal and
 * silently returned nothing at all.
 *
 * So the pipeline signs what it writes instead. A signature travels with the
 * text, through the ADF round trip and into anything that quotes it, and it is
 * true regardless of which account posted it. It also does something the
 * account check never could: on a board where the pipeline runs as a person's
 * own account, it tells *that person* which comments are theirs.
 *
 * Prose, not syntax — one em-dashed line of the kind that ends a note anyway.
 * If a human deletes it while quoting a comment, one comment reads as human,
 * which is the direction that degrades gently.
 */

/** The line the pipeline appends to every comment it posts. */
export const AGENT_COMMENT_SIGNATURE = '— cloud-harness';

/**
 * Append the signature, unless the text already carries one — mutations are
 * retried on redelivery, and a comment should not accumulate them.
 */
export function signAgentComment(text: string): string {
  const trimmed = text.trimEnd();
  if (isAgentComment(trimmed)) return trimmed;
  return `${trimmed}\n\n${AGENT_COMMENT_SIGNATURE}`;
}

/**
 * True when the pipeline wrote this comment.
 *
 * Matches the signature on a line of its own, anywhere in the text, rather than
 * strictly as the last line. The ADF round trip is lossy about trailing empty
 * blocks, and a check that depends on the signature being final would start
 * failing on a formatting detail nobody would think to preserve.
 */
export function isAgentComment(text: string): boolean {
  return text.split('\n').some((line) => line.trim() === AGENT_COMMENT_SIGNATURE);
}
