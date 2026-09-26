import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectDocBlocks,
  extractMermaidBlocks,
  findDrift,
  normalizeBlock,
} from './doc-pr-sync.mjs';

const DIAGRAM = 'flowchart TD\n    A --> B';
const block = (body) => '```mermaid\n' + body + '\n```';

test('normalizeBlock strips trailing whitespace and edge blank lines', () => {
  assert.equal(normalizeBlock('\n\nflowchart TD   \n    A --> B\t\n\n'), 'flowchart TD\n    A --> B');
});

test('extractMermaidBlocks finds blocks and content', () => {
  const blocks = extractMermaidBlocks(`# doc\n\n${block(DIAGRAM)}\n\ntext`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, DIAGRAM);
  assert.equal(blocks[0].local, false);
});

test('extractMermaidBlocks detects the sf:diagram-local marker', () => {
  const md = `intro\n<!-- sf:diagram-local -->\n${block(DIAGRAM)}`;
  assert.equal(extractMermaidBlocks(md)[0].local, true);
});

test('findDrift: matching block is clean', () => {
  const docs = collectDocBlocks([`adr\n${block(DIAGRAM)}`]);
  assert.deepEqual(findDrift(`PR body\n${block(DIAGRAM)}`, docs), []);
});

test('findDrift: drifted block is flagged (the #39 case)', () => {
  const docs = collectDocBlocks([`adr\n${block('flowchart TD\n    A --> C')}`]); // doc updated
  const findings = findDrift(`PR body (stale)\n${block(DIAGRAM)}`, docs); // PR not synced
  assert.equal(findings.length, 1);
  assert.equal(findings[0], 'flowchart TD');
});

test('findDrift: PR-only block with sf:diagram-local is allowed', () => {
  const docs = collectDocBlocks(['adr with no diagrams']);
  const prBody = `PR-only\n<!-- sf:diagram-local -->\n${block(DIAGRAM)}`;
  assert.deepEqual(findDrift(prBody, docs), []);
});

test('findDrift: whitespace-only differences do not count as drift', () => {
  const docs = collectDocBlocks([block('flowchart TD\n    A --> B')]);
  const prBody = block('flowchart TD   \n    A --> B'); // trailing spaces
  assert.deepEqual(findDrift(prBody, docs), []);
});

test('findDrift: PR with no diagrams is clean', () => {
  assert.deepEqual(findDrift('just prose, no diagrams', collectDocBlocks([])), []);
});
