#!/bin/sh
# Synthetic integration on a fresh, private installation. No host Python/Node.
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
export SFAC_STATE_DIR
SFAC_STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/factory-operator-test.XXXXXX")
cleanup() {
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
./sfac init --mode demo --port "${FACTORY_TEST_PORT:-18789}"
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

# Synthetic credentials test the live mount boundary without any provider request.
printf 'synthetic-app-canary\n' > "$SFAC_STATE_DIR/secrets/app_private_key"
printf 'synthetic-model-canary\n' > "$SFAC_STATE_DIR/secrets/model_key"
printf '{}\n' > "$SFAC_STATE_DIR/merge-policy.json"
export FACTORY_STATE_DIR="$SFAC_STATE_DIR"
export FACTORY_OPERATOR_IMAGE="$project-operator:development"
export FACTORY_LOCAL_IMAGE="$project-local:development"
export FACTORY_WORKER_IMAGE="$project-worker:development"
for role in operator probe database-operator demo-operator github-operator supervisor demo-supervisor live-supervisor; do
  docker compose --project-directory "$root/runtime" --env-file "$SFAC_STATE_DIR/.env" -p "$project" -f "$root/runtime/compose.yaml" -f "$root/runtime/compose.operator.yaml" -f "$root/runtime/compose.operator-review.yaml" run --rm --no-deps -T --entrypoint node "$role" /app/runtime/operator/assert-boundary.mjs "$role"
done
./sfac down --volumes
./sfac clean-images
for component in operator local worker; do
  if docker image inspect "$project-$component:development" >/dev/null 2>&1; then echo 'Installation tag remains' >&2; exit 1; fi
done
[ -f "$SFAC_STATE_DIR/.env" ] && [ -f "$SFAC_STATE_DIR/artifacts/demo.dump" ]
echo 'Scoped image cleanup passed; configuration and backup retained.'
