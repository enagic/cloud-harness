/**
 * Atlassian Document Format <-> plain text.
 *
 * Jira REST v3 does not take or return strings for rich-text fields: issue
 * descriptions come back as an ADF document tree, and comments must be posted
 * as one. Everything upstream of the Jira clients — TicketSnapshot.description,
 * TicketMutation.comment, RefinedStory — is plain text, so the conversion has
 * to happen right at the boundary.
 *
 * This is deliberately lossy and deliberately small. The pipeline's own writes
 * are the only content that has to survive a round trip intact, and the one
 * thing that must survive exactly is a fenced code block — that is where the
 * refined story's JSON payload rides (see parseRefinedStory). Human prose in a
 * description can lose its bold and its links without consequence; a mangled
 * code fence breaks the machine-readable contract between agents.
 */

/** An ADF node. Structural only — we never validate against the full schema. */
export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface AdfDocument {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

// ---------------------------------------------------------------------------
// ADF -> text
// ---------------------------------------------------------------------------

/**
 * Flatten an ADF document to plain text.
 *
 * Accepts `unknown` because this is fed straight from a JSON response: a field
 * may be null (empty description), a string (some endpoints and older data),
 * or a document. All three are normal and none of them should throw.
 */
export function adfToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';

  const doc = value as AdfNode;
  if (!Array.isArray(doc.content)) return doc.text ?? '';

  return doc.content
    .map((node) => blockToText(node, 0))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blockToText(node: AdfNode, depth: number): string {
  switch (node.type) {
    case 'paragraph':
      return inlineToText(node.content ?? []);

    case 'heading': {
      const level = Number(node.attrs?.['level'] ?? 1);
      return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${inlineToText(node.content ?? [])}`;
    }

    case 'codeBlock': {
      // The one construct that must round-trip exactly.
      const language = typeof node.attrs?.['language'] === 'string' ? node.attrs['language'] : '';
      return `\`\`\`${language}\n${inlineToText(node.content ?? [])}\n\`\`\``;
    }

    case 'blockquote':
      return (node.content ?? [])
        .map((child) => blockToText(child, depth))
        .join('\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');

    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      const indent = '  '.repeat(depth);
      return (node.content ?? [])
        .map((item, index) => {
          const marker = ordered ? `${index + 1}.` : '-';
          const body = (item.content ?? [])
            .map((child) => blockToText(child, depth + 1))
            .join('\n');
          // Only the first line takes the marker; continuation lines align under it.
          const [first = '', ...rest] = body.split('\n');
          const continued = rest.map((line) => `${indent}  ${line}`);
          return [`${indent}${marker} ${first}`, ...continued].join('\n');
        })
        .join('\n');
    }

    case 'rule':
      return '---';

    case 'mediaSingle':
    case 'mediaGroup':
      return '';

    default:
      // Unknown block: recurse if it has children, otherwise fall back to text.
      if (Array.isArray(node.content)) {
        return node.content.map((child) => blockToText(child, depth)).join('\n');
      }
      return node.text ?? '';
  }
}

function inlineToText(nodes: AdfNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text': {
          const text = node.text ?? '';
          const link = node.marks?.find((mark) => mark.type === 'link');
          const href = link?.attrs?.['href'];
          return typeof href === 'string' && href !== text ? `[${text}](${href})` : text;
        }
        case 'hardBreak':
          return '\n';
        case 'mention':
          return typeof node.attrs?.['text'] === 'string' ? node.attrs['text'] : '';
        case 'emoji':
          return typeof node.attrs?.['shortName'] === 'string' ? node.attrs['shortName'] : '';
        case 'inlineCard': {
          const url = node.attrs?.['url'];
          return typeof url === 'string' ? url : '';
        }
        default:
          return Array.isArray(node.content) ? inlineToText(node.content) : (node.text ?? '');
      }
    })
    .join('');
}

// ---------------------------------------------------------------------------
// text -> ADF
// ---------------------------------------------------------------------------

/**
 * Build an ADF document from plain text.
 *
 * Handles exactly two constructs: fenced code blocks and blank-line-separated
 * paragraphs. Anything else is emitted as literal paragraph text — a `**bold**`
 * we write will render as asterisks rather than bold, which is an acceptable
 * trade for never corrupting a payload we have to parse back out.
 *
 * ADF rejects empty text nodes, so blank paragraphs are dropped rather than
 * emitted; a document with none left still needs one node to be valid.
 */
export function textToAdf(text: string): AdfDocument {
  const content: AdfNode[] = [];
  // Split on fences, keeping them: odd indices are code block bodies.
  const segments = text.split(/```([\s\S]*?)```/g);

  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      // Inside a fence. The first line may be a language tag.
      const newline = segment.indexOf('\n');
      const firstLine = (newline === -1 ? segment : segment.slice(0, newline)).trim();
      const isLanguage = /^[a-zA-Z0-9_+-]{1,20}$/.test(firstLine);
      const language = isLanguage ? firstLine : '';
      // With a language tag the first line is consumed; without one the opening
      // fence still leaves a leading newline that is not part of the code.
      const body = (
        isLanguage && newline !== -1 ? segment.slice(newline + 1) : segment.replace(/^\n/, '')
      ).replace(/\n$/, '');

      const node: AdfNode = { type: 'codeBlock' };
      if (language) node.attrs = { language };
      if (body) node.content = [{ type: 'text', text: body }];
      content.push(node);
      return;
    }

    for (const block of segment.split(/\n{2,}/)) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      content.push({ type: 'paragraph', content: [{ type: 'text', text: trimmed }] });
    }
  });

  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [] });
  }

  return { type: 'doc', version: 1, content };
}
