"""Extract untrusted source only inside the disposable worker, never on the host."""
import gzip
import io
import os
import sys
import tarfile
from pathlib import Path, PurePosixPath

LIMIT = 64 * 1024 * 1024
compressed = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
if len(compressed) > 8 * 1024 * 1024:
    raise ValueError('source_archive_compressed_limit')
with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
    raw = stream.read(LIMIT + 1)
if len(raw) > LIMIT:
    raise ValueError('source_archive_expanded_limit')
root = Path('/workspace/repo')
root.mkdir(mode=0o700)
count = 0
size = 0
prefix = None
with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
    for member in archive:
        count += 1
        if count > 4096:
            raise ValueError('source_archive_file_limit')
        name = PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts or '\\' in member.name or len(member.name) > 1024:
            raise ValueError('unsafe_archive_path')
        if not name.parts:
            raise ValueError('empty_archive_path')
        if prefix is None:
            prefix = name.parts[0]
        if name.parts[0] != prefix:
            raise ValueError('archive_requires_one_root')
        parts = name.parts[1:]
        if '.git' in parts:
            raise ValueError('archive_git_metadata_forbidden')
        if not (member.isdir() or member.isfile()):
            raise ValueError('archive_links_and_devices_forbidden')
        if not parts:
            if not member.isdir():
                raise ValueError('archive_requires_root_directory')
            continue
        target = root.joinpath(*parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            continue
        size += member.size
        if member.size < 0 or size > LIMIT:
            raise ValueError('source_archive_size_limit')
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with target.open('xb') as output, archive.extractfile(member) as source:
            while data := source.read(65536):
                output.write(data)
        target.chmod(0o755 if member.mode & 0o111 else 0o644)
if count == 0:
    raise ValueError('empty_archive')
