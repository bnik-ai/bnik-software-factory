#!/usr/bin/env python3
"""Disposable real-PostgreSQL contract, SIGKILL and container restart checks.

Requires Docker and Python 3. Never uses an existing database, live credentials,
cloud resources or model API. Pass --report for a private JSON evidence artifact.
"""
import argparse
import hashlib
import json
import os
import secrets
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PG = "postgres:17-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652"
p = argparse.ArgumentParser()
p.add_argument("--report", type=Path)
p.add_argument("--skip-build", action="store_true")
a = p.parse_args()
name = "factory-runtime-test-" + uuid.uuid4().hex[:10]
image = "software-factory-local:development"
results = []


def run(command, expected=0):
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != expected:
        print(result.stdout[-12000:])
        print(result.stderr[-5000:])
        raise RuntimeError("Command failed: " + " ".join(command[:5]))
    return result.stdout + result.stderr


def ready():
    for _ in range(60):
        r = subprocess.run(
            [
                "docker",
                "exec",
                name,
                "pg_isready",
                "-U",
                "factory_migrator",
                "-d",
                "software_factory",
            ],
            capture_output=True,
        )
        if r.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError("PostgreSQL did not become ready")


try:
    if not a.skip_build:
        run(["docker", "build", "-f", "runtime/Dockerfile", "-t", image, "."])
        print("Pinned runtime image built.", flush=True)
    run(["docker", "network", "create", name])
    with tempfile.TemporaryDirectory(prefix="factory-runtime-test-") as tmp:
        root = Path(tmp)
        for filename in ["admin", "runtime"]:
            (root / filename).write_text(secrets.token_hex(32) + "\n")
            (root / filename).chmod(0o600)
        common = [
            "--network",
            name,
            "--mount",
            f"type=bind,src={root},dst=/run/factory-test,readonly",
        ]
        db = [
            "docker",
            "run",
            "-d",
            "--name",
            name,
            "--network-alias",
            "db",
            *common,
            "-e",
            "POSTGRES_USER=factory_migrator",
            "-e",
            "POSTGRES_DB=software_factory",
            "-e",
            "POSTGRES_PASSWORD_FILE=/run/factory-test/admin",
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
            PG,
        ]
        run(db)
        ready()
        environment = [
            "POSTGRES_HOST=db",
            "POSTGRES_TLS=disable",
            "POSTGRES_DATABASE=software_factory",
            "POSTGRES_USER=factory_migrator",
            "POSTGRES_PASSWORD_FILE=/run/factory-test/admin",
            "FACTORY_DB_PASSWORD_FILE=/run/factory-test/runtime",
            "FACTORY_TEST_FAULT_INJECTION=1",
        ]
        options = [
            "docker",
            "run",
            "--rm",
            "--init",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            *common,
        ]
        for entry in environment:
            options += ["-e", entry]

        def runtime(*command, expected=0):
            return run([*options, image, *command], expected)

        output = runtime("npm", "test")
        results.append(
            {
                "check": "configuration unit tests",
                "passed": True,
                "output_sha256": hashlib.sha256(output.encode()).hexdigest(),
            }
        )
        print(output, flush=True)
        output = runtime("npm", "run", "test:integration")
        results.append(
            {
                "check": "PostgreSQL integration contracts",
                "passed": True,
                "output_sha256": hashlib.sha256(output.encode()).hexdigest(),
            }
        )
        print(output, flush=True)

        def phase(name, checkpoint=None, expected=0):
            command = ["node", "--import", "tsx", "test/crash-worker.ts", name]
            if checkpoint:
                command.append(checkpoint)
            return runtime(*command, expected=expected)

        scenarios = [
            ("validator", "audit-inserted"),
            ("validator", "validator-published"),
            ("validator", "validator-committed"),
            ("orchestrator", "agent-enqueued"),
            ("orchestrator", "orchestrator-committed"),
            ("worker", "demo-effect-inserted"),
            ("worker", "demo-committed"),
        ]
        for stage, checkpoint in scenarios:
            phase("setup")
            if stage in ["orchestrator", "worker"]:
                phase("validator")
            if stage == "worker":
                phase("orchestrator")
            output = phase(stage, checkpoint, expected=137)
            assert "crash_checkpoint" in output, checkpoint
            time.sleep(1.2)
            phase("recover")
            results.append(
                {
                    "check": "SIGKILL recovery",
                    "checkpoint": checkpoint,
                    "exit_code": 137,
                    "passed": True,
                }
            )
            print("Crash recovery passed: " + checkpoint, flush=True)
        phase("seed-restart")
        run(["docker", "kill", "--signal", "KILL", name])
        run(["docker", "start", name])
        ready()
        time.sleep(1.2)
        phase("verify-restart")
        logs = run(["docker", "logs", name])
        assert "database system was interrupted" in logs
        results.append(
            {
                "check": "PostgreSQL container SIGKILL and WAL recovery",
                "passed": True,
                "preserved": [
                    "audit",
                    "demo effects",
                    "pending",
                    "running lease",
                    "retry attempts",
                    "dead letter reasons",
                ],
            }
        )
        print("PostgreSQL container restart passed.", flush=True)
        dump = subprocess.run(
            [
                "docker",
                "exec",
                name,
                "pg_dump",
                "-U",
                "factory_migrator",
                "-d",
                "software_factory",
                "-Fc",
            ],
            capture_output=True,
            check=True,
        ).stdout
        run(
            [
                "docker",
                "exec",
                name,
                "createdb",
                "-U",
                "factory_migrator",
                "factory_restore_check",
            ]
        )
        restored = subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                name,
                "pg_restore",
                "-U",
                "factory_migrator",
                "-d",
                "factory_restore_check",
                "--no-owner",
            ],
            input=dump,
            capture_output=True,
        )
        if restored.returncode:
            raise RuntimeError("Backup restore failed")
        original = options.index("POSTGRES_DATABASE=software_factory")
        options[original] = "POSTGRES_DATABASE=factory_restore_check"
        phase("verify-restart")
        options[original] = "POSTGRES_DATABASE=software_factory"
        results.append(
            {
                "check": "pg_dump custom-format backup and restore into a new database",
                "passed": True,
                "dump_sha256": hashlib.sha256(dump).hexdigest(),
                "dump_bytes": len(dump),
            }
        )
        print("Backup restore passed.", flush=True)
        environment = {
            "node": runtime("node", "--version").strip(),
            "postgres": run(["docker", "exec", name, "postgres", "--version"]).strip(),
            "architecture": runtime(
                "node", "-p", 'process.platform+"/"+process.arch'
            ).strip(),
            "image_id": run(
                ["docker", "image", "inspect", image, "--format", "{{.Id}}"]
            ).strip(),
            "postgres_image": PG,
        }
    report = {
        "passed": True,
        "environment": environment,
        "checks": results,
        "limitations": "Real database and transport; demo substrate/worker only. No live GitHub/model flow, isolated coding worker or publication tested.",
    }
finally:
    subprocess.run(["docker", "rm", "-f", "-v", name], capture_output=True)
    subprocess.run(["docker", "network", "rm", name], capture_output=True)
if a.report:
    a.report.parent.mkdir(parents=True, exist_ok=True)
    a.report.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
