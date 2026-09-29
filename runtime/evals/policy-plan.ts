// What the ledger will require acknowledged for an activation of `proposed` over `current`, and the
// current document's digest, from the runtime's own comparator (policy.ts): never a re-derivation.
// Usage: tsx runtime/evals/policy-plan.ts CURRENT.json PROPOSED.json
import { readFileSync } from 'node:fs';
import {
  comparePolicies,
  parsePolicy,
  policyDigest,
  weakeningCodes,
} from '../../services/local-runtime/src/autonomy/policy.js';

const [current, proposed] = process.argv
  .slice(2, 4)
  .map((file) => parsePolicy(JSON.parse(readFileSync(file, 'utf8'))));
if (!current || !proposed) throw new Error('usage: policy-plan.ts CURRENT.json PROPOSED.json');
process.stdout.write(
  `${JSON.stringify({
    currentSha256: policyDigest(current),
    weakenings: weakeningCodes(comparePolicies(current, proposed)),
  })}\n`,
);
