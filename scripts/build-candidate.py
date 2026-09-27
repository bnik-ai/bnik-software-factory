#!/usr/bin/env python3
"""Deterministic source-only archive of an immutable Git commit. Never publishes."""
import argparse
import gzip
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

VERSION = '0.1.0-alpha'

def build(root, commit, output):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args])
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Full immutable commit SHA required')
    if git('rev-parse', '--verify', commit + '^{commit}').decode().strip() != commit:
        raise ValueError('Commit identity mismatch')
    epoch = int(git('show', '-s', '--format=%ct', commit))
    name = f'bnik-software-factory-{VERSION}+g{commit}'
    output.mkdir(parents=True, exist_ok=False)
    entries = []
    tarbytes = io.BytesIO()
    with tarfile.open(fileobj=tarbytes, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for entry in sorted(git('ls-tree', '-rz', '--full-tree', commit).split(b'\0')):
            if not entry:
                continue
            meta, pathbytes = entry.split(b'\t', 1)
            mode, kind, oid = meta.decode().split()
            path = pathbytes.decode('utf8')
            parts = PurePosixPath(path).parts
            if kind != 'blob' or mode not in ('100644', '100755'):
                raise ValueError('Symlinks and submodules are not release inputs')
            if path.startswith('/') or '..' in parts or any(p in {'.git', '.factory', 'node_modules', 'internal', 'secrets', '__pycache__'} or p.startswith('.env') for p in parts):
                raise ValueError('Private or generated path in candidate commit')
            data = git('cat-file', 'blob', oid)
            if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{35,}', data):
                raise ValueError('Credential-shaped content requires review')
            info = tarfile.TarInfo(name + '/' + path)
            info.size, info.mode, info.mtime = len(data), int(mode[-3:], 8), epoch
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            archive.addfile(info, io.BytesIO(data))
            entries.append(dict(path=path, mode=mode, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    target = output / (name + '.tar.gz')
    with target.open('wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0, compresslevel=9) as zipped:
            zipped.write(tarbytes.getvalue())
    manifest = dict(version=VERSION, commit=commit, source_date_epoch=epoch, artifact=target.name,
                    sha256=hashlib.sha256(target.read_bytes()).hexdigest(), contents='Tracked source only; no Git history, installed dependencies, images or secrets.', files=entries)
    manifest_path = output / (name + '.manifest.json')
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in [target, manifest_path]))
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = build(Path.cwd(), args.commit, args.output)
    print(json.dumps({k: result[k] for k in ['version', 'commit', 'artifact', 'sha256']}))
