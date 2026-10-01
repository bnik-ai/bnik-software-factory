#!/usr/bin/env python3
"""Run the bounded-autonomy controller CLI with declared local configuration only."""
import os
import sys
from pathlib import Path

from merge_policy import merge_policy_file

command = sys.argv[1] if len(sys.argv) > 1 else ''
source_root = Path(__file__).resolve().parent
root = Path(os.environ.get('FACTORY_STATE_DIR', source_root)).resolve()
settings = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if line and not line.startswith('#'))
merge_policy = merge_policy_file(root)
allowed = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'FACTORY_OPERATOR_ACTOR']
env = {key: os.environ[key] for key in allowed if key in os.environ}
for key in [
    'FACTORY_MODE', 'FACTORY_REPOSITORY', 'GITHUB_INSTALLATION_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_ID', 'FACTORY_WORKER_IMAGE',
    'FACTORY_REPOSITORY_ID', 'FACTORY_WEBHOOK_URL', 'FACTORY_OPERATORS', 'FACTORY_EXECUTION', 'FACTORY_AUTONOMY',
    'FACTORY_MAX_TASK_RUNS', 'FACTORY_MAX_RUN_TURNS', 'FACTORY_MAX_RUN_MS', 'FACTORY_MAX_RUN_BUDGET_USD',
    'FACTORY_REVIEWER', 'FACTORY_REVIEWER_MODEL', 'FACTORY_REVIEWER_MAX_TOKENS', 'FACTORY_REVIEWER_PROMPT_VERSION', 'FACTORY_REVIEWER_MAX_DIFF_BYTES', 'FACTORY_REVIEWER_MAX_CONTEXT_BYTES',
    'FACTORY_SCANNER', 'FACTORY_SCANNER_IMAGE', 'FACTORY_SCANNER_CACHE_VOLUME',
    'FACTORY_PUBLICATION_MODE', 'FACTORY_PUBLISHER_APP_ID', 'FACTORY_PUBLISHER_INSTALLATION_ID', 'FACTORY_FORK_REPOSITORY', 'FACTORY_FORK_REPOSITORY_ID', 'FACTORY_PUBLICATION_SECRETLESS_CI',
]:
    if key in settings:
        env[key] = settings[key]
# Automatic merge: the merger identity is configuration of the merge commands alone.
if command in ('merge', 'merge-scan'):
    for key in ['FACTORY_AUTOMERGE', 'FACTORY_MERGER_APP_ID', 'FACTORY_MERGER_INSTALLATION_ID', 'FACTORY_MERGER_APP_SLUG']:
        if key in settings:
            env[key] = settings[key]
if os.environ.get('FACTORY_WORKER_IMAGE'):
    env['FACTORY_WORKER_IMAGE'] = os.environ['FACTORY_WORKER_IMAGE']
env.update(
    POSTGRES_HOST=os.environ.get('FACTORY_DATABASE_HOST', '127.0.0.1'),
    POSTGRES_PORT='5432' if os.environ.get('FACTORY_DATABASE_HOST') else settings.get('FACTORY_DATABASE_PORT', '55432'),
    POSTGRES_DATABASE='software_factory',
    POSTGRES_USER='factory_runtime',
    POSTGRES_TLS='disable',
    # The runtime password file is not mounted for autonomy commands; the controller uses its own.
    POSTGRES_PASSWORD='unused-by-controller-commands-0000000000',
    GITHUB_WEBHOOK_SECRET_FILE=str(root / 'secrets/webhook_secret'),
    FACTORY_CONTROLLER_DB_PASSWORD_FILE=str(root / 'secrets/controller_database_password'),
    FACTORY_AUTONOMY_POLICY_FILE=str(root / 'autonomy-policy.json'),
    FACTORY_ACCEPTANCE_BUNDLE_DIR=str(root / 'acceptance'),
)
if settings.get('FACTORY_MODE') == 'live':
    env['GITHUB_APP_PRIVATE_KEY_FILE'] = str(root / 'secrets/app_private_key')
    if merge_policy:
        env['FACTORY_MERGE_POLICY_FILE'] = str(merge_policy)
    if settings.get('FACTORY_EXECUTION') == 'bounded':
        env['ANTHROPIC_API_KEY_FILE'] = str(root / 'secrets/model_key')
        env['FACTORY_PUBLISHER_APP_PRIVATE_KEY_FILE'] = str(root / 'secrets/publisher_private_key')
        if settings.get('FACTORY_AUTOMERGE') == 'enabled' and command in ('merge', 'merge-scan'):
            env['FACTORY_MERGER_APP_PRIVATE_KEY_FILE'] = str(root / 'secrets/merger_private_key')
service = source_root.parent / 'services/local-runtime'
if not (service / 'node_modules/tsx').exists():
    raise SystemExit('Install services/local-runtime dependencies with npm ci first.')
args = sys.argv[1:]
# Demo task and archive paths are resolved against the invocation directory.
for flag in ['--task-file', '--archive']:
    if flag in args:
        index = args.index(flag) + 1
        if index < len(args):
            args[index] = str(Path(args[index]).resolve())
os.chdir(service)
os.execvpe('node', ['node', '--import', 'tsx', 'src/autonomy/cli.ts', *args], env)
