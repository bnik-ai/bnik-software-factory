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
    project=$(cat "$SFAC_STATE_DIR/project")
    for component in operator local worker; do docker image rm "$project-$component:development" >/dev/null 2>&1 || true; done
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
