#!/usr/bin/env python3
"""Real worker image + disposable PostgreSQL verification; no paid/live calls."""
import argparse
import hashlib
import json
import os
import secrets
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PG = 'postgres:17-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652'
p = argparse.ArgumentParser()
p.add_argument('--report', type=Path)
p.add_argument('--skip-build', action='store_true')
a = p.parse_args()
name = 'factory-worker-test-' + uuid.uuid4().hex[:10]
image = 'software-factory-worker:development'


def run(args, **kwargs):
    r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, **kwargs)
    if r.returncode:
        print(r.stdout[-14000:]); print(r.stderr[-4000:])
        raise RuntimeError('Worker verification command failed')
    return r.stdout


try:
    if not a.skip_build:
        run(['docker', 'build', '-f', 'runtime/worker/Dockerfile', '-t', image, '.'])
        print('Worker image built.', flush=True)
    with tempfile.TemporaryDirectory(prefix='factory-worker-test-') as tmp:
        private = Path(tmp)
        for filename in ['admin', 'runtime']:
            (private / filename).write_text(secrets.token_hex(32) + '\n')
            (private / filename).chmod(0o600)
        run(['docker', 'run', '-d', '--name', name, '-p', '127.0.0.1::5432', '--mount', f'type=bind,src={private},dst=/run/test-secrets,readonly', '-e', 'POSTGRES_USER=factory_migrator', '-e', 'POSTGRES_DB=software_factory', '-e', 'POSTGRES_PASSWORD_FILE=/run/test-secrets/admin', '-e', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256', PG])
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', 'factory_migrator', '-d', 'software_factory'], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Disposable database did not become ready')
        port = run(['docker', 'port', name, '5432']).strip().rsplit(':', 1)[1]
        env = {key: os.environ[key] for key in ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'] if key in os.environ}
        env.update(POSTGRES_HOST='127.0.0.1', POSTGRES_PORT=port, POSTGRES_TLS='disable', POSTGRES_USER='factory_migrator', POSTGRES_DATABASE='software_factory', POSTGRES_PASSWORD_FILE=str(private / 'admin'), FACTORY_DB_PASSWORD_FILE=str(private / 'runtime'), FACTORY_TEST_WORKER_IMAGE=image, WORKER_EVIDENCE_PATH=str(private / 'evidence.json'))
        command = ['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'test/worker.container.ts']
        r = subprocess.run(command, cwd=ROOT / 'services/local-runtime', env=env, capture_output=True, text=True)
        print(r.stdout, flush=True)
        if r.returncode:
            print(r.stderr[-5000:]); raise RuntimeError('Worker container contracts failed')
        report = dict(passed=True, image_id=run(['docker', 'image', 'inspect', image, '--format', '{{.Id}}']).strip(), architecture=run(['docker', 'run', '--rm', '--network', 'none', image, 'node', '-p', 'process.platform+"/"+process.arch']).strip(), output_sha256=hashlib.sha256((r.stdout + r.stderr).encode()).hexdigest(), checks=json.loads((private / 'evidence.json').read_text()), limitations='Real shell/containers/database with synthetic source. No paid model, live GitHub token, PR publication or end-to-end alpha claim.')
finally:
    subprocess.run(['docker', 'rm', '-f', '-v', name], capture_output=True)
if a.report:
    a.report.parent.mkdir(parents=True, exist_ok=True)
    a.report.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
