import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outcomeEvidence, runLimits } from '../src/worker/records.js';
test('run limits reject unbounded overrides and missing accounting remains unavailable', () => {
  for (const env of [
    { FACTORY_MAX_TASK_RUNS: '0' },
    { FACTORY_MAX_RUN_TURNS: '61' },
    { FACTORY_MAX_RUN_MS: 'Infinity' },
    { FACTORY_MAX_RUN_BUDGET_USD: 'NaN' },
  ])
    assert.throws(() => runLimits(env), /invalid_run_limit/);
  assert.equal(runLimits().maxTaskRuns, 4);
  assert.equal(outcomeEvidence().cost.estimatedUsd, null);
  assert.equal(outcomeEvidence().cost.billedUsd, null);
});
