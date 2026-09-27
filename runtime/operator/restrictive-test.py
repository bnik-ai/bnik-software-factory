#!/usr/bin/env python3
"""Contributor harness: run Docker-only onboarding from a private umask-077 export.

Python/Git are test-runner dependencies, not sfac operator dependencies. Copies
only tracked current source and untracked nonignored source, never local state.
"""
import os
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
paths = subprocess.check_output(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root
).decode().split('\0')
with tempfile.TemporaryDirectory(prefix='factory-restrictive-source-') as tmp:
    source = Path(tmp) / 'source'
    old_umask = os.umask(0o077)
    try:
        source.mkdir()
        for name in filter(None, paths):
            src, dst = root / name, source / name
            if src.is_symlink() or not src.is_file():
                raise RuntimeError(f'Unexpected source entry: {name}')
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
            dst.chmod(0o700 if src.stat().st_mode & 0o111 else 0o600)
    finally:
        os.umask(old_umask)
    expected = {p: p.stat().st_mode & 0o777 for p in source.rglob('*')}
    assert expected[source / 'runtime/operator/main.py'] == 0o600
    print('Source files are 0600 (executables 0700); directories are 0700.', flush=True)
    subprocess.run(['sh', 'runtime/operator/test.sh'], cwd=source, check=True)
    assert all(p.stat().st_mode & 0o777 == mode for p, mode in expected.items())
    print('Restrictive source permissions unchanged; onboarding and boundaries passed.', flush=True)
