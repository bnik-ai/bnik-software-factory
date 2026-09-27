#!/usr/bin/env python3
"""Create local secrets once, without printing them or overwriting existing state."""
import argparse
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit

p = argparse.ArgumentParser()
p.add_argument("--mode", choices=["demo", "live"], required=True)
p.add_argument("--repository")
p.add_argument("--repository-id", type=int)
p.add_argument("--webhook-url")
p.add_argument("--operators", help="Comma-separated human GitHub logins; current write/admin permission is also required")
p.add_argument("--execution", choices=["disabled", "manual"])
p.add_argument("--installation-id", type=int)
p.add_argument("--app-slug")
p.add_argument("--app-id", type=int)
p.add_argument("--port", type=int, default=8787)
a = p.parse_args()
source_root = Path(__file__).resolve().parent
root = Path(os.environ.get('FACTORY_STATE_DIR', source_root)).resolve()
if os.getuid() == 0:
    p.error("Run local configuration as a non-root user")
if (root / ".env").exists() or (root / "secrets").exists():
    p.error("Configuration exists; preserve it. See docs/credentials.md and docs/local-runtime.md#backup-restore-and-reset.")
if not 1 <= a.port <= 65535:
    p.error("Invalid local port")
if a.mode == "live" and not all(
    [a.repository, a.repository_id, a.installation_id, a.app_slug, a.app_id, a.webhook_url, a.operators, a.execution]
):
    p.error("Live mode requires repository/name and ID, installation/App IDs, slug, HTTPS webhook URL, operators and explicit execution mode")
if a.repository and not re.fullmatch(
    r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", a.repository
):
    p.error("Invalid repository")
if a.app_slug and not re.fullmatch(r"[a-z0-9][a-z0-9-]*", a.app_slug):
    p.error("Invalid App slug")
if any(
    value is not None and not 1 <= value <= 9007199254740991
    for value in [a.installation_id, a.app_id, a.repository_id]
):
    p.error("Invalid App or installation ID")
if a.mode == "live":
    url = urlsplit(a.webhook_url)
    if url.scheme != "https" or url.username or url.password or url.query or url.fragment or url.path != "/webhook" or url.port or not url.hostname or "." not in url.hostname or re.match(r"^(localhost|127\.|0\.|\[)", url.hostname):
        p.error("Webhook URL must be public HTTPS ending in /webhook, without credentials/query/port")
    operators = [v.strip().lower() for v in a.operators.split(',')]
    if len(operators) > 20 or len(set(operators)) != len(operators) or any(not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,38}", v) for v in operators):
        p.error("Invalid human operator list")
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
if a.mode == "live":
    settings.update(GITHUB_APP_ID=str(a.app_id), FACTORY_REPOSITORY_ID=str(a.repository_id), FACTORY_WEBHOOK_URL=a.webhook_url, FACTORY_OPERATORS=','.join(operators), FACTORY_EXECUTION=a.execution)
if any("\n" in v or "\r" in v for v in settings.values()):
    p.error("Invalid configuration value")
(root / ".env").write_text("".join(f"{k}={v}\n" for k, v in settings.items()))
print("Local configuration created. Secret values were not printed.")
if a.mode == "live":
    print(
        "Provide secrets/app_private_key and configure the generated webhook secret in your App. compose.live.yaml is intake-only; manual execution additionally requires secrets/model_key and a verified activation."
    )
