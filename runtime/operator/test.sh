#!/bin/sh
# Synthetic integration on a fresh, private installation. No host Python/Node.
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
export SFAC_STATE_DIR
SFAC_STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/factory-operator-test.XXXXXX")
cleanup() {
  # A failed probe must not keep the stack alive: the probe container blocks `down`, the retired file blocks sfac.
  if [ -n "${review_runtime:-}" ]; then docker rm -f "$review_runtime" >/dev/null 2>&1 || true; fi
  rm -f "$SFAC_STATE_DIR/merge-policy.json"
  if [ -L "$SFAC_STATE_DIR/merge-policy" ]; then rm "$SFAC_STATE_DIR/merge-policy"; fi
  # A symlinked or missing policy file (a failed refusal step) would make sfac refuse `down`.
  if [ -L "$SFAC_STATE_DIR/merge-policy/merge-policy.json" ]; then rm "$SFAC_STATE_DIR/merge-policy/merge-policy.json"; fi
  if [ -d "$SFAC_STATE_DIR/merge-policy" ] && [ ! -f "$SFAC_STATE_DIR/merge-policy/merge-policy.json" ]; then rm -rf "$SFAC_STATE_DIR/merge-policy"; fi
  if [ -f "$SFAC_STATE_DIR/.env" ]; then "$root/sfac" down --volumes; fi
  if [ -f "$SFAC_STATE_DIR/project" ]; then
    "$root/sfac" clean-images
  fi
  rm -rf "$SFAC_STATE_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Fail if this flow accidentally invokes a host language runtime.
mkdir "$SFAC_STATE_DIR/no-host-languages"
for tool in node npm python python3; do
  printf '#!/bin/sh\necho "Unexpected host language runtime" >&2\nexit 97\n' > "$SFAC_STATE_DIR/no-host-languages/$tool"
  chmod +x "$SFAC_STATE_DIR/no-host-languages/$tool"
done
PATH="$SFAC_STATE_DIR/no-host-languages:$PATH"
export PATH
cd "$root"
# Demo with bounded autonomy enabled: fixture adapters, no publisher, no credentials.
./sfac init --mode demo --autonomy --port "${FACTORY_TEST_PORT:-18789}"
./sfac build
./sfac up
if ./sfac clean-images; then echo 'Active installation images were removed' >&2; exit 1; fi
./sfac ready | grep '"ready":true'
./sfac demo
count=0
until ./sfac demo-status | grep 'fixture_completed_no_external_effect'; do
  count=$((count + 1)); [ "$count" -lt 20 ]; sleep 1
done
./sfac demo-source input
./sfac worker run input/job.json output input/source.tar.gz | grep '"testsStatus":"passed","cached":false'
./sfac worker run input/job.json cached input/source.tar.gz | grep '"cached":true'
./sfac worker cancel nonexistent-job | grep '"requested":0'
./sfac recovery inspect
./sfac worker recover
./sfac verify-database > "$SFAC_STATE_DIR/before.json"
./sfac backup demo.dump
if ./sfac backup demo.dump; then echo 'Backup overwrite was allowed' >&2; exit 1; fi
./sfac restore-check demo.dump > "$SFAC_STATE_DIR/restored.json"
cmp "$SFAC_STATE_DIR/before.json" "$SFAC_STATE_DIR/restored.json"
./sfac stop
./sfac up
./sfac verify-database > "$SFAC_STATE_DIR/restarted.json"
cmp "$SFAC_STATE_DIR/before.json" "$SFAC_STATE_DIR/restarted.json"
project=$(cat "$SFAC_STATE_DIR/project")
# Check actual receipt bytes with the image's Node, never a host interpreter.
docker run --rm --network none --read-only --user "$(id -u):$(id -g)" --cap-drop ALL --mount "type=bind,src=$SFAC_STATE_DIR/artifacts,dst=/artifacts,readonly" --entrypoint node "$project-operator:development" -e '
const fs = require("node:fs"), assert = require("node:assert/strict");
const r = JSON.parse(fs.readFileSync("/artifacts/output/result.json"));
assert.equal(r.outcome.ok, true);
assert.equal(r.outcome.testsStatus, "passed");
assert.doesNotMatch(r.outcome.patch, /__pycache__|\.pyc/);
assert.match(r.outcome.patch, /a \+ b/);
assert.deepEqual(r.outcome.testSideEffects, {modifiedPaths:[],generatedPaths:[]});
assert.equal(fs.statSync("/artifacts/demo.dump").mode & 0o777, 0o600);
console.log("Container operator integration passed; no host Python/Node used.");'

# Bounded autonomy in demo mode: fixture reviewer, no publisher, real sandboxes. The
# pipeline must stop at a recorded decision, never at an external effect.
cp -R "$root/examples/autonomy-demo/acceptance" "$SFAC_STATE_DIR/acceptance"
cp "$root/examples/autonomy-demo/task.json" "$SFAC_STATE_DIR/artifacts/input/task.json"
# The policy mount must exist before pin runs; the template's placeholders are replaced below.
cp "$root/examples/autonomy-demo/autonomy-policy.json" "$SFAC_STATE_DIR/autonomy-policy.json"
chmod 600 "$SFAC_STATE_DIR/autonomy-policy.json"
./sfac autonomy pin --env > "$SFAC_STATE_DIR/pins.env"
suite=$(sed -n 's/^ACCEPTANCE_SUITE_SHA256=//p' "$SFAC_STATE_DIR/pins.env")
harness=$(sed -n 's/^ACCEPTANCE_HARNESS_SHA256=//p' "$SFAC_STATE_DIR/pins.env")
runner=$(sed -n 's/^ACCEPTANCE_RUNNER_IMAGE=//p' "$SFAC_STATE_DIR/pins.env")
reviewer=$(sed -n 's/^REVIEWER_CONFIG_SHA256=//p' "$SFAC_STATE_DIR/pins.env")
[ -n "$suite" ] && [ -n "$harness" ] && [ -n "$runner" ] && [ -n "$reviewer" ]
sed -e "s/__SUITE__/$suite/" -e "s/__HARNESS__/$harness/" -e "s/__RUNNER__/$runner/" -e "s/__REVIEWER__/$reviewer/" "$root/examples/autonomy-demo/autonomy-policy.json" > "$SFAC_STATE_DIR/autonomy-policy.json"
chmod 600 "$SFAC_STATE_DIR/autonomy-policy.json"
if ./sfac autonomy activate; then echo 'Activation without acknowledgement was accepted' >&2; exit 1; fi
./sfac autonomy activate --acknowledge 'initial_activation,mode_changed:human_gated->bounded' | grep '"activated"'
# A grant binds the Task to the intent the owner reviewed; a stale digest blocks execution.
intent=$(./sfac autonomy intent 1 --task-file input/task.json | sed -n 's/.*"intentSha256":"\([0-9a-f]*\)".*/\1/p')
[ "${#intent}" = 64 ]
./sfac autonomy grant --scope demo-stale --tasks "I_DEMO_TASK=$(printf '%064d' 0)" --budget-usd 1 --max-runs 2 --expires-hours 1 | grep '"scopeId":"demo-stale"'
./sfac autonomy run 1 --scope demo-stale --task-file input/task.json --archive input/source.tar.gz > "$SFAC_STATE_DIR/artifacts/autonomy-stale.json" || true
grep '"state":"blocked"' "$SFAC_STATE_DIR/artifacts/autonomy-stale.json"
grep 'scope_intent_mismatch' "$SFAC_STATE_DIR/artifacts/autonomy-stale.json"
./sfac autonomy grant --scope demo --tasks "I_DEMO_TASK=$intent" --budget-usd 1 --max-runs 2 --expires-hours 1 | grep '"scopeId":"demo"'
./sfac autonomy run 1 --scope demo --new-attempt --task-file input/task.json --archive input/source.tar.gz > "$SFAC_STATE_DIR/artifacts/autonomy-run.json" || true
cat "$SFAC_STATE_DIR/artifacts/autonomy-run.json"
grep '"state":"held"' "$SFAC_STATE_DIR/artifacts/autonomy-run.json"
grep '"reason":"publication_disabled"' "$SFAC_STATE_DIR/artifacts/autonomy-run.json"
grep '"action":"execute","outcome":"allow"' "$SFAC_STATE_DIR/artifacts/autonomy-run.json"
grep '"action":"publish","outcome":"allow"' "$SFAC_STATE_DIR/artifacts/autonomy-run.json"
# The run record's bytes, checked with the image's Node: the decision stopped at a hold.
docker run --rm --network none --read-only --user "$(id -u):$(id -g)" --cap-drop ALL --mount "type=bind,src=$SFAC_STATE_DIR/artifacts,dst=/artifacts,readonly" --entrypoint node "$project-operator:development" -e '
const fs = require("node:fs"), assert = require("node:assert/strict");
const a = JSON.parse(fs.readFileSync("/artifacts/autonomy-run.json"));
assert.equal(a.state, "held");
assert.match(a.tree, /^[0-9a-f]{40}$/);
assert.equal(a.publication, null);
console.log("Autonomy demo run held at the recorded decision; no external effect.");'
./sfac autonomy status | grep '"state":"held"'
# Automatic merge is live-only: the demo refuses before touching anything.
if ./sfac autonomy merge 1 --task-file input/task.json --archive input/source.tar.gz 2> "$SFAC_STATE_DIR/artifacts/merge-refusal.txt"; then echo 'Demo merge was accepted' >&2; exit 1; fi
grep -q 'automerge_requires_live_mode' "$SFAC_STATE_DIR/artifacts/merge-refusal.txt"
./sfac autonomy recover | grep '"recovered"'
[ -z "$(docker ps -aq --filter label=io.software-factory.autonomy-run)" ]

# Synthetic credentials test the live mount boundary without any provider request.
printf 'synthetic-app-canary\n' > "$SFAC_STATE_DIR/secrets/app_private_key"
printf 'synthetic-model-canary\n' > "$SFAC_STATE_DIR/secrets/model_key"
printf 'synthetic-publisher-canary\n' > "$SFAC_STATE_DIR/secrets/publisher_private_key"
printf 'synthetic-merger-canary\n' > "$SFAC_STATE_DIR/secrets/merger_private_key"
mkdir -p "$SFAC_STATE_DIR/merge-policy"
printf '{}\n' > "$SFAC_STATE_DIR/merge-policy/merge-policy.json"
export FACTORY_STATE_DIR="$SFAC_STATE_DIR"
export FACTORY_OPERATOR_IMAGE="$project-operator:development"
export FACTORY_LOCAL_IMAGE="$project-local:development"
export FACTORY_WORKER_IMAGE="$project-worker:development"
for role in operator probe database-operator demo-operator github-operator supervisor demo-supervisor live-supervisor autonomy-operator demo-autonomy-supervisor live-autonomy-supervisor live-automerge-supervisor; do
  docker compose --project-directory "$root/runtime" --env-file "$SFAC_STATE_DIR/.env" -p "$project" -f "$root/runtime/compose.yaml" -f "$root/runtime/compose.operator.yaml" -f "$root/runtime/compose.operator-review.yaml" run --rm --no-deps -T --entrypoint node "$role" /app/runtime/operator/assert-boundary.mjs "$role"
done
# The long-running runtime mounts the policy directory: an edit that replaces the file (rename over
# it, as an editor's atomic save does) reaches the running container. A file mount would keep the old inode.
review_runtime=$(docker compose --project-directory "$root/runtime" --env-file "$SFAC_STATE_DIR/.env" -p "$project" -f "$root/runtime/compose.yaml" -f "$root/runtime/compose.operator.yaml" -f "$root/runtime/compose.review.yaml" run -d --no-deps --entrypoint node runtime -e 'setTimeout(() => {}, 120000)')
printf '{"replaced":true}\n' > "$SFAC_STATE_DIR/merge-policy/merge-policy.json.next"
mv "$SFAC_STATE_DIR/merge-policy/merge-policy.json.next" "$SFAC_STATE_DIR/merge-policy/merge-policy.json"
docker exec "$review_runtime" node -e 'const fs = require("fs"); if (fs.readdirSync("/run/config").join() !== "merge-policy.json" || !fs.readFileSync("/run/config/merge-policy.json", "utf8").includes("replaced")) process.exit(1)'
docker rm -f "$review_runtime" >/dev/null
review_runtime=
# A policy in the state root is the retired layout: refused, never silently ignored.
printf '{}\n' > "$SFAC_STATE_DIR/merge-policy.json"
if ./sfac ps 2> "$SFAC_STATE_DIR/artifacts/policy-refusal.txt"; then echo 'A merge policy in the state root was accepted' >&2; exit 1; fi
grep -q 'the review services mount the merge-policy/ directory' "$SFAC_STATE_DIR/artifacts/policy-refusal.txt"
rm "$SFAC_STATE_DIR/merge-policy.json"
# A symlinked policy would dangle inside the containers: refused too.
mv "$SFAC_STATE_DIR/merge-policy/merge-policy.json" "$SFAC_STATE_DIR/artifacts/policy.json"
ln -s "$SFAC_STATE_DIR/artifacts/policy.json" "$SFAC_STATE_DIR/merge-policy/merge-policy.json"
if ./sfac ps 2> "$SFAC_STATE_DIR/artifacts/policy-refusal.txt"; then echo 'A symlinked merge policy was accepted' >&2; exit 1; fi
grep -q 'holds no regular file merge-policy.json' "$SFAC_STATE_DIR/artifacts/policy-refusal.txt"
rm "$SFAC_STATE_DIR/merge-policy/merge-policy.json"
mv "$SFAC_STATE_DIR/artifacts/policy.json" "$SFAC_STATE_DIR/merge-policy/merge-policy.json"
# A dangling directory symlink would silently drop the review overlays: refused.
mv "$SFAC_STATE_DIR/merge-policy" "$SFAC_STATE_DIR/merge-policy.real"
ln -s "$SFAC_STATE_DIR/absent" "$SFAC_STATE_DIR/merge-policy"
if ./sfac ps 2> "$SFAC_STATE_DIR/artifacts/policy-refusal.txt"; then echo 'A dangling merge-policy directory was accepted' >&2; exit 1; fi
grep -q 'holds no regular file merge-policy.json' "$SFAC_STATE_DIR/artifacts/policy-refusal.txt"
rm "$SFAC_STATE_DIR/merge-policy"
mv "$SFAC_STATE_DIR/merge-policy.real" "$SFAC_STATE_DIR/merge-policy"
./sfac down --volumes
./sfac clean-images
for component in operator local worker; do
  if docker image inspect "$project-$component:development" >/dev/null 2>&1; then echo 'Installation tag remains' >&2; exit 1; fi
done
[ -f "$SFAC_STATE_DIR/.env" ] && [ -f "$SFAC_STATE_DIR/artifacts/demo.dump" ]
echo 'Scoped image cleanup passed; configuration and backup retained.'
