import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costView } from '../src/autonomy/views.js';

test('costView exposes the SDK estimate and the reviewer usage from the run evidence', () => {
  const view = costView({
    evidence: {
      estimatedUsd: 0.1234,
      reviewUsage: { input_tokens: 1200, output_tokens: 80, service_tier: 'standard' },
      patchSha256: 'x',
    },
  });
  assert.deepEqual(view, {
    estimatedUsd: 0.1234,
    reviewUsage: { input_tokens: 1200, output_tokens: 80 },
  });
});

test('costView reports null, never a number it cannot vouch for', () => {
  assert.deepEqual(costView({ evidence: {} }), { estimatedUsd: null, reviewUsage: null });
  assert.deepEqual(costView({ evidence: { estimatedUsd: Number.NaN, reviewUsage: [1] } }), {
    estimatedUsd: null,
    reviewUsage: null,
  });
  assert.deepEqual(costView({ evidence: { estimatedUsd: -1, reviewUsage: 'usage' } }), {
    estimatedUsd: null,
    reviewUsage: null,
  });
  assert.deepEqual(
    costView({ evidence: { estimatedUsd: '0.5', reviewUsage: { input_tokens: -5, n: 1 } } }),
    { estimatedUsd: null, reviewUsage: { n: 1 } },
  );
});
