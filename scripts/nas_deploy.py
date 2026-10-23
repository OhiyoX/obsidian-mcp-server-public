#!/usr/bin/env python3
"""Apply a checked Git archive to the existing NAS Compose project.

No production file is deleted merely because it is untracked. A manifest
detects edits made outside this release pipeline. Backups stay outside Git.
"""

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.request import urlopen


TAG_RE = re.compile(r"v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?")
PROTECTED = {".git", ".env", "data", ".deploy-state", ".backups"}
VERSION_MANIFEST = PurePosixPath("data/deployed-version.json")
TEXT_SUFFIXES = {".js", ".mjs", ".json", ".md", ".yaml", ".yml", ".css",
                 ".html", ".sh", ".py", ".ts", ".txt", ".svg", ".example"}
TEXT_NAMES = {"Dockerfile", ".dockerignore", ".gitignore"}


def digest(path):
    if not path.is_file() or path.is_symlink():
        return None
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def equivalent_text(a, b):
    if a.suffix not in TEXT_SUFFIXES and a.name not in TEXT_NAMES:
        return False
    try:
        left, right = a.read_bytes(), b.read_bytes()
        if b"\0" in left or b"\0" in right:
            return False
        left.decode("utf-8")
        right.decode("utf-8")
        return left.replace(b"\r\n", b"\n") == right.replace(b"\r\n", b"\n")
    except (OSError, UnicodeError):
        return False


def safe_name(name):
    path = PurePosixPath(name)
    if (not name or name.startswith("/") or "\\" in name or
            any(part in ("", ".", "..") for part in path.parts) or
            path.parts[0] in PROTECTED or
            any(part.startswith(".env") and part != ".env.example" for part in path.parts) or
            any(part in ("node_modules",) for part in path.parts)):
        raise RuntimeError(f"Unsafe archive path: {name}")
    return path.as_posix()


def read_archive(archive):
    entries = {}
    with tarfile.open(archive, "r:") as tar:
        for member in tar:
            name = safe_name(member.name.rstrip("/"))
            if member.isdir():
                continue
            if not member.isfile() or name in entries:
                raise RuntimeError(f"Unsupported or duplicate archive entry: {name}")
            entries[name] = member
        if not entries or "docker-compose.yaml" not in entries:
            raise RuntimeError("Archive is empty or missing docker-compose.yaml")
        with tempfile.TemporaryDirectory(prefix="obsidian-nas-stage-") as tmp:
            stage = Path(tmp)
            for name, member in entries.items():
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                if source is None:
                    raise RuntimeError(f"Cannot read {name}")
                with source, target.open("wb") as out:
                    shutil.copyfileobj(source, out)
                target.chmod(member.mode & 0o777)
            yield stage, sorted(entries)


def load_json(path, default=None):
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=".state-", delete=False) as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
        tmp = Path(stream.name)
    os.replace(tmp, path)


def write_version_manifest(project, tag, commit):
    """Publish the release identity inside the read-write data volume the app mounts.

    `data/` stays outside the archive and drift manifest, so this file only lets
    the running service report which release it is.
    """
    save_json(project / VERSION_MANIFEST,
              {"version": tag, "commit": commit,
               "deployedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")})


def clear_version_manifest(project):
    (project / VERSION_MANIFEST).unlink(missing_ok=True)


def inventory(project, stage, names, previous):
    desired = {name: digest(stage / name) for name in names}
    before = {name: digest(project / name) for name in set(names) | set(previous)}
    changes = []
    for name in sorted(set(names) | set(previous)):
        if before[name] == desired.get(name):
            continue
        if name in desired and before[name] is not None and equivalent_text(project / name, stage / name):
            desired[name] = before[name]  # no rewrite for CRLF-only differences
            continue
        changes.append(name)
    drift = sorted(name for name, old_hash in previous.items()
                   if before[name] != old_hash)
    drift.extend(name for name in names if name not in previous and before[name] is not None)
    drift = sorted(set(drift))
    if any(name in changes for name in ("app/Dockerfile", "app/package.json", "app/package-lock.json", "app/.dockerignore")):
        action = "rebuild"
    elif "docker-compose.yaml" in changes:
        action = "recreate"
    elif any(name == "app/server.js" or name.startswith("app/src/") for name in changes):
        action = "restart"
    else:
        action = "files-only"
    return desired, before, changes, drift, action


