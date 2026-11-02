#!/usr/bin/env python3
"""Sync, tag, and stage reproducible releases for the NAS service.

Only tracked Git content is archived. Deployment never pulls into the dirty
production checkout and never copies the local .env, Vault, or data directory.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_HOST = "nas"
DEPLOY_PROJECT_ENV = "OBSIDIAN_MCP_DEPLOY_PROJECT"
TAG_RE = re.compile(r"v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?")
BINDING_SHA_RE = re.compile(r"[0-9a-fA-F]{4,40}")
SHA40_RE = re.compile(r"\b([0-9a-fA-F]{40})\b")
WINDOW_HEADING_RE = re.compile(r"^### 窗口 #\d+", re.MULTILINE)
BINDING_ROW_RE = re.compile(r"^\|\s*绑定\s*\|(.*)$", re.MULTILINE)
_QUEUE_UNSET = object()
BINDING_UNVERIFIED_WARNING = (
    "WARNING: 绑定一致性未校验 — no binding SHA could be read from the "
    "deploy-queue window block or --binding-note. Continuing because no window "
    "binding could be read; a human must confirm --binding-sha matches the window block."
)
BINDING_UNVERIFIED_FAIL_CLOSED = (
    "已给出 --binding-sha，但既读不到 scratch/DEPLOY-QUEUE.md 的窗口块绑定行，"
    "也没有 --binding-note。按 fail-closed 口径拒绝执行。"
    "请补 --binding-note（或让队列窗口块可读）后重试。"
)
RELEASE_CHECK_NAME = "Release tag gate"
CI_WORKFLOW_FILE = "ci.yml"
GITHUB_API_VERSION = "2022-11-28"
COMMAND_TIMEOUT_SECONDS = 30 * 60
NETWORK_TIMEOUT_SECONDS = 5 * 60
QUICK_TIMEOUT_SECONDS = 2 * 60


def run(*args, cwd=ROOT, input_text=None, timeout=COMMAND_TIMEOUT_SECONDS):
    if os.name == "nt" and args and args[0] == "npm":
        args = ("npm.cmd", *args[1:])
    try:
        return subprocess.run(
            args, cwd=cwd, input=input_text, text=True, check=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Command timed out after {timeout}s: {args[0] if args else '(unknown)'}"
        ) from None


def output(*args, timeout=QUICK_TIMEOUT_SECONDS):
    try:
        return subprocess.check_output(
            args, cwd=ROOT, text=True, timeout=timeout
        ).strip()
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Command timed out after {timeout}s: {args[0] if args else '(unknown)'}"
        ) from None


def git_network(*args, capture=False):
    command = ("git", "-c", "http.version=HTTP/1.1", *args)
    return (
        output(*command, timeout=NETWORK_TIMEOUT_SECONDS)
        if capture
        else run(*command, timeout=NETWORK_TIMEOUT_SECONDS)
    )


def origin_repo():
    remote = output("git", "remote", "get-url", "origin")
    if "://" in remote:
        parsed = urlparse(remote)
        if parsed.hostname != "github.com":
            raise RuntimeError(f"Unsupported GitHub origin host: {parsed.hostname or remote}")
        repo_path = parsed.path.strip("/")
    else:
        match = re.fullmatch(r"(?:[^@]+@)?github\.com:(.+)", remote)
        if not match:
            raise RuntimeError("Origin must be a github.com repository URL")
        repo_path = match.group(1).strip("/")
    if repo_path.endswith(".git"):
        repo_path = repo_path[:-4]
    parts = repo_path.split("/")
    if len(parts) != 2 or not all(parts):
        raise RuntimeError(f"Cannot determine GitHub owner/repository from origin: {remote}")
    return tuple(parts)


def github_token():
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        token = os.environ.get(name, "").strip()
        if token:
            return token
    try:
        result = subprocess.run(
            ("gh", "auth", "token"),
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=QUICK_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result and result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    raise RuntimeError(
        "GitHub release verification requires GITHUB_TOKEN/GH_TOKEN with Actions and Checks read "
        "permission, or an authenticated 'gh' CLI"
    )


def github_json(api_path):
    request = Request(
        f"https://api.github.com/{api_path.lstrip('/')}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {github_token()}",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "obsidian-mcp-release-gate",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"GitHub Checks API returned HTTP {error.code}") from None
    except URLError as error:
        raise RuntimeError(f"GitHub Checks API request failed: {error.reason}") from None
    except json.JSONDecodeError:
        raise RuntimeError("GitHub Checks API returned invalid JSON") from None
    if not isinstance(payload, dict):
        raise RuntimeError("GitHub Checks API returned an unexpected payload")
    return payload


def release_run_title(tag):
    return f"CI tag:{tag}"


def verify_release_tag_ci(tag, commit):
    owner, repo = origin_repo()
    run_title = release_run_title(tag)

    # Query the canonical workflow directly. Do not rely on workflow-run `path`,
    # whose REST representation may include a ref suffix (for example @main).
    workflow_file = quote(CI_WORKFLOW_FILE, safe="")
    run_payload = github_json(
        f"repos/{owner}/{repo}/actions/workflows/{workflow_file}/runs"
        f"?head_sha={quote(commit, safe='')}&event=push&per_page=100"
    )
    workflow_runs = run_payload.get("workflow_runs")
    if not isinstance(workflow_runs, list):
        raise RuntimeError("GitHub Actions API response is missing workflow_runs")
    eligible_runs = [
        item for item in workflow_runs
        if isinstance(item, dict)
        and item.get("event") == "push"
        and item.get("head_sha") == commit
        and item.get("display_title") == run_title
        and item.get("status") == "completed"
        and item.get("conclusion") == "success"
        and isinstance(item.get("id"), int)
        and isinstance(item.get("check_suite_id"), int)
    ]
    if not eligible_runs:
        observed = sorted({
            f"{item.get('display_title')}:{item.get('status')}/{item.get('conclusion')}"
            for item in workflow_runs if isinstance(item, dict)
        })
        detail = ", ".join(observed[:8]) if observed else "no matching workflow run"
        raise RuntimeError(
            f"Tag CI is not verified for {tag} @ {commit}: required successful "
            f"{CI_WORKFLOW_FILE} push run titled '{run_title}' for that exact tag ({detail})"
        )

    # Prefer the newest successful attempt for this exact tagged run identity.
    target_run = max(
        eligible_runs,
        key=lambda item: (int(item.get("run_attempt") or 0), item["id"]),
    )
    check_suite_id = target_run["check_suite_id"]
    encoded_name = quote(RELEASE_CHECK_NAME, safe="")
    check_payload = github_json(
        f"repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs"
        f"?check_name={encoded_name}&filter=all&per_page=100"
    )
    checks = check_payload.get("check_runs")
    if not isinstance(checks, list):
        raise RuntimeError("GitHub Checks API response is missing check_runs")
    matching_checks = [
        item for item in checks
        if isinstance(item, dict)
        and item.get("name") == RELEASE_CHECK_NAME
        and item.get("head_sha") == commit
        and item.get("status") == "completed"
        and item.get("conclusion") == "success"
        and isinstance(item.get("app"), dict)
        and item["app"].get("slug") == "github-actions"
        and isinstance(item.get("check_suite"), dict)
        and item["check_suite"].get("id") == check_suite_id
    ]
    if not matching_checks:
        observed = sorted({
            f"{item.get('name')}:{item.get('status')}/{item.get('conclusion')}"
            for item in checks if isinstance(item, dict)
        })
        detail = ", ".join(observed[:8]) if observed else "no matching release check"
        raise RuntimeError(
            f"Tag CI is not verified for {tag} @ {commit}: required successful "
            f"'{RELEASE_CHECK_NAME}' check in check suite {check_suite_id} ({detail})"
        )

def require_clean():
    """Reject every change that would alter the bytes a tag archives.

    ``git status`` compares working-tree stat data, so on a Windows
    ``core.autocrlf=true`` checkout it reports build output as modified after
    esbuild rewrites a CRLF file as LF even though Git's normalized bytes are
    identical. Gate on Git-normalized diffs instead: a tracked file is clean
    when ``git diff`` (working tree and index) finds no difference after EOL
    conversion. Real edits, staged changes, and untracked files still fail.
    """
    problems = []
    untracked = output("git", "ls-files", "--others", "--exclude-standard")
    if untracked:
        problems.append("untracked files:\n" + untracked)
    staged = output("git", "diff", "--cached", "--name-only")
    if staged:
        problems.append("staged changes:\n" + staged)
    modified = output("git", "diff", "--name-only")
    if modified:
        problems.append("unstaged changes:\n" + modified)
    if problems:
        raise RuntimeError("Working tree is not clean; commit or discard changes first\n"
                           + "\n".join(problems))


def verify_origin_main():
    git_network("fetch", "origin", "main", "--tags")
    if output("git", "rev-parse", "HEAD") != output("git", "rev-parse", "origin/main"):
        raise RuntimeError("HEAD must equal origin/main; sync and push reviewed changes first")


def remote_tag_commit(tag):
    raw = git_network(
        "ls-remote",
        "origin",
        f"refs/tags/{tag}",
        f"refs/tags/{tag}^{{}}",
        capture=True,
    )
    refs = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) != 2:
            raise RuntimeError(f"Malformed ls-remote output for tag {tag}")
        sha, ref = parts
        if ref in refs and refs[ref] != sha:
            raise RuntimeError(f"Conflicting remote ref for tag {tag}: {ref}")
        refs[ref] = sha
    direct = refs.get(f"refs/tags/{tag}")
    peeled = refs.get(f"refs/tags/{tag}^{{}}")
    if not direct:
        raise RuntimeError(f"Tag is not published to origin: {tag}")
    # Annotated tags expose a peeled ^{} commit; lightweight tags point directly
    # at the commit. Both are accepted, but the resolved commit must be exact.
    return peeled or direct


def verify_release_anchor(tag, expected_commit):
    verify_origin_main()
    local_commit = output("git", "rev-parse", f"refs/tags/{tag}^{{commit}}")
    if local_commit != expected_commit:
        raise RuntimeError(
            f"Local tag {tag} moved to {local_commit}, expected {expected_commit}"
        )
    remote_commit = remote_tag_commit(tag)
    if remote_commit != expected_commit:
        raise RuntimeError(
            f"Remote tag {tag} resolves to {remote_commit}, expected {expected_commit}"
        )


def reject_release_test_overrides():
    blocked = [
        name for name in (
            "NODE_TEST_GATE_TESTING",
            "NODE_TEST_GATE_HARNESS",
            "NODE_TEST_GATE_TIMEOUT_MS",
        )
        if os.environ.get(name)
    ]
    if blocked:
        raise RuntimeError(
            "Release checks refuse test-only Node gate overrides: "
            + ", ".join(blocked)
        )


def checks():
    reject_release_test_overrides()
    app = ROOT / "app"
    for command in (
        ("npm", "ci"),
        ("npm", "audit", "--audit-level=low"),
        ("npm", "run", "check"),
        ("node", "scripts/run-node-tests-ci.mjs"),
        ("npm", "run", "build:web"),
    ):
        run(*command, cwd=app)
    run(sys.executable, "scripts/run-python-tests-ci.py", cwd=ROOT)
    require_clean()  # generated bundles must match the committed source


def sync():
    require_clean()
    if output("git", "branch", "--show-current") != "main":
        raise RuntimeError("Sync runs only on main")
    git_network("fetch", "origin", "main", "--tags")
    run("git", "merge", "--ff-only", "origin/main")
    print("Synchronized main with origin/main")


def verify_local_evidence(evidence, authorization, commit):
    """Consume operator-reviewed local results, never execute receipt commands."""
    if not authorization or not str(authorization).strip():
        raise RuntimeError("local-fast requires an explicit --authorization reference")
    if not evidence:
        raise RuntimeError("local-fast requires --local-evidence")
    receipt_path = Path(evidence).resolve()
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise RuntimeError("Cannot read local validation evidence") from error
    if not isinstance(receipt, dict) or receipt.get("schema") != "obsidian-local-validation/v1":
        raise RuntimeError("Unsupported local validation evidence schema")
    tree = output("git", "rev-parse", f"{commit}^{{tree}}")
    if receipt.get("commit") != commit or receipt.get("tree") != tree:
        raise RuntimeError("Local evidence does not match the candidate commit and tree")
    for field in ("scope", "environment"):
        if not isinstance(receipt.get(field), str) or not receipt[field].strip():
            raise RuntimeError(f"Local evidence requires {field}")
    not_proven = receipt.get("not_proven")
    if not isinstance(not_proven, list) or any(not isinstance(item, str) for item in not_proven):
        raise RuntimeError("Local evidence must state not_proven as an array")
    records = receipt.get("checks")
    if not isinstance(records, list) or not records:
        raise RuntimeError("Local evidence has no checks")
    executed = 0
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("command"), str) or not record["command"].strip():
            raise RuntimeError("Local evidence has an invalid check")
        for field in ("exit_code", "executed", "failed", "cancelled", "skipped", "todo"):
            value = record.get(field)
            if type(value) is not int or value < 0:
                raise RuntimeError(f"Local check requires a nonnegative integer {field}")
        if record["exit_code"] or record["failed"] or record["cancelled"] or record["todo"]:
            raise RuntimeError("Local evidence contains a failed, cancelled or todo check")
        if record["skipped"] + record["todo"] > record["executed"]:
            raise RuntimeError("Local check counts are inconsistent")
        executed += record["executed"] - record["skipped"] - record["todo"]
        artifact = record.get("artifact")
        digest = record.get("sha256")
        if not isinstance(artifact, str) or not artifact or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise RuntimeError("Local evidence requires an artifact and SHA-256 for every check")
        artifact_path = receipt_path.parent / artifact
        try:
            with artifact_path.open("rb") as handle:
                hasher = hashlib.sha256()
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    hasher.update(chunk)
                actual = hasher.hexdigest()
        except OSError as error:
            raise RuntimeError("Local evidence artifact cannot be read") from error
        if actual != digest:
            raise RuntimeError("Local evidence artifact hash mismatch")
    if not executed:
        raise RuntimeError("Local evidence has no executed checks (empty or all skipped)")
    print(f"local-verified {commit} tree={tree}; {executed} executed checks; CI not asserted")
    print(f"Unverified items: {len(not_proven)}; inspect the receipt before release")


def validate_channel(channel, evidence, authorization):
    if channel not in ("ci", "local-fast"):
        raise RuntimeError("Unknown validation channel")
    if channel == "ci" and (evidence is not None or authorization is not None):
        raise RuntimeError("Local evidence/authorization options require --validation-channel local-fast")


def publish(tag, validation_channel="ci", local_evidence=None, authorization=None):
    validate_channel(validation_channel, local_evidence, authorization)
    if not TAG_RE.fullmatch(tag):
        raise RuntimeError("Tag must be vYYYY.MM.DD or vYYYY.MM.DD.N")
    require_clean()
    if output("git", "branch", "--show-current") != "main":
        raise RuntimeError("Publish runs only on main")
    verify_origin_main()
    if validation_channel == "local-fast":
        verify_local_evidence(local_evidence, authorization, output("git", "rev-parse", "HEAD"))
    else:
        checks()
    # Tests can take minutes; refuse to tag a commit if origin/main advanced.
    verify_origin_main()
    try:
        tag_exists = subprocess.run(
            ("git", "rev-parse", "--verify", f"refs/tags/{tag}"),
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=QUICK_TIMEOUT_SECONDS,
        ).returncode == 0
    except subprocess.TimeoutExpired:
        raise RuntimeError("Timed out while checking whether the release tag already exists") from None
    if tag_exists:
        raise RuntimeError(f"Tag already exists: {tag}")
    run("git", "tag", "-a", tag, "-m", f"Obsidian MCP Server {tag}")
    git_network("push", "origin", f"refs/tags/{tag}")
    print(f"Published source tag {tag}; validation channel={validation_channel}")


def resolve_project(explicit):
    """Resolve the NAS deploy target without storing it in the repository.

    The explicit --project value wins over the protected environment variable
    (DEPLOY_PROJECT_ENV). When both are absent the release fails locally,
    before any SSH/SCP/NAS side effect. The production directory is operator
    configuration and never lives in tracked files.
    """
    project = (explicit or os.environ.get(DEPLOY_PROJECT_ENV, "") or "").strip()
    if not project:
        raise RuntimeError(
            f"Deploy target is required: pass --project or set {DEPLOY_PROJECT_ENV} "
            "in the protected local environment"
        )
    if not project.startswith("/") or project == "/" or ".." in Path(project).parts:
        raise RuntimeError("Project must be an absolute NAS directory")
    return project


def warn_binding_consistency_unverified():
    print(BINDING_UNVERIFIED_WARNING, file=sys.stderr)


def binding_note_was_provided(binding_note):
    return binding_note is not None and str(binding_note).strip() != ""


def require_reachable_object(rev):
    """Fail unless `git cat-file -e` can see this object locally."""
    try:
        result = subprocess.run(
            ("git", "cat-file", "-e", rev),
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=QUICK_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Command timed out after {QUICK_TIMEOUT_SECONDS}s: git"
        ) from None
    if result.returncode != 0:
        detail = (result.stderr or "").strip()
        message = f"Binding SHA is not a reachable object: {rev}"
        if detail:
            message = f"{message} ({detail})"
        raise RuntimeError(message)


def git_commit_sha(rev):
    try:
        result = subprocess.run(
            ("git", "rev-parse", "--verify", f"{rev}^{{commit}}"),
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=QUICK_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Command timed out after {QUICK_TIMEOUT_SECONDS}s: git"
        ) from None
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        message = f"Binding SHA is reachable but is not a commit: {rev}"
        if detail:
            message = f"{message} ({detail})"
        raise RuntimeError(message)
    return result.stdout.strip().lower()


def require_ancestor_of_origin_main(commit):
    try:
        result = subprocess.run(
            ("git", "merge-base", "--is-ancestor", commit, "origin/main"),
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=QUICK_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Command timed out after {QUICK_TIMEOUT_SECONDS}s: git"
        ) from None
    if result.returncode == 0:
        return
    if result.returncode == 1:
        raise RuntimeError(
            f"Binding SHA {commit} is not an ancestor of origin/main"
        )
    detail = (result.stderr or "").strip()
    message = f"Cannot verify whether {commit} is an ancestor of origin/main"
    if detail:
        message = f"{message} ({detail})"
    raise RuntimeError(message)


def extract_window_binding(text):
    """Return the current window block's 40-hex 绑定, or None if it cannot be read.

    Only the first `### 窗口` block counts. A later historical block must not
    authorize a different SHA. Multiple distinct 40-hex values on the 绑定 row
    are an error, not a license to pick one.
    """
    if not text or not str(text).strip():
        return None
    headings = list(WINDOW_HEADING_RE.finditer(text))
    if not headings:
        return None
    start = headings[0].end()
    end = headings[1].start() if len(headings) > 1 else len(text)
    rows = BINDING_ROW_RE.findall(text[start:end])
    found = []
    for row in rows:
        for item in SHA40_RE.findall(row):
            lowered = item.lower()
            if lowered not in found:
                found.append(lowered)
    if not found:
        return None
    if len(found) > 1:
        raise RuntimeError("Window binding is ambiguous: " + ", ".join(found))
    return found[0]


def extract_note_binding(note):
    if note is None or not str(note).strip():
        return None
    text = str(note)
    labeled = []
    for line in text.splitlines() or [text]:
        if re.search(r"绑定|binding", line, re.IGNORECASE):
            for item in SHA40_RE.findall(line):
                lowered = item.lower()
                if lowered not in labeled:
                    labeled.append(lowered)
    if len(labeled) > 1:
        raise RuntimeError("Binding note is ambiguous: " + ", ".join(labeled))
    if len(labeled) == 1:
        return labeled[0]
    found = []
    for item in SHA40_RE.findall(text):
        lowered = item.lower()
        if lowered not in found:
            found.append(lowered)
    if len(found) > 1:
        raise RuntimeError("Binding note is ambiguous: " + ", ".join(found))
    if len(found) == 1:
        return found[0]
    return None


def deploy_queue_candidates():
    return (
        ROOT.parent / "scratch" / "DEPLOY-QUEUE.md",
        ROOT / "scratch" / "DEPLOY-QUEUE.md",
    )


def read_deploy_queue_text():
    for path in deploy_queue_candidates():
        if not path.is_file():
            continue
        try:
            return path.read_text(encoding="utf-8-sig")
        except OSError:
            return None
    return None


def enforce_binding_consistency(anchor, binding_note, queue_text):
    queue_sha = extract_window_binding(queue_text)
    note_sha = extract_note_binding(binding_note)
    if queue_sha and note_sha and queue_sha != note_sha:
        raise RuntimeError(
            f"Window binding {queue_sha} does not match the binding note {note_sha}"
        )
    recorded = queue_sha or note_sha
    if recorded is None:
        if not binding_note_was_provided(binding_note):
            raise RuntimeError(BINDING_UNVERIFIED_FAIL_CLOSED)
        warn_binding_consistency_unverified()
        return
    if recorded != anchor:
        raise RuntimeError(
            f"Binding SHA {anchor} does not match the window binding {recorded}"
        )


def resolve_binding_anchor(raw, binding_note=None, queue_text=_QUEUE_UNSET):
    """Validate an opt-in --binding-sha. The default deploy path never calls this."""
    rev = str(raw if raw is not None else "").strip()
    if not BINDING_SHA_RE.fullmatch(rev):
        raise RuntimeError(
            "Binding SHA must be 40 hex characters or an unambiguous short SHA: "
            + repr(rev)
        )
    require_reachable_object(rev)
    commit = git_commit_sha(rev)
    if len(rev) == 40 and commit != rev.lower():
        raise RuntimeError(f"Binding SHA {rev} is reachable but is not a commit")
    require_ancestor_of_origin_main(commit)
    if queue_text is _QUEUE_UNSET:
        queue_text = read_deploy_queue_text()
    enforce_binding_consistency(commit, binding_note, queue_text)
    return commit


def deploy(tag, host, project, apply, adopt, binding_sha=None, binding_note=None,
           validation_channel="ci", local_evidence=None, authorization=None):
    validate_channel(validation_channel, local_evidence, authorization)
    project = resolve_project(project)
    if not TAG_RE.fullmatch(tag):
        raise RuntimeError("Deploy requires a version tag (vYYYY.MM.DD[.N])")
    require_clean()
    verify_origin_main()
    commit = output("git", "rev-parse", f"refs/tags/{tag}^{{commit}}")
    if binding_sha is None:
        if commit != output("git", "rev-parse", "HEAD"):
            raise RuntimeError("Deploy only the tag at current origin/main HEAD")
    else:
        anchor = resolve_binding_anchor(binding_sha, binding_note)
        if commit != anchor:
            raise RuntimeError(
                f"Tag {tag} peels to {commit}, which does not equal the binding anchor {anchor}"
            )
    remote_commit = remote_tag_commit(tag)
    if remote_commit != commit:
        raise RuntimeError(
            f"Remote tag {tag} resolves to {remote_commit}, expected {commit}"
        )
    if validation_channel == "local-fast":
        verify_local_evidence(local_evidence, authorization, commit)
    else:
        verify_release_tag_ci(tag, commit)
    # Consume the selected validation once. NAS still checks drift, backups,
    # archive identity, Compose and live health; apply does not rerun local suites.
    # Revalidate immediately before archive/NAS side effects. The initial
    # origin/tag/CI checks must not be reused after a long local validation.
    verify_release_anchor(tag, commit)
    with tempfile.TemporaryDirectory(prefix="obsidian-release-") as temp:
        archive = Path(temp) / f"{tag}.tar"
        run("git", "archive", "--format=tar", "--output", str(archive), tag)
        remote_dir = f"{project}/.deploy-state/incoming"
        run("ssh", "-T", "-o", "BatchMode=yes", host, "mkdir", "-p", "--", remote_dir)
        remote_archive = f"{remote_dir}/{tag}.tar"
        remote_script = f"{remote_dir}/nas_deploy.py"
        # Synology's SFTP subsystem does not expose this volume path, while
        # its SSH/SCP transport does. -O selects the legacy SCP protocol.
        run("scp", "-O", "-q", str(archive), f"{host}:{remote_archive}")
        run("scp", "-O", "-q", str(ROOT / "scripts" / "nas_deploy.py"), f"{host}:{remote_script}")
        mode = "apply" if apply else "check"
        command = ["ssh", "-T", "-o", "BatchMode=yes", host, "python3", remote_script,
                   mode, "--project", project, "--archive", remote_archive, "--tag", tag,
                   "--commit", commit]
        if adopt:
            command.append("--adopt")
        if apply:
            # sudo receives this via stdin on the NAS if Docker group access is absent.
            secret = os.environ.get("NASCODE", "")
            run(*command, input_text=secret + "\n")
        else:
            run(*command)


def rollback(tag, host, project):
    project = resolve_project(project)
    if not TAG_RE.fullmatch(tag):
        raise RuntimeError("Rollback requires an existing release tag")
    remote_script = f"{project}/.deploy-state/incoming/nas_deploy.py"
    secret = os.environ.get("NASCODE", "")
    run("ssh", "-T", "-o", "BatchMode=yes", host, "python3", remote_script,
        "rollback", "--project", project, "--tag", tag, input_text=secret + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("sync", help="fast-forward a clean local main from GitHub")
    p = sub.add_parser("publish", help="test and push an annotated version tag")
    p.add_argument("tag")
    d = sub.add_parser(
        "deploy",
        help="check NAS drift, then optionally apply a tagged release",
        description=(
            "Default is strict: the tag commit must equal the current origin/main HEAD.\n"
            "默认严格；--binding-sha 为 opt-in 逃生门，仅用于窗口绑定。\n"
            "Pass --binding-sha only to anchor a deploy on a window-bound ancestor of origin/main. "
            "CI is the default channel; authorized local-fast consumes exact local evidence instead."
        ),
        formatter_class=lambda prog: argparse.RawDescriptionHelpFormatter(prog, width=200),
    )
    d.add_argument("tag")
    d.add_argument(
        "--binding-sha",
        default=None,
        help=(
            "opt-in window-binding anchor (40 hex, or an unambiguous short SHA). "
            "默认严格；--binding-sha 为 opt-in 逃生门，仅用于窗口绑定. "
            "When omitted, the tag commit must equal the current origin/main HEAD. "
            "When set, the value must be a reachable object, an ancestor of origin/main, "
            "and consistent with the deploy-queue window binding."
        ),
    )
    d.add_argument(
        "--binding-note",
        default=None,
        help=(
            "free text recording the window binding. Used with --binding-sha when the "
            "deploy queue cannot be read, and checked against that queue when both exist. "
            "A mismatch is an error. Ignored unless --binding-sha is set."
        ),
    )
    d.add_argument("--host", default=DEFAULT_HOST)
    d.add_argument("--project", default=None,
                   help="absolute NAS project directory; falls back to the protected "
                        f"{DEPLOY_PROJECT_ENV} environment variable (never stored in the repository)")
    d.add_argument("--apply", action="store_true", help="apply after preview and checks")
    d.add_argument("--adopt", action="store_true", help="first deployment only: back up and adopt current production")
    for operation in (p, d):
        operation.add_argument("--validation-channel", choices=("ci", "local-fast"), default="ci",
                               help="ci remains default; authorized local-fast consumes local evidence without waiting for CI")
        operation.add_argument("--local-evidence", help="private JSON receipt with exact commit/tree and hashed results from the local or user-designated environment")
        operation.add_argument("--authorization", help="reference to the user's authorization covering this action and target; never a secret")
    b = sub.add_parser("rollback", help="restore a release's pre-deployment files")
    b.add_argument("tag")
    b.add_argument("--host", default=DEFAULT_HOST)
    b.add_argument("--project", default=None,
                   help="absolute NAS project directory; falls back to the protected "
                        f"{DEPLOY_PROJECT_ENV} environment variable (never stored in the repository)")
    args = parser.parse_args()
    try:
        if args.command == "sync":
            sync()
        elif args.command == "publish":
            publish(args.tag, args.validation_channel, args.local_evidence, args.authorization)
        elif args.command == "deploy":
            deploy(
                args.tag,
                args.host,
                args.project,
                args.apply,
                args.adopt,
                binding_sha=args.binding_sha,
                binding_note=args.binding_note,
                validation_channel=args.validation_channel,
                local_evidence=args.local_evidence,
                authorization=args.authorization,
            )
        else:
            rollback(args.tag, args.host, args.project)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"Release operation stopped: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
