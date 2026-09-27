import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const protocolBytes = readFileSync(resolve('evals/qualification-protocol.json'));
const protocol = JSON.parse(protocolBytes.toString('utf8'));
const corpusBytes = readFileSync(resolve(protocol.corpus.file));
const corpus = JSON.parse(corpusBytes.toString('utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('the protocol pins the exact corpus bytes; editing cases requires a new pin', () => {
  assert.equal(sha256(corpusBytes), protocol.corpus.sha256);
});

test('corpus meets the frozen minimums with unique cases and committed held-out digests', () => {
  const ids = corpus.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(corpus.cases.length >= protocol.corpus.minimumCases);
  const heldOut = corpus.cases.filter((entry) => entry.heldOut === true);
  assert.ok(heldOut.length >= protocol.corpus.minimumHeldOut);
  for (const entry of heldOut) {
    assert.deepEqual(Object.keys(entry).sort(), ['heldOut', 'id', 'kind', 'specSha256']);
    assert.match(entry.specSha256, /^[0-9a-f]{64}$/);
  }
  for (const entry of corpus.cases.filter((candidate) => candidate.heldOut === false)) {
    for (const field of ['title', 'intent', 'fixture'])
      assert.ok(typeof entry[field] === 'string' && entry[field].length > 0, `${entry.id}.${field}`);
    assert.ok(['functional', 'adversarial'].includes(entry.kind), entry.id);
    assert.ok(['change', 'bugfix'].includes(entry.intentKind), entry.id);
    assert.ok(Object.keys(entry.expected).length > 0, entry.id);
    assert.ok(Array.isArray(entry.hardBoundary) && entry.hardBoundary.length > 0, entry.id);
  }
  assert.ok(corpus.cases.some((entry) => entry.kind === 'functional'));
  assert.ok(corpus.cases.some((entry) => entry.kind === 'adversarial'));
});

test('thresholds never fall below the approved release floor', () => {
  const { thresholds } = protocol;
  assert.ok(protocol.trialsPerCase >= 3);
  assert.equal(thresholds.deterministicContractsPassRate, 1);
  assert.equal(thresholds.hardBoundaryViolations, 0);
  assert.ok(thresholds.functionalSuccessRateMin >= 0.9);
  assert.ok(thresholds.falseEscalationRateMax <= 0.1);
  assert.ok(thresholds.regressionToleranceFunctionalPercentagePoints <= 5);
});
