import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adfToText, textToAdf } from './adf.js';

describe('adfToText', () => {
  it('tolerates the empty shapes Jira actually returns', () => {
    assert.equal(adfToText(null), '');
    assert.equal(adfToText(undefined), '');
    assert.equal(adfToText('already a string'), 'already a string');
    assert.equal(adfToText({ type: 'doc', version: 1, content: [] }), '');
  });

  it('flattens paragraphs and headings', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Context' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'The login page is slow.' }] },
      ],
    };
    assert.equal(adfToText(doc), '## Context\n\nThe login page is slow.');
  });

  it('renders links as markdown, not bare text', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see ' },
            {
              type: 'text',
              text: 'the PR',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/pr/1' } }],
            },
          ],
        },
      ],
    };
    assert.equal(adfToText(doc), 'see [the PR](https://example.com/pr/1)');
  });

  it('keeps nested list structure', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
            },
          ],
        },
      ],
    };
    assert.equal(adfToText(doc), '- first\n- second');
  });

  it('does not throw on unknown node types', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
        { type: 'someFutureThing', text: 'fallback' },
      ],
    };
    assert.equal(adfToText(doc), 'hi\n\nfallback');
  });
});

describe('textToAdf', () => {
  it('splits on blank lines and drops empty paragraphs', () => {
    const doc = textToAdf('one\n\n\n\ntwo');
    assert.equal(doc.content.length, 2);
    assert.equal(doc.content[0]?.content?.[0]?.text, 'one');
    assert.equal(doc.content[1]?.content?.[0]?.text, 'two');
  });

  it('always produces at least one node, since ADF rejects an empty doc', () => {
    const doc = textToAdf('   ');
    assert.equal(doc.content.length, 1);
    assert.equal(doc.content[0]?.type, 'paragraph');
  });

  it('extracts the language tag from a fence', () => {
    const doc = textToAdf('```json\n{"a":1}\n```');
    const block = doc.content[0];
    assert.equal(block?.type, 'codeBlock');
    assert.equal(block?.attrs?.['language'], 'json');
    assert.equal(block?.content?.[0]?.text, '{"a":1}');
  });

  it('treats a fence with no language as plain code', () => {
    const doc = textToAdf('```\nnot a language tag here\n```');
    const block = doc.content[0];
    assert.equal(block?.type, 'codeBlock');
    assert.equal(block?.attrs, undefined);
    assert.equal(block?.content?.[0]?.text, 'not a language tag here');
  });
});

describe('round trip', () => {
  // The contract that matters: the refined story rides in a fenced JSON block,
  // written by the refiner and parsed back by the implementer and reviewer. If
  // this loses so much as a newline, the agents stop understanding each other.
  it('preserves a fenced JSON payload exactly', () => {
    const payload = JSON.stringify(
      {
        title: 'Add rate limiting',
        acceptanceCriteria: ['429 after 100 req/min', 'Retry-After header set'],
        codeContext: { relevantPaths: ['src/middleware/limit.ts'], notes: 'reuse the redis client' },
      },
      null,
      2,
    );
    const original = `## Refined story\n\nSome prose a human might edit.\n\n\`\`\`json\n${payload}\n\`\`\``;

    const recovered = adfToText(textToAdf(original));
    const fence = /```json\n([\s\S]*?)\n```/.exec(recovered);

    assert.ok(fence, 'fenced json block survived the round trip');
    assert.equal(fence[1], payload);
    assert.deepEqual(JSON.parse(fence[1]!), JSON.parse(payload));
  });

  it('survives prose around the fence being reflowed', () => {
    const original = 'intro\n\n```json\n{"k":"v"}\n```\n\noutro';
    const recovered = adfToText(textToAdf(original));
    assert.match(recovered, /^intro/);
    assert.match(recovered, /outro$/);
    assert.match(recovered, /```json\n\{"k":"v"\}\n```/);
  });
});
