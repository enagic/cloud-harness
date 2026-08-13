/**
 * The pull request's diff, and the addresses a comment may be posted to.
 *
 * This exists because of something that was checked against live Bitbucket
 * rather than reasoned about, and it is the opposite of what HANDOFF decision 9
 * assumed. **Bitbucket does not reject a bad anchor.** An inline comment on line
 * 9999 of a one-line file comes back 201. So does one on a path that is not in
 * the pull request at all. The comment is created, it is attached to nothing a
 * human will ever scroll past, and the API's only tell is that `context_lines`
 * comes back empty — which the list endpoint then omits anyway.
 *
 * Decision 9's rule was "degrade when Bitbucket rejects the anchor". There is no
 * rejection to catch, and a model picking a plausible-but-absent line is an
 * ordinary failure rather than an exotic one. So the check moves in front of the
 * write: the diff says which addresses exist, and a finding whose address is not
 * one of them degrades line → file → pull request *before* it is posted. The
 * rule survives; what changed is that this file has to enforce it.
 *
 * The diff is the three-dot diff — computed from the merge base, which is what
 * the pull request page shows and therefore what the line numbers on it mean.
 */

/** What the diff says about one file. */
export interface DiffFile {
  /** The path a comment anchors to: the new path, or the old one for a deletion. */
  path: string;
  status: 'added' | 'modified' | 'removed';
  /**
   * Line numbers in the *new* file that an inline comment can address.
   *
   * Added and context lines both, because both are visible on the diff and a
   * finding about an unchanged line next to a change is a legitimate thing to
   * say. Only the added case is verified live; the context case is the
   * conservative-looking choice that is actually the risky one, so if orphaned
   * comments ever turn up on unchanged lines, narrow this to additions.
   *
   * Empty for a removed file — its lines exist only on the `from` side, which
   * this does not index, so findings about it degrade to file-level.
   */
  lines: Set<number>;
}

export type AnchorTier = 'line' | 'file' | 'pull_request';

/**
 * Where a finding will actually be posted, and what it lost on the way.
 *
 * `note` is prose for the comment body, not a flag: when a finding cannot be
 * posted where it was aimed, the human reading it should be told where it was
 * meant to go. Silence there is how a blocker becomes invisible.
 */
export interface ResolvedAnchor {
  tier: AnchorTier;
  path?: string;
  line?: number;
  note?: string;
}

const HUNK = /^@@+ (?:-\d+(?:,\d+)? )?\+(\d+)(?:,(\d+))? @@/;

/**
 * Index a unified diff by path.
 *
 * Written against Bitbucket's own output rather than against git's in general:
 * paths come off the `---` / `+++` lines because `diff --git a/x b/y` is
 * genuinely ambiguous for a path containing a space, and the marker lines are
 * not.
 */
export function parseDiff(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();

  let oldPath: string | undefined;
  let newPath: string | undefined;
  let current: DiffFile | undefined;
  let cursor = 0;

  const commit = (): void => {
    // `--- /dev/null` is an addition, `+++ /dev/null` a deletion.
    const path = newPath ?? oldPath;
    if (path === undefined) return;

    const status: DiffFile['status'] =
      newPath === undefined ? 'removed' : oldPath === undefined ? 'added' : 'modified';

    current = { path, status, lines: new Set<number>() };
    files.set(path, current);
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // A new file section. Everything from the previous one is already
      // recorded; reset so a section without markers cannot inherit them.
      oldPath = undefined;
      newPath = undefined;
      current = undefined;
      continue;
    }

    if (line.startsWith('--- ')) {
      const value = stripMarker(line.slice(4), 'a/');
      oldPath = value;
      continue;
    }

    if (line.startsWith('+++ ')) {
      newPath = stripMarker(line.slice(4), 'b/');
      commit();
      continue;
    }

    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      cursor = Number(hunk[1]);
      continue;
    }

    if (current === undefined) continue;

    // Inside a hunk. Only the new-file side advances the cursor, and only lines
    // that exist in the new file get an address.
    if (line.startsWith('+')) {
      current.lines.add(cursor);
      cursor += 1;
    } else if (line.startsWith(' ')) {
      current.lines.add(cursor);
      cursor += 1;
    }
    // '-' consumes an old-file line and no new-file one; '\ No newline at end
    // of file' and the blank line between sections are neither.
  }

  return files;
}

/** `a/src/index.js` -> `src/index.js`; `/dev/null` -> undefined. */
function stripMarker(value: string, prefix: string): string | undefined {
  // Some producers append a tab and a timestamp. Bitbucket does not, but a diff
  // this ever gets handed from elsewhere might.
  const path = (value.split('\t')[0] ?? '').trim();
  if (path === '/dev/null' || path === '') return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Take the tightest tier that is actually true of this diff.
 *
 * The reviewer aims a finding at a path and a line; this decides where it can
 * really go. Degrading outward is always available and always better than the
 * alternative, which is not a rejection — it is a comment posted into the void.
 */
export function resolveAnchor(
  files: Map<string, DiffFile>,
  requested: { path?: string | undefined; line?: number | undefined },
): ResolvedAnchor {
  const { path, line } = requested;

  if (path === undefined || path.trim() === '') {
    return { tier: 'pull_request' };
  }

  const cleaned = path.trim().replace(/^\.?\/+/, '');
  const file = files.get(cleaned);

  if (file === undefined) {
    return {
      tier: 'pull_request',
      note: `This was meant for \`${cleaned}\`, which this pull request does not change.`,
    };
  }

  if (line === undefined) {
    return { tier: 'file', path: file.path };
  }

  if (file.lines.has(line)) {
    return { tier: 'line', path: file.path, line };
  }

  return {
    tier: 'file',
    path: file.path,
    note:
      `This was meant for line ${line}, which is not part of this pull request's ` +
      `diff of \`${file.path}\`, so it is posted against the file instead.`,
  };
}

/**
 * A compact map of the change for the model's prompt.
 *
 * The full diff goes in as well; this is the index that makes it navigable, and
 * it is also the only place the model is told which lines it may address. A
 * model that knows the rule up front degrades fewer findings than one that finds
 * out afterwards.
 */
export function describeDiff(files: Map<string, DiffFile>): string {
  if (files.size === 0) return 'This pull request changes no files.';

  return [...files.values()]
    .map((file) => {
      const addresses = [...file.lines].sort((a, b) => a - b);
      if (addresses.length === 0) {
        return `${file.path} (${file.status}) — no commentable lines`;
      }
      return `${file.path} (${file.status}) — commentable lines ${summariseRanges(addresses)}`;
    })
    .join('\n');
}

/** [1,2,3,7,8] -> "1-3, 7-8". Whole-number ranges read better than 400 integers. */
function summariseRanges(sorted: number[]): string {
  const ranges: string[] = [];
  let start = sorted[0]!;
  let previous = start;

  for (const value of sorted.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = value;
    previous = value;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);

  return ranges.join(', ');
}
