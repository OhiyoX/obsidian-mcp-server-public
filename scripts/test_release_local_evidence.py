"""Local/environment evidence must bind real Git content and unchanged artifacts."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from test_release import load_release


class EnvironmentEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.repo = self.directory / "repo"
        self.repo.mkdir()
        self.release = load_release()
        self.release.ROOT = self.repo
        for args in (("init", "-b", "main"), ("config", "user.email", "test@example.com"),
                     ("config", "user.name", "Test")):
            self.git(*args)
        (self.repo / "source.txt").write_text("candidate\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "candidate")
        self.commit = self.release.output("git", "rev-parse", "HEAD")
        self.tree = self.release.output("git", "rev-parse", "HEAD^{tree}")
        self.artifact = self.directory / "results.txt"
        self.artifact.write_text("3 passed, 0 failed\n", encoding="utf-8")
        self.receipt_path = self.directory / "evidence.json"
        self.receipt = {
            "schema": "obsidian-local-validation/v1", "commit": self.commit,
            "tree": self.tree, "scope": "changed release boundary",
            "environment": "user-designated test environment", "not_proven": ["NAS live smoke"],
            "checks": [{"command": "synthetic fixture", "exit_code": 0, "executed": 3,
                        "failed": 0, "cancelled": 0, "skipped": 0, "todo": 0,
                        "artifact": "results.txt", "sha256": hashlib.sha256(self.artifact.read_bytes()).hexdigest()}],
        }

    def git(self, *args):
        return subprocess.run(("git", *args), cwd=self.repo, check=True, capture_output=True)

    def verify(self, authorization="synthetic user approval"):
        self.receipt_path.write_text(json.dumps(self.receipt), encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            self.release.verify_local_evidence(self.receipt_path, authorization, self.commit)

    def test_valid_exact_git_tree_and_hashed_artifact_are_accepted(self):
        self.verify()

    def test_authorization_is_required(self):
        with self.assertRaisesRegex(RuntimeError, "authorization"):
            self.verify("")

    def test_commit_or_tree_mismatch_is_rejected(self):
        for field in ("commit", "tree"):
            previous = self.receipt[field]
            self.receipt[field] = "0" * 40
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, "candidate"):
                self.verify()
            self.receipt[field] = previous

    def test_artifact_changed_after_validation_is_rejected(self):
        self.artifact.write_text("changed\n", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "hash mismatch"):
            self.verify()

    def test_failed_cancelled_and_non_integer_results_are_rejected(self):
        for field, value in (("exit_code", 1), ("failed", 1), ("cancelled", 1), ("todo", 1), ("executed", True)):
            record = self.receipt["checks"][0]
            previous = record[field]
            record[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.verify()
            record[field] = previous

    def test_empty_and_all_skipped_results_are_rejected(self):
        self.receipt["checks"][0]["skipped"] = 3
        with self.assertRaisesRegex(RuntimeError, "no executed"):
            self.verify()
        self.receipt["checks"] = []
        with self.assertRaisesRegex(RuntimeError, "no checks"):
            self.verify()

    def test_environment_scope_and_unverified_items_must_be_explicit(self):
        for field in ("environment", "scope", "not_proven"):
            previous = self.receipt[field]
            self.receipt[field] = None
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.verify()
            self.receipt[field] = previous

    def test_local_options_cannot_silently_change_default_ci_channel(self):
        with self.assertRaisesRegex(RuntimeError, "require.*local-fast"):
            self.release.validate_channel("ci", self.receipt_path, "approval")

    def test_apply_reuses_environment_evidence_and_keeps_release_anchor_before_transfer(self):
        tag = "v2026.10.11"
        self.git("tag", tag)
        self.verify()
        calls = []
        with mock.patch.object(self.release, "verify_origin_main"), \
                mock.patch.object(self.release, "remote_tag_commit", return_value=self.commit), \
                mock.patch.object(self.release, "verify_release_anchor", side_effect=lambda *args: calls.append("anchor")), \
                mock.patch.object(self.release, "checks") as checks, \
                mock.patch.object(self.release, "verify_release_tag_ci") as ci, \
                mock.patch.object(self.release, "run", side_effect=lambda *args, **kwargs: calls.append(args[0])), \
                contextlib.redirect_stdout(io.StringIO()):
            self.release.deploy(tag, "synthetic-host", "/synthetic-project", True, False,
                                validation_channel="local-fast", local_evidence=self.receipt_path,
                                authorization="synthetic approval")
        checks.assert_not_called()
        ci.assert_not_called()
        self.assertEqual(calls[0], "anchor")
        self.assertIn("ssh", calls)


if __name__ == "__main__":
    unittest.main()
