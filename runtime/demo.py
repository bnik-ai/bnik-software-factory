#!/usr/bin/env python3
"""Send one synthetic, signed Task transition to the explicitly configured demo."""
import os
import hashlib
import hmac
import json
import urllib.request
import uuid
from pathlib import Path

source_root = Path(__file__).resolve().parent
root = Path(os.environ.get('FACTORY_STATE_DIR', source_root)).resolve()
settings = dict(
    line.split("=", 1)
    for line in (root / ".env").read_text().splitlines()
    if line and not line.startswith("#")
)
if settings.get("FACTORY_MODE") != "demo":
    raise SystemExit("This command requires explicit demo configuration.")
identifier = uuid.uuid4().hex
payload = {
    "action": "labeled",
    "label": {"name": "status:ready"},
    "sender": {"type": "Bot", "login": settings["GITHUB_APP_SLUG"] + "[bot]"},
    "installation": {"id": int(settings["GITHUB_INSTALLATION_ID"])},
    "repository": {"full_name": settings["FACTORY_REPOSITORY"]},
    "issue": {
        "node_id": "I_DEMO_" + identifier,
        "number": 1,
        "body": "<!-- sf:structural sf:agent=planner@fixture run=01ARZ3NDEKTSV4RRFFQ69G5FAV -->",
        "user": {"login": settings["GITHUB_APP_SLUG"] + "[bot]"},
        "labels": [
            {"name": "kind:task"},
            {"name": "status:proposed"},
            {"name": "status:ready"},
        ],
    },
}
body = json.dumps(payload).encode()
key = (root / "secrets/webhook_secret").read_text().rstrip().encode()
request = urllib.request.Request(
    (os.environ.get("FACTORY_RUNTIME_URL") or "http://127.0.0.1:" + settings.get("FACTORY_PORT", "8787")) + "/webhook",
    data=body,
    headers={
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": identifier,
        "X-Hub-Signature-256": "sha256="
        + hmac.new(key, body, hashlib.sha256).hexdigest(),
    },
)
with urllib.request.urlopen(request, timeout=10) as response:
    print(response.read().decode())
print("Synthetic delivery submitted. The demo creates no external PR or model run.")
