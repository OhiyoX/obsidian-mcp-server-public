#!/usr/bin/env python3
"""Fail-closed CI adapter for the repository's Python unittest suite."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TIMEOUT_SECONDS = 5 * 60


def evaluate_result(returncode: int, stdout: str, stderr: str) -> list[str]:
    problems: list[str] = []
    combined = f"{stdout}\n{stderr}"
    runs = re.findall(r"Ran (\d+) tests? in ", combined)
    if not runs:
        problems.append("missing Python unittest result count")
        count = None
    else:
        count = int(runs[-1])
        if count == 0:
            problems.append("Python unittest suite reported zero tests")

    if returncode != 0:
        problems.append(f"Python unittest suite exited with code {returncode}")

    failed = re.findall(r"^FAILED\s*(?:\([^\n]*\))?\s*$", combined, flags=re.MULTILINE)
    oks = re.findall(r"^OK(?:\s*\(([^\n]*)\))?\s*$", combined, flags=re.MULTILINE)
    if failed:
        problems.append("Python unittest reported FAILED")
    if not oks:
        problems.append("missing final Python unittest OK result")
    else:
        qualifiers = oks[-1].strip()
        if qualifiers:
            problems.append(f"Python unittest reported qualified OK result: {qualifiers}")
        result_stream = stderr if stderr.strip() else stdout
        final_nonempty = [line.strip() for line in result_stream.splitlines() if line.strip()]
        if not final_nonempty or final_nonempty[-1] != "OK":
            problems.append("final Python unittest result line must be exactly OK")
    if count is not None and count > 0 and returncode == 0 and failed:
        problems.append("Python unittest result is internally inconsistent")
    return problems


def run_suite(command: list[str] | None = None, timeout: float = DEFAULT_TIMEOUT_SECONDS):
    actual = command or [
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        "scripts",
        "-p",
        "test_*.py",
    ]
    try:
        result = subprocess.run(
            actual,
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or ""
        stderr = error.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode(errors="replace")
        return None, stdout, stderr, [f"Python unittest suite timed out after {timeout}s"]

    return result.returncode, result.stdout, result.stderr, evaluate_result(
        result.returncode, result.stdout, result.stderr
    )


def main() -> int:
    if len(sys.argv) != 1:
        print("Python test filtering/extra CLI arguments are disabled in CI", file=sys.stderr)
        return 1
    returncode, stdout, stderr, problems = run_suite()
    if stdout:
        print(stdout, end="")
    if stderr:
        print(stderr, end="", file=sys.stderr)
    if problems:
        print("\nPython CI test gate: failed", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    print("\nPython CI test gate: passed (nonzero tests; clean OK result)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
