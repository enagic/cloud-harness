/**
 * Atlassian Document Format <-> markdown.
 *
 * Jira REST v3 does not take or return strings for rich-text fields: issue
 * descriptions come back as an ADF document tree, and comments must be posted
 * as one. Everything upstream of the Jira clients — TicketSnapshot.description,
 * TicketMutation.comment, the refiner's story — is markdown, so the
 * conversion has to happen right at the boundary.
 *
 * The conversion itself is delegated to `extended-markdown-adf-parser`
 * rather than hand-rolled: real ADF documents contain more than headings,
 * paragraphs and code fences (tables, panels, mentions, links with titles),
 * and a bidirectional library round-trips all of it, not just the constructs
 * we thought to write a case for. The library encodes ADF-only constructs it
 * can't express in plain markdown (panels, mentions, unknown node types) as
 * fenced blocks or HTML comments carrying the original node's JSON — noisy
 * for a human to read raw, but exact for the machine-to-machine trip this
 * text actually makes (Jira -> refiner/implementer prompt -> Jira).
 */

import { Parser } from 'extended-markdown-adf-parser';
import type { ADFDocument, ADFNode } from 'extended-markdown-adf-parser';

export type AdfNode = ADFNode;
export type AdfDocument = ADFDocument;

const parser = new Parser();

// ---------------------------------------------------------------------------
// ADF -> markdown
// ---------------------------------------------------------------------------

/**
 * Flatten an ADF document to markdown.
 *
 * Accepts `unknown` because this is fed straight from a JSON response: a field
 * may be null (empty description), a string (some endpoints and older data —
 * the library only understands document objects, so this is handled before
 * it ever sees one), or a document. All three are normal and none of them
 * should throw.
 */
export function adfToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';

  return parser.adfToMarkdown(value as AdfDocument).trim();
}

// ---------------------------------------------------------------------------
// markdown -> ADF
// ---------------------------------------------------------------------------

/**
 * Build an ADF document from markdown.
 *
 * ADF rejects an empty content array, so blank input — which the library
 * otherwise turns into a doc with no nodes — gets a single empty paragraph
 * instead, same as an empty doc needs one node to be valid.
 */
export function textToAdf(text: string): AdfDocument {
  const doc = parser.markdownToAdf(text);
  if (doc.content.length === 0) {
    doc.content.push({ type: 'paragraph', content: [] });
  }
  return doc;
}
