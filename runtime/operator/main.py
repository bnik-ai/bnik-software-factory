#!/usr/bin/env python3
"""Image-owned operator entry point; never executes code from the state mount."""
import os
import sys
import urllib.request
from pathlib import Path

args = sys.argv[1:]
if not args:
    raise SystemExit('Operator command required')
command, *args = args
scripts = {
    'init': '/app/runtime/configure.py',
    'demo': '/app/runtime/demo.py',
    'demo-source': '/app/runtime/worker/demo-source.py',
    'worker': '/app/runtime/worker.py',
    'recovery': '/app/runtime/recovery.py',
    'prepare-result': '/app/examples/invoice/prepare-result.py',
}
if command in scripts:
    os.execvp('python3', ['python3', scripts[command], *args])
if command == 'ready':
    with urllib.request.urlopen('http://runtime:8787/readyz', timeout=10) as response:
        print(response.read().decode())
    raise SystemExit(0)
if command in ['status', 'demo-status', 'verify-database', 'compact']:
    root = Path('/state')
    os.environ.update(POSTGRES_HOST='db', POSTGRES_PORT='5432', POSTGRES_TLS='disable', POSTGRES_DATABASE=args[0] if command == 'verify-database' and args else 'software_factory', POSTGRES_USER='factory_runtime', POSTGRES_PASSWORD_FILE=str(root / 'secrets/database_password'))
    os.chdir('/app/services/local-runtime')
    script = 'src/operator.ts' if command in ['demo-status', 'verify-database'] else 'src/main.ts'
    os.execvp('node', ['node', '--import', 'tsx', script, command, *args])
raise SystemExit('Unknown operator command')
