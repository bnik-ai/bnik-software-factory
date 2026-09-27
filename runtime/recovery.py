#!/usr/bin/env python3
"""Authenticated local recovery; no model, GitHub or Docker credentials inherited."""
import os
import sys
from pathlib import Path

source_root = Path(__file__).resolve().parent
root = Path(os.environ.get('FACTORY_STATE_DIR', source_root)).resolve()
settings = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if line and not line.startswith('#'))
env = {key: os.environ[key] for key in ['PATH', 'HOME'] if key in os.environ}
env.update(POSTGRES_HOST=os.environ.get('FACTORY_DATABASE_HOST', '127.0.0.1'), POSTGRES_PORT='5432' if os.environ.get('FACTORY_DATABASE_HOST') else settings.get('FACTORY_DATABASE_PORT', '55432'), POSTGRES_DATABASE='software_factory', POSTGRES_USER='factory_runtime', POSTGRES_TLS='disable', POSTGRES_PASSWORD_FILE=str(root / 'secrets/database_password'))
service = source_root.parent / 'services/local-runtime'
if not (service / 'node_modules/tsx').exists():
    raise SystemExit('Install services/local-runtime dependencies with npm ci first.')
os.chdir(service)
os.execvpe('node', ['node', '--import', 'tsx', 'src/recovery-cli.ts', *sys.argv[1:]], env)
