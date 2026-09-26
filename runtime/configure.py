#!/usr/bin/env python3
"""Create local secrets once, without printing them or overwriting existing state."""
import argparse
import os
import re
import secrets
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--mode", choices=["demo", "live"], required=True)
p.add_argument("--repository")
p.add_argument("--installation-id", type=int)
p.add_argument("--app-slug")
p.add_argument("--app-id", type=int)
p.add_argument("--port", type=int, default=8787)
a = p.parse_args()
root = Path(__file__).resolve().parent
if os.getuid() == 0:
    p.error("Run local configuration as a non-root user")
if (root / ".env").exists() or (root / "secrets").exists():
    p.error("Configuration exists; preserve it. See the reset/rotation instructions.")
if not 1 <= a.port <= 65535:
    p.error("Invalid local port")
if a.mode == "live" and not all(
    [a.repository, a.installation_id, a.app_slug, a.app_id]
):
    p.error("Live mode requires repository, installation ID, App slug and App ID")
if a.repository and not re.fullmatch(
    r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", a.repository
):
    p.error("Invalid repository")
if a.app_slug and not re.fullmatch(r"[a-z0-9][a-z0-9-]*", a.app_slug):
    p.error("Invalid App slug")
if any(
    value is not None and not 1 <= value <= 9007199254740991
    for value in [a.installation_id, a.app_id]
):
    p.error("Invalid App or installation ID")
os.umask(0o077)
(root / "secrets").mkdir(mode=0o700)
for name in ["admin_password", "database_password", "webhook_secret"]:
    (root / "secrets" / name).write_text(secrets.token_hex(32) + "\n")
settings = {
    "LOCAL_UID": str(os.getuid()),
    "LOCAL_GID": str(os.getgid()),
    "FACTORY_MODE": a.mode,
    "FACTORY_REPOSITORY": a.repository or "example/factory-demo",
    "GITHUB_INSTALLATION_ID": str(a.installation_id or 1),
    "GITHUB_APP_SLUG": a.app_slug or "factory-demo",
    "FACTORY_PORT": str(a.port),
}
if a.app_id:
    settings["GITHUB_APP_ID"] = str(a.app_id)
if any("\n" in v or "\r" in v for v in settings.values()):
    p.error("Invalid configuration value")
(root / ".env").write_text("".join(f"{k}={v}\n" for k, v in settings.items()))
print("Local configuration created. Secret values were not printed.")
if a.mode == "live":
    print(
        "Provide secrets/app_private_key and secrets/model_key before using compose.live.yaml. Live coding remains disabled."
    )
