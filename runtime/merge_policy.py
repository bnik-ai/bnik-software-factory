"""Where the trusted merge policy lives in a state directory (docs/human-merge.md).

The review services mount DIRECTORY read-only, never the file: a single-file bind mount follows the
inode, so an edit that replaces the file (an editor's atomic save, `sed -i`, `mv`) would never reach
the running control plane. A policy in the state root is the retired layout and is refused, never
silently ignored: ignoring it would run a live installation without its merge gate.
"""
from pathlib import Path

DIRECTORY = 'merge-policy'
FILE = 'merge-policy.json'


def merge_policy_file(root):
    """The configured policy file under `root`, or None when no policy is configured."""
    root = Path(root)
    retired = root / FILE
    if retired.exists() or retired.is_symlink():
        raise SystemExit(f'Move {retired} to {root / DIRECTORY / FILE}: the review services mount the {DIRECTORY}/ directory.')
    directory = root / DIRECTORY
    if not (directory.exists() or directory.is_symlink()):
        return None
    policy = directory / FILE
    # A symlink would dangle inside the containers, which mount only this directory.
    if policy.is_symlink() or not policy.is_file():
        raise SystemExit(f'{directory} holds no regular file {FILE}; add it (not a symlink) or remove the directory.')
    return policy
