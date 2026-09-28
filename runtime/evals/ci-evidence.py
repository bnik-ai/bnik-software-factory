#!/usr/bin/env python3
"""Deterministic-lane evidence the protocol actually names: the contributor suites on this exact tree.

Runs the credential-free suites (type-check, lint, unit tests for every service, the scripts
tests including the protocol pin) and the container suites (the integration and container
tests run only inside them), in a constructed environment; --no-containers is a quick local
check the record does not accept. Writes one JSON file the qualification record requires before the
deterministic lane can be PASS. Exit 1 when any suite fails.

    python3 runtime/evals/ci-evidence.py --out /private/path/ci.json [--no-containers]
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ['agents', 'github-app', 'local-runtime', 'orchestrator', 'validator']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--no-containers', action='store_true', help='Skip runtime/test.py, runtime/worker/test.py and runtime/operator/restrictive-test.py (a quick local check; the record needs them)')
    args = parser.parse_args()
    args.with_containers = not args.no_containers
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT') if k in os.environ}
    env['HOME'] = env.get('HOME', '/tmp')
    suites = []
    for service in SERVICES:
        cwd = ROOT / 'services' / service
        suites.append(('biome ' + service, ['npx', 'biome', 'check', '.'], cwd))
        if (cwd / 'tsconfig.json').exists():
            suites.append(('tsc ' + service, ['npx', 'tsc', '--noEmit', '-p', '.'], cwd))
        if json.loads((cwd / 'package.json').read_text()).get('scripts', {}).get('test'):
            suites.append(('unit ' + service, ['npm', 'test'], cwd))
    for path in sorted((ROOT / 'scripts').glob('*.test.mjs')):
        suites.append((f'scripts {path.name}', ['node', '--test', str(path)], ROOT))
    if args.with_containers:
        for script in ('runtime/test.py', 'runtime/worker/test.py', 'runtime/operator/restrictive-test.py'):
            suites.append((script, ['python3', script], ROOT))
    results = []
    for name, command, cwd in suites:
        started = datetime.now(timezone.utc)
        completed = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=3600)
        tail = (completed.stdout + completed.stderr).strip().splitlines()[-3:]
        results.append({'suite': name, 'command': ' '.join(command), 'exitCode': completed.returncode, 'summary': tail, 'startedAt': started.isoformat(timespec='seconds'), 'durationSeconds': round((datetime.now(timezone.utc) - started).total_seconds(), 1)})
        print(f'{"PASS" if completed.returncode == 0 else "FAIL"} {name} ({results[-1]["durationSeconds"]}s)', flush=True)
    git = lambda *a: subprocess.run(['git', *a], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    record = {
        'version': 1,
        'candidateCommit': git('rev-parse', 'HEAD') or None,
        'treeDirty': bool(git('status', '--porcelain')),
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'containers': args.with_containers,
        'suites': results,
        'allPassed': all(r['exitCode'] == 0 for r in results),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'suites': len(results), 'failed': sum(1 for r in results if r['exitCode'] != 0), 'treeDirty': record['treeDirty']}))
    sys.exit(0 if record['allPassed'] else 1)


if __name__ == '__main__':
    main()