def docker_prefix():
    probe = subprocess.run(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe.returncode == 0:
        return ["docker"]
    password = sys.stdin.readline().rstrip("\r\n")
    if not password:
        raise RuntimeError("Docker access needs NASCODE in the caller's environment")
    # Never echo the password or command input.
    valid = subprocess.run(["sudo", "-S", "-p", "", "-v"], input=password + "\n",
                           text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if valid.returncode:
        raise RuntimeError("sudo authentication failed")
    return ["sudo", "-n", "docker"]


def docker(prefix, project, *args, capture=False):
    command = [*prefix, "compose", *args]
    return subprocess.run(command, cwd=project, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None)


def check_health(prefix, project):
    state = subprocess.check_output([*prefix, "inspect", "--format", "{{.State.Health.Status}}",
                                     "obsidian-mcp-server"], text=True).strip()
    if state != "healthy":
        raise RuntimeError(f"Container health is {state}")
    cmd = subprocess.check_output([*prefix, "inspect", "--format", "{{json .Config.Cmd}}",
                                   "obsidian-mcp-server"], text=True).strip()
    if cmd != '["node","server.js"]':
        raise RuntimeError(f"Unexpected production command: {cmd}")
    with urlopen("http://127.0.0.1:18923/healthz", timeout=8) as response:
        if response.status != 200:
            raise RuntimeError(f"healthz returned {response.status}")


def health_wait_budget(prefix, name="obsidian-mcp-server", minimum=60, cap=240):
    """Seconds to wait for the container to report `healthy` after a recreate.

    Docker only leaves `starting` once the FIRST healthcheck has run, so the wait has to be
    derived from the container's own schedule (start period + interval x (retries + 1) +
    timeout) instead of a fixed guess. 2026-10-23: the fixed 20 x 2 s = 40 s budget was shorter
    than `start_period 10 s + interval 30 s` for the rebuild action, so a perfectly healthy
    release was reported as `Container health is starting` and rolled back.
    """
    try:
        raw = subprocess.check_output(
            [*prefix, "inspect", "--format", "{{json .Config.Healthcheck}}", name], text=True)
        config = json.loads(raw or "{}")
    except (subprocess.CalledProcessError, ValueError):
        config = {}
    if not isinstance(config, dict) or not config.get("Test"):
        return minimum
    interval = float(config.get("Interval") or 0) / 1e9
    timeout = float(config.get("Timeout") or 0) / 1e9
    start_period = float(config.get("StartPeriod") or 0) / 1e9
    retries = int(config.get("Retries") or 3)
    if interval <= 0:
        return minimum
    budget = start_period + interval * (retries + 1) + timeout + 15
    return max(minimum, min(cap, int(round(budget))))


def service_action(prefix, project, action, old_image=None):
    if action == "files-only":
        return
    docker(prefix, project, "config", "--quiet")
    if action == "rebuild":
        docker(prefix, project, "build", "obsidian-server")
        docker(prefix, project, "up", "-d", "--no-build", "--force-recreate", "obsidian-server")
    elif action == "recreate":
        docker(prefix, project, "up", "-d", "--no-build", "--force-recreate", "obsidian-server")
    else:
        docker(prefix, project, "restart", "obsidian-server")
    budget = health_wait_budget(prefix)
    deadline = time.monotonic() + budget
    while True:
        try:
            check_health(prefix, project)
            return
        except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"{error} (waited {budget}s for health)") from error
            time.sleep(2)


def restore(project, record):
    backup = project / ".deploy-state" / "releases" / record["tag"] / "backup"
    for name in record["changes"]:
        target = project / name
        check_parent(project, name)
        old = backup / name
        if old.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old, target)
        elif target.exists():
            target.unlink()


def require_no_pending_mutation_journal(project):
    journal = project / "data" / "mutation-journal"
    if journal.is_symlink():
        raise RuntimeError("Mutation journal path is symlinked; inspect it before rollback")
    if journal.is_dir() and any(journal.iterdir()):
        raise RuntimeError(
            "Pending mutation journal blocks code rollback; keep recovery-capable code "
            "running and reconcile data/mutation-journal first"
        )


def check_parent(project, name):
    parent = project
    for part in PurePosixPath(name).parts[:-1]:
        parent = parent / part
        if parent.is_symlink():
            raise RuntimeError(f"Symlinked production directory: {name}")


