"""Reversible iOS-only E2E bridge harness; no real-account/WidgetKit draw verdict.
Requires a simulator-signed app and an E2E-enabled Metro URL or embedded bundle.
Run in the background with an artifact directory outside generated native projects.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import signal
import subprocess
import tempfile

BASELINE = '{"schemaVersion":1,"snapshotJson":null,"attemptsMs":[],"lastRenderedKey":null,"pendingKey":null}'
APP_ID = "org.freelingo.app"
GROUP_ID = "group.org.freelingo.app.widget"


# Named E2E harness resource bounds, 2026-09-14; not a widget or OS policy.
COMMAND_TIMEOUT_SECONDS = 30
DRIVER_AND_FLOW_TIMEOUT_SECONDS = 180


def run(args, output, timeout=COMMAND_TIMEOUT_SECONDS):
    with output.open("w") as log:
        process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            log.write("\nDiagnostic subprocess deadline exceeded; terminating owned process group.\n")
            log.flush()
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            return 124


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--url")
    args = parser.parse_args()
    out = args.artifacts.resolve()
    out.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[2]
    groups = subprocess.check_output(["xcrun", "simctl", "get_app_container", args.device, APP_ID, "groups"], text=True, timeout=COMMAND_TIMEOUT_SECONDS)
    matches = [line.split("\t", 1)[1] for line in groups.splitlines() if line.startswith(GROUP_ID + "\t")]
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one entitled widget App Group")
    publication = Path(matches[0]) / "FreelingoWidget" / "publication-v1.json"
    run(["xcrun", "simctl", "terminate", args.device, APP_ID], out / "initial-terminate.log")
    existed = publication.exists()
    before = publication.read_bytes() if existed else None
    mode = publication.stat().st_mode & 0o777 if existed else None
    if before is not None:
        (out / "prior-publication.bin").write_bytes(before)
    proof = {"device": args.device, "publication": str(publication), "priorExisted": existed,
             "priorSha256": hashlib.sha256(before).hexdigest() if before is not None else None,
             "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
             "scope": "explicit diagnostic fixture; native reload request is not a target draw receipt"}
    (out / "provenance.json").write_text(json.dumps(proof, indent=2))
    code = 1
    try:
        if not existed:
            publication.parent.mkdir(parents=True, exist_ok=True)
            publication.write_text(BASELINE)
            publication.chmod(0o600)
        launch = ["xcrun", "simctl", "openurl", args.device, args.url] if args.url else ["xcrun", "simctl", "launch", args.device, APP_ID]
        if run(launch, out / "launch.log") != 0:
            raise RuntimeError("Simulator launch failed")
        code = run(["maestro", "--device", args.device, "test", str(root / "e2e/diagnostics/widget-bridge/probe.yaml"),
                    "--format", "junit", "--output", str(out / "report.xml"), "--test-output-dir", str(out / "maestro")], out / "maestro.log", timeout=DRIVER_AND_FLOW_TIMEOUT_SECONDS)
    finally:
        run(["xcrun", "simctl", "terminate", args.device, APP_ID], out / "final-terminate.log")
        if existed:
            fd, temp = tempfile.mkstemp(prefix=".restore-widget-", dir=publication.parent)
            try:
                with os.fdopen(fd, "wb") as restored:
                    restored.write(before)
                    restored.flush()
                    os.fsync(restored.fileno())
                os.chmod(temp, mode)
                os.replace(temp, publication)
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
        else:
            publication.unlink(missing_ok=True)
        after = publication.read_bytes() if publication.exists() else None
        proof.update({"maestroExit": code, "priorRestoredExactly": after == before,
                      "afterExisted": publication.exists(),
                      "afterSha256": hashlib.sha256(after).hexdigest() if after is not None else None})
        (out / "result.json").write_text(json.dumps(proof, indent=2))
        if after != before:
            raise RuntimeError("Prior publication restoration failed")
    raise SystemExit(code)


if __name__ == "__main__":
    main()
