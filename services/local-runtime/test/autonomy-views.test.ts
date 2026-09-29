import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandFailureReason, costView } from '../src/autonomy/views.js';
import { ConfigurationError } from '../src/config.js';

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

test('commandFailureReason names refusals and configuration errors, never arbitrary messages', () => {
  assert.equal(commandFailureReason({ reason: 'scope_revoked' }), 'scope_revoked');
  assert.equal(
    commandFailureReason(
      new ConfigurationError(
        'base_publication_requires_FACTORY_PUBLICATION_SECRETLESS_CI_attested',
      ),
    ),
    'base_publication_requires_FACTORY_PUBLICATION_SECRETLESS_CI_attested',
  );
  // A plain Error's message is never printed, even when it is a single token.
  assert.equal(
    commandFailureReason(new Error('ghs_abcdefghijklmnopqrstuvwxyz0123456789ab')),
    'autonomy_command_failed',
  );
  assert.equal(commandFailureReason(new Error('worker_busy')), 'autonomy_command_failed');
  assert.equal(
    commandFailureReason(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
    'autonomy_command_failed',
  );
  assert.equal(commandFailureReason({ reason: 'x'.repeat(200) }), 'autonomy_command_failed');
  assert.equal(commandFailureReason(undefined), 'autonomy_command_failed');
});
