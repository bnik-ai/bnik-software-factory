#!/usr/bin/env python3
"""Prepare two reviewed sample files from a worker receipt; no execution or push."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

FILES = ['invoice.mjs', 'invoice.test.mjs']

def prepare(repository, receipt, output):
    raw = receipt.read_bytes()
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('Receipt exceeds bound')
    result = json.loads(raw)
    outcome = result['outcome']
    commit = outcome['sourceCommit']
    patch = outcome['patch'].encode()
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Full source commit required')
    if not outcome['ok'] or outcome['testsStatus'] != 'passed' or outcome['model']['mode'] != 'live':
        raise ValueError('Passing live worker receipt required')
    if not outcome['tests'] or any(x['exitCode'] != 0 or x['signal'] is not None for x in outcome['tests']):
        raise ValueError('Passing command receipts required')
    if hashlib.sha256(patch).hexdigest() != outcome['patchSha256'] or not patch:
        raise ValueError('Nonempty patch with matching digest required')
    if output.exists():
        raise ValueError('New output directory required')
    # This is a trusted operator-supplied checkout, never a model-provided path.
    source = repository.resolve()
    env = {k: os.environ[k] for k in ['PATH', 'HOME', 'TMPDIR'] if k in os.environ}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
    def git(cwd, *args, data=None):
        return subprocess.check_output(['git', '-c', 'core.hooksPath='+os.devnull, '-C', str(cwd), *args], input=data, env=env, stderr=subprocess.PIPE)
    if git(source, 'rev-parse', '--verify', commit+'^{commit}').decode().strip() != commit:
        raise ValueError('Source identity mismatch')
    with tempfile.TemporaryDirectory(prefix='invoice-review-') as tmp:
        stage = Path(tmp)
        git(stage, 'init', '-q')
        for name in FILES:
            mode = git(source, 'ls-tree', commit, '--', name).decode().split()[0]
            if mode != '100644':
                raise ValueError('Only regular sample source files supported')
            (stage/name).write_bytes(git(source, 'show', commit+':'+name))
        git(stage, 'add', '--', *FILES)
        # Inspect all affected names before applying. No source/test command runs here.
        stats = git(stage, 'apply', '--numstat', '-z', '-', data=patch)
        names = [row.split(b'\t', 2)[2].decode() for row in stats.split(b'\0') if row]
        if not names or any(name not in FILES for name in names):
            raise ValueError('Patch exceeds the two-file sample boundary')
        git(stage, 'apply', '--check', '--index', '-', data=patch)
        git(stage, 'apply', '--index', '-', data=patch)
        entries = [row.split(b'\t', 1) for row in git(stage, 'ls-files', '--stage', '-z').split(b'\0') if row]
        if sorted(name.decode() for _,name in entries) != FILES or any(meta.split()[0] != b'100644' for meta,_ in entries):
            raise ValueError('Deletion, symlink or mode change is unsupported')
        prepared = {name:(stage/name).read_bytes() for name in FILES}
    output.mkdir(mode=0o700, parents=False)
    for name,data in prepared.items():
        (output/name).write_bytes(data)
    manifest = dict(source_commit=commit, receipt_sha256=hashlib.sha256(raw).hexdigest(), patch_sha256=outcome['patchSha256'], work_id=result['workId'], run_id=result.get('runId'), model=outcome['model'], files={name:hashlib.sha256(data).hexdigest() for name,data in prepared.items()}, limitation='Operator review required. Local receipts are not signed attestations. No test execution, GitHub write, approval or merge is performed.')
    (output/'publication-plan.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest

if __name__ == '__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--repository',type=Path,required=True)
    p.add_argument('--receipt',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    print(json.dumps(prepare(a.repository,a.receipt,a.output),indent=2))