def apply(project, stage, tag, commit, desired, before, changes, action, state_path):
    state = load_json(state_path)
    release_dir = project / ".deploy-state" / "releases" / tag
    if release_dir.exists():
        prior = load_json(release_dir / "journal.json")
        if not prior or not prior.get("restored_after_failure"):
            raise RuntimeError(f"Release already has a journal: {tag}")
        shutil.rmtree(release_dir)
    backup = release_dir / "backup"
    backup.mkdir(parents=True)
    record = {"tag": tag, "commit": commit, "changes": changes,
              "before": before, "desired": desired, "previous_state": state,
              "action": action, "completed": False}
    save_json(release_dir / "journal.json", record)
    for name in changes:
        current = project / name
        check_parent(project, name)
        if current.is_symlink() or (current.exists() and not current.is_file()):
            raise RuntimeError(f"Refusing non-regular production path: {name}")
        if current.is_file():
            dest = backup / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(current, dest)
    old_image = None
    try:
        prefix = docker_prefix() if action != "files-only" else []
        if action == "rebuild":
            old_image = subprocess.check_output([*prefix, "image", "inspect", "obsidian-mcp-server:latest",
                                                 "--format", "{{.Id}}"], text=True).strip()
            subprocess.run([*prefix, "tag", old_image, f"obsidian-mcp-server:rollback-{tag}"], check=True)
            record["old_image"] = old_image
            save_json(release_dir / "journal.json", record)
        for name in changes:
            target = project / name
            source = stage / name
            if source.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(target.name + f".release-{os.getpid()}")
                shutil.copy2(source, temp)
                os.replace(temp, target)
            elif target.exists():
                target.unlink()
        service_action(prefix, project, action)
        save_json(state_path, {"tag": tag, "commit": commit, "files": desired})
        write_version_manifest(project, tag, commit)
        record["completed"] = True
        save_json(release_dir / "journal.json", record)
    except Exception:
        require_no_pending_mutation_journal(project)
        restore(project, record)
        if old_image:
            subprocess.run([*prefix, "tag", old_image, "obsidian-mcp-server:latest"], check=False)
        try:
            if action != "files-only" and "prefix" in locals():
                service_action(prefix, project, "recreate")
        except Exception as recovery_error:
            print(f"Recovery needs attention: {recovery_error}", file=sys.stderr)
            raise
        record["restored_after_failure"] = True
        save_json(release_dir / "journal.json", record)
        raise
    print(json.dumps({"status": "deployed", "tag": tag, "commit": commit,
                      "changed": len(changes), "action": action}, ensure_ascii=False))


def rollback(project, tag):
    state_path = project / ".deploy-state" / "state.json"
    record_path = project / ".deploy-state" / "releases" / tag / "journal.json"
    record = load_json(record_path)
    state = load_json(state_path)
    if not record or not record["completed"] or not state or state["tag"] != tag:
        raise RuntimeError("Only the currently deployed, completed release can be rolled back")
    for name in record["changes"]:
        if digest(project / name) != record["desired"].get(name):
            raise RuntimeError(f"Production drift blocks rollback: {name}")
    require_no_pending_mutation_journal(project)
    prefix = docker_prefix() if record["action"] != "files-only" else []
    restore(project, record)
    if record.get("old_image"):
        subprocess.run([*prefix, "tag", record["old_image"], "obsidian-mcp-server:latest"], check=True)
    if record["action"] != "files-only":
        service_action(prefix, project, "recreate")
    if record["previous_state"] is None:
        state_path.unlink(missing_ok=True)
        clear_version_manifest(project)
    else:
        save_json(state_path, record["previous_state"])
        write_version_manifest(project, record["previous_state"]["tag"], record["previous_state"]["commit"])
    record["rolled_back"] = True
    save_json(record_path, record)
    print(json.dumps({"status": "rolled_back", "tag": tag}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "apply", "rollback"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--archive")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit")
    parser.add_argument("--adopt", action="store_true")
    args = parser.parse_args()
    try:
        if not TAG_RE.fullmatch(args.tag):
            raise RuntimeError("Invalid release tag")
        project = Path(args.project).resolve(strict=True)
        if not project.is_dir() or project == Path("/") or not (project / "docker-compose.yaml").is_file():
            raise RuntimeError("Target is not a Compose project")
        if args.mode == "rollback":
            rollback(project, args.tag)
            return 0
        if not args.archive or not args.commit or not re.fullmatch(r"[0-9a-f]{40}", args.commit):
            raise RuntimeError("Archive and full commit SHA are required")
        state_path = project / ".deploy-state" / "state.json"
        state = load_json(state_path)
        if state and state["tag"] == args.tag:
            raise RuntimeError("This tag is already deployed")
        from contextlib import contextmanager
        with contextmanager(read_archive)(Path(args.archive)) as (stage, names):
            previous = state["files"] if state else {}
            desired, before, changes, drift, action = inventory(project, stage, names, previous)
            first = state is None
            report = {"tag": args.tag, "commit": args.commit, "baseline": state["tag"] if state else None,
                      "first_deploy_requires_adopt": first, "changes": changes,
                      "drift": drift if not first else [], "action": action}
            print(json.dumps(report, ensure_ascii=False, indent=2))
            if args.mode == "check":
                return 0
            if first and not args.adopt:
                raise RuntimeError("First deployment requires --adopt after reviewing the preview")
            if not first and drift:
                raise RuntimeError("Production drift detected; reconcile manually before deployment")
            if not changes:
                raise RuntimeError("No file changes; refusing an empty deployment")
            apply(project, stage, args.tag, args.commit, desired, before, changes, action, state_path)
    except (RuntimeError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f"NAS deployment stopped: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
