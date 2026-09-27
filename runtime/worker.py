#!/usr/bin/env python3
"""Run the trusted native supervisor with declared local configuration only."""
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
settings = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if line and not line.startswith('#'))
allowed = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
env = {key: os.environ[key] for key in allowed if key in os.environ}
for key in ['FACTORY_MODE', 'FACTORY_REPOSITORY', 'GITHUB_INSTALLATION_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_ID', 'FACTORY_WORKER_IMAGE', 'FACTORY_REPOSITORY_ID', 'FACTORY_WEBHOOK_URL', 'FACTORY_OPERATORS', 'FACTORY_EXECUTION', 'FACTORY_MAX_TASK_RUNS', 'FACTORY_MAX_RUN_TURNS', 'FACTORY_MAX_RUN_MS', 'FACTORY_MAX_RUN_BUDGET_USD']:
    if key in settings:
        env[key] = settings[key]
env.update(POSTGRES_HOST='127.0.0.1', POSTGRES_PORT=settings.get('FACTORY_DATABASE_PORT', '55432'), POSTGRES_DATABASE='software_factory', POSTGRES_USER='factory_runtime', POSTGRES_TLS='disable', POSTGRES_PASSWORD_FILE=str(root / 'secrets/database_password'), GITHUB_WEBHOOK_SECRET_FILE=str(root / 'secrets/webhook_secret'))
if settings.get('FACTORY_MODE') == 'live':
    env['GITHUB_APP_PRIVATE_KEY_FILE'] = str(root / 'secrets/app_private_key')
    if (root / 'merge-policy.json').exists():
        env['FACTORY_MERGE_POLICY_FILE'] = str(root / 'merge-policy.json')
    if settings.get('FACTORY_EXECUTION') == 'manual':
        env['ANTHROPIC_API_KEY_FILE'] = str(root / 'secrets/model_key')
service = root.parent / 'services/local-runtime'
if not (service / 'node_modules/tsx').exists():
    raise SystemExit('Install services/local-runtime dependencies with npm ci first.')
# Resolve user paths against the invocation directory, not the service directory.
args = sys.argv[1:]
if args and args[0] == 'run':
    for index in [1, 2, 3]:
        if len(args) > index:
            args[index] = str(Path(args[index]).resolve())
if args and args[0] == 'run-activation' and len(args) > 2:
    args[2] = str(Path(args[2]).resolve())
if args and args[0] == 'prepare-task' and len(args) > 3:
    args[3] = str(Path(args[3]).resolve())
os.chdir(service)
os.execvpe('node', ['node', '--import', 'tsx', 'src/worker/cli.ts', *args], env)
