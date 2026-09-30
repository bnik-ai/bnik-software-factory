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
p.add_argument("--execution", choices=["disabled", "manual", "bounded"])
p.add_argument("--autonomy", action="store_true", help="Demo mode: enable the bounded autonomy controller with fixture adapters")
p.add_argument("--reviewer", choices=["fixture", "claude"])
p.add_argument("--reviewer-model")
p.add_argument("--scanner", choices=["off", "fixture", "trivy"], default="off")
p.add_argument("--scanner-image")
p.add_argument("--scanner-cache-volume")
p.add_argument("--publication", choices=["fork", "base"])
p.add_argument("--fork-repository")
p.add_argument("--fork-repository-id", type=int)
p.add_argument("--publisher-app-id", type=int)
p.add_argument("--publisher-installation-id", type=int)
p.add_argument("--secretless-ci-attested", action="store_true", help="Base publication: you attest the repository's pull-request CI holds no secrets")
p.add_argument("--automerge", action="store_true", help="Live bounded execution: merge routine pull requests under the autonomy policy with a separate merger App")
p.add_argument("--merger-app-id", type=int)
p.add_argument("--merger-installation-id", type=int)
p.add_argument("--merger-app-slug")
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
for name in ["admin_password", "database_password", "webhook_secret", "controller_database_password"]:
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
bounded = (a.mode == "live" and a.execution == "bounded") or (a.mode == "demo" and a.autonomy)
if a.autonomy and a.mode == "live":
    p.error("Live mode selects autonomy with --execution bounded")
if a.automerge and not bounded:
    p.error("--automerge requires live bounded execution")
if a.automerge and a.mode == "demo":
    p.error("Demo autonomy cannot merge")
if bounded:
    reviewer = a.reviewer or ("fixture" if a.mode == "demo" else None)
    if reviewer is None:
        p.error("Bounded execution requires --reviewer fixture|claude")
    if a.mode == "demo" and (reviewer != "fixture" or a.publication or a.scanner == "trivy"):
        p.error("Demo autonomy uses fixture adapters only and no publisher")
    if reviewer == "claude" and not (a.reviewer_model and re.fullmatch(r"claude-[A-Za-z0-9.-]{1,93}", a.reviewer_model)):
        p.error("--reviewer claude requires --reviewer-model claude-...")
    settings["FACTORY_REVIEWER"] = reviewer
    if a.reviewer_model:
        settings["FACTORY_REVIEWER_MODEL"] = a.reviewer_model
    settings["FACTORY_SCANNER"] = a.scanner
    if a.scanner == "trivy":
        if not (a.scanner_image and a.scanner_cache_volume):
            p.error("--scanner trivy requires --scanner-image and --scanner-cache-volume")
        settings.update(FACTORY_SCANNER_IMAGE=a.scanner_image, FACTORY_SCANNER_CACHE_VOLUME=a.scanner_cache_volume)
    if a.mode == "demo":
        settings["FACTORY_AUTONOMY"] = "bounded"
    else:
        if not (a.publication and a.publisher_app_id and a.publisher_installation_id):
            p.error("Bounded live execution requires --publication fork|base, --publisher-app-id and --publisher-installation-id")
        settings.update(FACTORY_PUBLICATION_MODE=a.publication, FACTORY_PUBLISHER_APP_ID=str(a.publisher_app_id), FACTORY_PUBLISHER_INSTALLATION_ID=str(a.publisher_installation_id))
        if a.publication == "fork":
            if not (a.fork_repository and a.fork_repository_id and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", a.fork_repository)):
                p.error("--publication fork requires --fork-repository and --fork-repository-id")
            settings.update(FACTORY_FORK_REPOSITORY=a.fork_repository, FACTORY_FORK_REPOSITORY_ID=str(a.fork_repository_id))
        elif not a.secretless_ci_attested:
            p.error("--publication base requires --secretless-ci-attested; pushing into the base repository runs its CI with its secrets on agent code")
        else:
            settings["FACTORY_PUBLICATION_SECRETLESS_CI"] = "attested"
        if a.automerge:
            if not (a.merger_app_id and a.merger_installation_id and a.merger_app_slug and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,38}", a.merger_app_slug)):
                p.error("--automerge requires --merger-app-id, --merger-installation-id and --merger-app-slug")
            if a.merger_app_id == a.publisher_app_id:
                p.error("The merger App must differ from the publisher App")
            settings.update(FACTORY_AUTOMERGE="enabled", FACTORY_MERGER_APP_ID=str(a.merger_app_id), FACTORY_MERGER_INSTALLATION_ID=str(a.merger_installation_id), FACTORY_MERGER_APP_SLUG=a.merger_app_slug)
if any("\n" in v or "\r" in v for v in settings.values()):
    p.error("Invalid configuration value")
(root / ".env").write_text("".join(f"{k}={v}\n" for k, v in settings.items()))
print("Local configuration created. Secret values were not printed.")
if bounded:
    print(
        "Bounded autonomy selected. Provide autonomy-policy.json and the acceptance/ bundle directory in the state directory, run ./sfac autonomy activate, then grant a scope."
        + (" Provide secrets/publisher_private_key for the publisher App." if a.mode == "live" else "")
        + (" Provide secrets/merger_private_key for the merger App and add `merger` to merge-policy/merge-policy.json." if a.automerge else "")
    )
if a.mode == "live":
    print(
        "Provide secrets/app_private_key and configure the generated webhook secret in your App. compose.live.yaml is intake-only; manual execution additionally requires secrets/model_key and a verified activation."
    )
