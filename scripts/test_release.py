"""Guard the release clean-tree gate against Windows EOL false positives.

`build:web` writes LF, while a `core.autocrlf=true` checkout smudges tracked
files to CRLF. `git status` then reports the rebuilt bundles as modified from
stale stat data even though Git's normalized bytes are identical. The gate must
accept those normalized-identical files while still refusing real edits, staged
changes, and untracked files.
"""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("release.py")


def load_release():
    spec = importlib.util.spec_from_file_location("release", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReleaseCleanTreeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.release = load_release()
        # Point the gate at the throwaway repository instead of the real one.
        self.release.ROOT = self.repo
        self.git("init")
        self.git("config", "core.autocrlf", "true")
        self.git("config", "user.email", "release-test@example.com")
        self.git("config", "user.name", "Release Test")

    def git(self, *args):
        return subprocess.run(("git", *args), cwd=self.repo, text=True,
                              capture_output=True, check=True)

    def add_committed(self, name, data):
        path = self.repo / name
        path.write_bytes(data)
        self.git("add", name)
        self.git("commit", "-m", f"add {name}")

    def test_normalized_only_line_ending_change_is_accepted(self):
        self.add_committed("app.js", b"a\nb\nc\n")
        # Re-checkout to get the CRLF working-tree form Git smudges on Windows.
        (self.repo / "app.js").unlink()
        self.git("checkout", "--", "app.js")
        self.assertEqual((self.repo / "app.js").read_bytes(), b"a\r\nb\r\nc\r\n")
        # esbuild-style rewrite: same authored text, LF bytes on disk.
        (self.repo / "app.js").write_bytes(b"a\nb\nc\n")
        # The regression precondition: git status flags the stale stat data...
        self.assertNotEqual(self.git("status", "--porcelain").stdout.strip(), "")
        # ...but the Git-normalized bytes have no diff.
        self.assertEqual(self.git("diff", "--name-only").stdout.strip(), "")
        self.release.require_clean()  # must not raise

    def test_clean_tree_is_accepted(self):
        self.add_committed("app.js", b"a\nb\nc\n")
        self.release.require_clean()

    def test_real_edit_is_rejected(self):
        self.add_committed("app.js", b"a\nb\nc\n")
        (self.repo / "app.js").write_bytes(b"a\nb\nchanged\n")
        with self.assertRaises(RuntimeError):
            self.release.require_clean()

    def test_staged_change_is_rejected(self):
        self.add_committed("app.js", b"a\nb\nc\n")
        (self.repo / "app.js").write_bytes(b"a\nb\nstaged\n")
        self.git("add", "app.js")
        with self.assertRaises(RuntimeError):
            self.release.require_clean()

    def test_untracked_file_is_rejected(self):
        self.add_committed("app.js", b"a\nb\nc\n")
        (self.repo / "new.js").write_bytes(b"x\n")
        with self.assertRaises(RuntimeError):
            self.release.require_clean()


class ReleaseCommandTimeoutTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.release = load_release()
        self.release.ROOT = Path(self.temp.name)

    def test_run_times_out_a_real_child_process(self):
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            self.release.run(
                sys.executable,
                "-c",
                "import time; time.sleep(2)",
                cwd=self.release.ROOT,
                timeout=0.05,
            )

    def test_output_times_out_a_real_child_process(self):
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            self.release.output(
                sys.executable,
                "-c",
                "import time; time.sleep(2)",
                timeout=0.05,
            )


class ReleaseCiGateTest(unittest.TestCase):
    def setUp(self):
        self.release = load_release()
        self.tag = "v2026.10.02.99"
        self.commit = "a" * 40
        self.run_id = 123456
        self.check_suite_id = 424242

    def successful_run(self, **overrides):
        value = {
            "id": self.run_id,
            "check_suite_id": self.check_suite_id,
            "run_attempt": 1,
            "event": "push",
            "head_sha": self.commit,
            "display_title": self.release.release_run_title(self.tag),
            "path": ".github/workflows/ci.yml",
            "status": "completed",
            "conclusion": "success",
        }
        value.update(overrides)
        return value

    def successful_check(self, **overrides):
        value = {
            "name": self.release.RELEASE_CHECK_NAME,
            "head_sha": self.commit,
            "status": "completed",
            "conclusion": "success",
            "app": {"slug": "github-actions"},
            "check_suite": {"id": self.check_suite_id},
        }
        value.update(overrides)
        return value

    def verify_with(self, runs, checks):
        responses = [
            {"workflow_runs": runs},
            {"check_runs": checks},
        ]
        calls = []
        def fake_github_json(api_path):
            calls.append(api_path)
            return responses[len(calls) - 1]
        with mock.patch.object(
            self.release, "origin_repo", return_value=("OhiyoX", "obsidian-mcp-server")
        ):
            with mock.patch.object(self.release, "github_json", side_effect=fake_github_json):
                self.release.verify_release_tag_ci(self.tag, self.commit)
        return calls

    def test_origin_repo_accepts_https_and_scp_style_ssh(self):
        for remote in (
            "https://github.com/OhiyoX/obsidian-mcp-server.git",
            "git@github.com:OhiyoX/obsidian-mcp-server.git",
        ):
            with self.subTest(remote=remote):
                with mock.patch.object(self.release, "output", return_value=remote):
                    self.assertEqual(
                        self.release.origin_repo(),
                        ("OhiyoX", "obsidian-mcp-server"),
                    )

    def test_tag_ci_accepts_only_release_check_from_exact_successful_tag_run(self):
        calls = self.verify_with([self.successful_run()], [self.successful_check()])
        self.assertIn("/actions/workflows/ci.yml/runs", calls[0])
        self.assertNotIn("/actions/runs?", calls[0])
        self.assertIn(f"/check-suites/{self.check_suite_id}/check-runs", calls[1])

        rejected_runs = [
            [],
            [self.successful_run(event="pull_request")],
            [self.successful_run(head_sha="b" * 40)],
            [self.successful_run(display_title=self.release.release_run_title("v2026.10.02.98"))],
            [self.successful_run(check_suite_id=None)],
            [self.successful_run(status="in_progress", conclusion=None)],
            [self.successful_run(conclusion="failure")],
        ]
        for runs in rejected_runs:
            with self.subTest(runs=runs):
                with self.assertRaises(RuntimeError):
                    self.verify_with(runs, [self.successful_check()])

        rejected_checks = [
            [],
            [self.successful_check(name="app")],
            [self.successful_check(head_sha="b" * 40)],
            [self.successful_check(status="in_progress", conclusion=None)],
            [self.successful_check(conclusion="failure")],
            [self.successful_check(app={"slug": "other-ci"})],
            [self.successful_check(check_suite={"id": 999999})],
        ]
        for checks in rejected_checks:
            with self.subTest(checks=checks):
                with self.assertRaises(RuntimeError):
                    self.verify_with([self.successful_run()], checks)

    def test_publish_rechecks_origin_main_after_long_local_checks(self):
        with mock.patch.object(
            self.release,
            "verify_origin_main",
            side_effect=[None, RuntimeError("origin/main advanced")],
        ) as verify:
            with mock.patch.object(self.release, "require_clean"):
                with mock.patch.object(self.release, "checks"):
                    with mock.patch.object(self.release, "output", return_value="main"):
                        with mock.patch.object(self.release, "run") as run:
                            with self.assertRaisesRegex(RuntimeError, "origin/main advanced"):
                                self.release.publish(self.tag)
                            self.assertEqual(verify.call_count, 2)
                            run.assert_not_called()

    def test_remote_tag_commit_accepts_annotated_and_lightweight_tags(self):
        annotated = (
            f"{'b' * 40}\trefs/tags/{self.tag}\n"
            f"{self.commit}\trefs/tags/{self.tag}^{{}}\n"
        )
        lightweight = f"{self.commit}\trefs/tags/{self.tag}\n"
        for raw in (annotated, lightweight):
            with self.subTest(raw=raw):
                with mock.patch.object(self.release, "git_network", return_value=raw):
                    self.assertEqual(self.release.remote_tag_commit(self.tag), self.commit)

    def test_remote_tag_commit_rejects_missing_or_malformed_refs(self):
        for raw in ("", "not-a-valid-ls-remote-line"):
            with self.subTest(raw=raw):
                with mock.patch.object(self.release, "git_network", return_value=raw):
                    with self.assertRaises(RuntimeError):
                        self.release.remote_tag_commit(self.tag)

    def test_deploy_rejects_remote_tag_commit_mismatch_before_ci_or_nas(self):
        self.release.ROOT = Path("/repo")
        wrong = "b" * 40
        remote = f"{wrong}\trefs/tags/{self.tag}\n"
        with mock.patch.object(self.release, "require_clean"):
            with mock.patch.object(self.release, "verify_origin_main"):
                with mock.patch.object(self.release, "output", return_value=self.commit):
                    with mock.patch.object(self.release, "git_network", return_value=remote):
                        with mock.patch.object(self.release, "verify_release_tag_ci") as verify_ci:
                            with mock.patch.object(self.release, "run") as run:
                                with self.assertRaisesRegex(RuntimeError, "Remote tag"):
                                    self.release.deploy(
                                        self.tag,
                                        "nas",
                                        "/opt/test-project",
                                        False,
                                        False,
                                    )
                                verify_ci.assert_not_called()
                                run.assert_not_called()

    def test_deploy_revalidates_release_anchor_before_nas_side_effects(self):
        self.release.ROOT = Path("/repo")
        remote = f"{self.commit}\trefs/tags/{self.tag}\n"
        with mock.patch.object(
            self.release,
            "verify_origin_main",
            side_effect=[None, RuntimeError("origin/main advanced")],
        ) as verify:
            with mock.patch.object(self.release, "require_clean"):
                with mock.patch.object(self.release, "output", return_value=self.commit):
                    with mock.patch.object(self.release, "git_network", return_value=remote):
                        with mock.patch.object(self.release, "verify_release_tag_ci"):
                            with mock.patch.object(self.release, "run") as run:
                                with self.assertRaisesRegex(RuntimeError, "origin/main advanced"):
                                    self.release.deploy(
                                        self.tag,
                                        "nas",
                                        "/opt/test-project",
                                        False,
                                        False,
                                    )
                                self.assertEqual(verify.call_count, 2)
                                run.assert_not_called()

    def test_deploy_stops_before_remote_transfer_when_tag_ci_is_unverified(self):
        self.release.ROOT = Path("/repo")
        with mock.patch.object(self.release, "require_clean"):
            with mock.patch.object(self.release, "verify_origin_main"):
                with mock.patch.object(self.release, "output", return_value=self.commit):
                    remote = f"{self.commit}\trefs/tags/{self.tag}\n"
                    with mock.patch.object(
                        self.release, "git_network", return_value=remote
                    ):
                        with mock.patch.object(
                            self.release,
                            "verify_release_tag_ci",
                            side_effect=RuntimeError("tag CI not verified"),
                        ):
                            with mock.patch.object(self.release, "run") as run:
                                with self.assertRaisesRegex(RuntimeError, "tag CI not verified"):
                                    self.release.deploy(
                                        self.tag,
                                        "nas",
                                        "/opt/test-project",
                                        False,
                                        False,
                                    )
                                run.assert_not_called()

    def test_local_release_checks_reject_test_only_node_gate_environment(self):
        for name in (
            "NODE_TEST_GATE_TESTING",
            "NODE_TEST_GATE_HARNESS",
            "NODE_TEST_GATE_TIMEOUT_MS",
        ):
            with self.subTest(name=name):
                with mock.patch.dict(os.environ, {name: "set"}, clear=False):
                    with mock.patch.object(self.release, "run") as run:
                        with self.assertRaisesRegex(RuntimeError, "test-only Node gate overrides"):
                            self.release.checks()
                        run.assert_not_called()

    def test_local_release_checks_use_the_same_fail_closed_test_adapters(self):
        self.release.ROOT = Path("/repo")
        calls = []

        def fake_run(*args, **kwargs):
            calls.append((args, kwargs))

        with mock.patch.object(self.release, "run", side_effect=fake_run):
            with mock.patch.object(self.release, "require_clean"):
                self.release.checks()

        commands = [args for args, _kwargs in calls]
        self.assertIn(("npm", "audit", "--audit-level=low"), commands)
        self.assertIn(("node", "scripts/run-node-tests-ci.mjs"), commands)
        self.assertIn((sys.executable, "scripts/run-python-tests-ci.py"), commands)
        self.assertNotIn(("npm", "test"), commands)

    def test_workflow_has_tag_only_release_gate_depending_on_app_and_browser(self):
        workflow = (
            SCRIPT.parent.parent / ".github" / "workflows" / "ci.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("run-name: CI ${{ github.ref_type }}:${{ github.ref_name }}", workflow)
        self.assertIn("name: Release tag gate", workflow)
        self.assertIn("if: startsWith(github.ref, 'refs/tags/v')", workflow)
        self.assertIn("dependency-audit:", workflow)
        self.assertIn("name: Audit locked dependencies", workflow)
        self.assertIn("run: npm audit --audit-level=low", workflow)
        self.assertIn("needs: [app, browser, dependency-audit]", workflow)

    def test_project_resolution_prefers_the_explicit_cli_value(self):
        with mock.patch.dict(os.environ, {"OBSIDIAN_MCP_DEPLOY_PROJECT": "/opt/env-project"}):
            self.assertEqual(
                self.release.resolve_project("/opt/cli-project"), "/opt/cli-project"
            )

    def test_project_resolution_falls_back_to_the_protected_environment(self):
        with mock.patch.dict(os.environ, {"OBSIDIAN_MCP_DEPLOY_PROJECT": "/opt/env-project"}):
            self.assertEqual(self.release.resolve_project(None), "/opt/env-project")

    def test_project_resolution_fails_locally_when_both_sources_are_missing(self):
        with mock.patch.dict(os.environ, {"OBSIDIAN_MCP_DEPLOY_PROJECT": ""}):
            with self.assertRaisesRegex(RuntimeError, "OBSIDIAN_MCP_DEPLOY_PROJECT"):
                self.release.resolve_project(None)

    def test_deploy_requires_a_project_before_any_remote_side_effect(self):
        self.release.ROOT = Path("/repo")
        with mock.patch.dict(os.environ, {"OBSIDIAN_MCP_DEPLOY_PROJECT": ""}):
            with mock.patch.object(self.release, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Deploy target is required"):
                    self.release.deploy(self.tag, "nas", None, False, False)
                run.assert_not_called()

    def test_rollback_uses_the_same_resolution_and_fails_before_any_remote_side_effect(self):
        with mock.patch.dict(os.environ, {"OBSIDIAN_MCP_DEPLOY_PROJECT": ""}):
            with mock.patch.object(self.release, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Deploy target is required"):
                    self.release.rollback(self.tag, "nas", None)
                run.assert_not_called()
        with mock.patch.dict(os.environ, {"OBSIDIAN_MCP_DEPLOY_PROJECT": "/opt/env-project"}):
            with mock.patch.object(self.release, "run") as run:
                self.release.rollback(self.tag, "nas", None)
                run.assert_called_once()
                command = " ".join(run.call_args[0])
                self.assertIn("/opt/env-project/.deploy-state/incoming/nas_deploy.py", command)


OPT_IN_HELP = "默认严格；--binding-sha 为 opt-in 逃生门，仅用于窗口绑定"


class ReleaseBindingShaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.release = load_release()
        self.release.ROOT = self.repo
        self.git("init")
        self.git("config", "user.email", "release-test@example.com")
        self.git("config", "user.name", "Release Test")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgsign", "false")
        (self.repo / "README").write_text("base\n", encoding="utf-8")
        self.git("add", "README")
        self.git("commit", "-m", "base")
        self.ancestor = self.git("rev-parse", "HEAD").stdout.strip()
        (self.repo / "README").write_text("main\n", encoding="utf-8")
        self.git("add", "README")
        self.git("commit", "-m", "main advances")
        self.head = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("branch", "-M", "main")
        self.git("update-ref", "refs/remotes/origin/main", self.head)
        self.tag = "v2026.10.11.1"
        self.head_tag = "v2026.10.11.2"
        self.git("tag", "-a", self.tag, self.ancestor, "-m", "window")
        self.git("tag", "-a", self.head_tag, self.head, "-m", "head")
        self.git("checkout", "-b", "side")
        (self.repo / "README").write_text("side\n", encoding="utf-8")
        self.git("add", "README")
        self.git("commit", "-m", "unmerged")
        self.side = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("checkout", "main")
        self.missing = "deadbeef" * 5
        self.other = "b" * 40

    def git(self, *args):
        return subprocess.run(
            ("git", *args),
            cwd=self.repo,
            text=True,
            capture_output=True,
            check=True,
        )

    def queue_text(self, sha):
        return (
            f"### 窗口 #9（**当前**）\n"
            f"| 绑定 | **`{sha}`**（取一次、不回追）\n"
            f"### 窗口 #8（**历史**）\n"
            f"| 绑定 | **`{self.other}`**\n"
        )

    def test_deploy_help_states_the_opt_in_and_publish_help_does_not(self):
        deploy_help = subprocess.run(
            [sys.executable, str(SCRIPT), "deploy", "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        publish_help = subprocess.run(
            [sys.executable, str(SCRIPT), "publish", "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(deploy_help.returncode, 0, deploy_help.stderr)
        self.assertIn(OPT_IN_HELP, deploy_help.stdout)
        self.assertIn("--binding-sha", deploy_help.stdout)
        self.assertIn("--binding-note", deploy_help.stdout)
        self.assertEqual(publish_help.returncode, 0, publish_help.stderr)
        self.assertNotIn("binding-sha", publish_help.stdout)
        self.assertNotIn(OPT_IN_HELP, publish_help.stdout)

    def test_window_binding_is_the_first_block_only(self):
        self.assertEqual(
            self.release.extract_window_binding(self.queue_text(self.ancestor)),
            self.ancestor,
        )
        unlabeled = (
            "### 窗口 #1（**当前**）\n"
            f"| 占用 | `{self.ancestor}`\n"
            "### 窗口 #0（**历史**）\n"
            f"| 绑定 | **`{self.other}`**\n"
        )
        self.assertIsNone(self.release.extract_window_binding(unlabeled))
        self.assertIsNone(
            self.release.extract_window_binding(
                "### 窗口 #1\n| 绑定 | **`abcd1234`**\n"
            )
        )
        ambiguous = (
            "### 窗口 #1\n"
            f"| 绑定 | **`{self.ancestor}`** **`{self.other}`**\n"
        )
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            self.release.extract_window_binding(ambiguous)
        self.assertIsNone(self.release.extract_window_binding("no window here"))

    def test_binding_sha_accepts_full_short_and_uppercase_when_consistent(self):
        queue = self.queue_text(self.ancestor)
        for raw in (self.ancestor, self.ancestor.upper(), self.ancestor[:12]):
            with self.subTest(raw=raw):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    resolved = self.release.resolve_binding_anchor(
                        raw, queue_text=queue
                    )
                self.assertEqual(resolved, self.ancestor)
                self.assertEqual(stderr.getvalue(), "")

    def test_binding_sha_rejects_an_unreachable_object(self):
        with self.assertRaises(RuntimeError) as caught:
            self.release.resolve_binding_anchor(
                self.missing, queue_text=self.queue_text(self.missing)
            )
        self.assertIn("not a reachable object", str(caught.exception))
        self.assertIn(self.missing, str(caught.exception))

    def test_binding_sha_rejects_a_non_ancestor(self):
        with self.assertRaises(RuntimeError) as caught:
            self.release.resolve_binding_anchor(
                self.side, queue_text=self.queue_text(self.side)
            )
        self.assertEqual(
            str(caught.exception),
            f"Binding SHA {self.side} is not an ancestor of origin/main",
        )

    def test_binding_sha_rejects_a_window_mismatch(self):
        with self.assertRaises(RuntimeError) as caught:
            self.release.resolve_binding_anchor(
                self.ancestor, queue_text=self.queue_text(self.head)
            )
        self.assertEqual(
            str(caught.exception),
            f"Binding SHA {self.ancestor} does not match the window binding {self.head}",
        )
        note = f"绑定 {self.other}"
        with self.assertRaises(RuntimeError) as caught_note:
            self.release.resolve_binding_anchor(
                self.ancestor,
                binding_note=note,
                queue_text=None,
            )
        self.assertEqual(
            str(caught_note.exception),
            f"Binding SHA {self.ancestor} does not match the window binding {self.other}",
        )
        with self.assertRaisesRegex(RuntimeError, "does not match the binding note"):
            self.release.resolve_binding_anchor(
                self.ancestor,
                binding_note=f"绑定 {self.other}",
                queue_text=self.queue_text(self.ancestor),
            )

    def test_missing_window_binding_warns_and_still_returns_the_anchor(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            resolved = self.release.resolve_binding_anchor(
                self.ancestor,
                binding_note="no sha here",
                queue_text="### 窗口 #1\n| 状态 | open\n",
            )
        self.assertEqual(resolved, self.ancestor)
        self.assertEqual(stderr.getvalue().strip(), self.release.BINDING_UNVERIFIED_WARNING)

    def test_malformed_binding_sha_is_rejected_before_git(self):
        for raw in ("", "abc", "gggg", "not-a-sha"):
            with self.subTest(raw=raw):
                with mock.patch.object(
                    self.release,
                    "require_reachable_object",
                    side_effect=AssertionError("git must not run"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "40 hex characters"):
                        self.release.resolve_binding_anchor(raw, queue_text=None)

    def test_reachable_non_commit_is_rejected(self):
        blob = self.git("hash-object", "-w", "README").stdout.strip()
        with self.assertRaisesRegex(RuntimeError, "not a commit"):
            self.release.resolve_binding_anchor(blob, queue_text=self.queue_text(blob))

    def _patch_deploy_side_effects(self, remote_commit):
        remote = f"{remote_commit}\trefs/tags/IGNORED\n"
        return (
            mock.patch.object(self.release, "require_clean"),
            mock.patch.object(self.release, "verify_origin_main"),
            mock.patch.object(self.release, "git_network", return_value=remote),
            mock.patch.object(self.release, "verify_release_tag_ci"),
            mock.patch.object(self.release, "run"),
        )

    def test_default_deploy_still_rejects_when_main_has_advanced(self):
        patches = self._patch_deploy_side_effects(self.ancestor)
        with patches[0], patches[1], patches[2] as git_network, patches[3] as verify_ci, patches[4] as run:
            with mock.patch.object(
                self.release,
                "resolve_binding_anchor",
                side_effect=AssertionError("default path must not resolve a binding"),
            ):
                with mock.patch.object(
                    self.release,
                    "read_deploy_queue_text",
                    side_effect=AssertionError("default path must not read the queue"),
                ):
                    stderr = io.StringIO()
                    with contextlib.redirect_stderr(stderr):
                        with self.assertRaisesRegex(
                            RuntimeError,
                            r"^Deploy only the tag at current origin/main HEAD$",
                        ):
                            self.release.deploy(
                                self.tag, "nas", "/opt/test-project", False, False
                            )
        self.assertEqual(stderr.getvalue(), "")
        git_network.assert_not_called()
        verify_ci.assert_not_called()
        run.assert_not_called()

    def test_default_deploy_command_sequence_when_tag_is_origin_main_head(self):
        events = []
        remote = f"{self.head}\trefs/tags/{self.head_tag}\n"

        def note_output(*args, **kwargs):
            events.append(("output", args))
            return orig_output(*args, **kwargs)

        def note_network(*args, **kwargs):
            events.append(("git_network", args))
            return remote

        def note_ci(tag, commit):
            events.append(("ci", tag, commit))

        def note_origin():
            events.append(("verify_origin_main",))

        def note_clean():
            events.append(("require_clean",))

        def note_run(*args, **kwargs):
            events.append(("run", args[0]))

        orig_output = self.release.output
        with mock.patch.object(self.release, "require_clean", side_effect=note_clean):
            with mock.patch.object(self.release, "verify_origin_main", side_effect=note_origin):
                with mock.patch.object(self.release, "output", side_effect=note_output):
                    with mock.patch.object(self.release, "git_network", side_effect=note_network):
                        with mock.patch.object(self.release, "verify_release_tag_ci", side_effect=note_ci):
                            with mock.patch.object(self.release, "run", side_effect=note_run):
                                with mock.patch.object(
                                    self.release,
                                    "resolve_binding_anchor",
                                    side_effect=AssertionError("default path must not resolve"),
                                ):
                                    self.release.deploy(
                                        self.head_tag,
                                        "nas",
                                        "/opt/test-project",
                                        False,
                                        False,
                                    )
        self.assertEqual(
            events,
            [
                ("require_clean",),
                ("verify_origin_main",),
                ("output", ("git", "rev-parse", f"refs/tags/{self.head_tag}^{{commit}}")),
                ("output", ("git", "rev-parse", "HEAD")),
                ("git_network", ("ls-remote", "origin", f"refs/tags/{self.head_tag}", f"refs/tags/{self.head_tag}^{{}}")),
                ("ci", self.head_tag, self.head),
                ("verify_origin_main",),
                ("output", ("git", "rev-parse", f"refs/tags/{self.head_tag}^{{commit}}")),
                ("git_network", ("ls-remote", "origin", f"refs/tags/{self.head_tag}", f"refs/tags/{self.head_tag}^{{}}")),
                ("run", "git"),
                ("run", "ssh"),
                ("run", "scp"),
                ("run", "scp"),
                ("run", "ssh"),
            ],
        )

    def test_binding_sha_deploy_keeps_tag_ci_before_side_effects(self):
        events = []
        remote = f"{self.ancestor}\trefs/tags/{self.tag}\n"

        def note_resolve(raw, binding_note=None, queue_text=self.release._QUEUE_UNSET):
            events.append(("resolve",))
            return orig_resolve(raw, binding_note, queue_text)

        def note_network(*args, **kwargs):
            events.append(("remote",))
            return remote

        def note_ci(tag, commit):
            events.append(("ci", tag, commit))

        def note_anchor(tag, commit):
            events.append(("anchor", tag, commit))
            return orig_anchor(tag, commit)

        def note_run(*args, **kwargs):
            events.append(("run", args[0]))

        orig_resolve = self.release.resolve_binding_anchor
        orig_anchor = self.release.verify_release_anchor
        stderr = io.StringIO()
        with mock.patch.object(self.release, "require_clean"):
            with mock.patch.object(self.release, "verify_origin_main"):
                with mock.patch.object(self.release, "read_deploy_queue_text", return_value=self.queue_text(self.ancestor)):
                    with mock.patch.object(self.release, "resolve_binding_anchor", side_effect=note_resolve):
                        with mock.patch.object(self.release, "git_network", side_effect=note_network):
                            with mock.patch.object(self.release, "verify_release_tag_ci", side_effect=note_ci):
                                with mock.patch.object(self.release, "verify_release_anchor", side_effect=note_anchor):
                                    with mock.patch.object(self.release, "run", side_effect=note_run):
                                        with contextlib.redirect_stderr(stderr):
                                            self.release.deploy(
                                                self.tag,
                                                "nas",
                                                "/opt/test-project",
                                                False,
                                                False,
                                                binding_sha=self.ancestor[:12],
                                            )
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(
            events[:5],
            [
                ("resolve",),
                ("remote",),
                ("ci", self.tag, self.ancestor),
                ("anchor", self.tag, self.ancestor),
                ("remote",),
            ],
        )
        self.assertEqual(events[5], ("run", "git"))
        self.assertLess(
            [kind for kind, *rest in events].index("ci"),
            [kind for kind, *rest in events].index("run"),
        )

    def test_binding_sha_deploy_negatives_stop_before_tag_ci(self):
        cases = (
            ("unreachable", self.missing, self.queue_text(self.ancestor), "not a reachable object"),
            ("not-ancestor", self.side, self.queue_text(self.side), "not an ancestor of origin/main"),
            ("window-mismatch", self.ancestor, self.queue_text(self.head), "does not match the window binding"),
            (
                "tag-peel-mismatch",
                self.head,
                self.queue_text(self.head),
                "does not equal the binding anchor",
            ),
        )
        for name, binding, queue, pattern in cases:
            with self.subTest(name=name):
                with mock.patch.object(self.release, "require_clean"):
                    with mock.patch.object(self.release, "verify_origin_main"):
                        with mock.patch.object(self.release, "read_deploy_queue_text", return_value=queue):
                            with mock.patch.object(self.release, "verify_release_tag_ci") as verify_ci:
                                with mock.patch.object(self.release, "run") as run:
                                    with self.assertRaisesRegex(RuntimeError, pattern):
                                        self.release.deploy(
                                            self.tag,
                                            "nas",
                                            "/opt/test-project",
                                            False,
                                            False,
                                            binding_sha=binding,
                                        )
                                    verify_ci.assert_not_called()
                                    run.assert_not_called()

    def test_unreadable_window_without_binding_note_fails_closed(self):
        """Owner ruling (b): no window binding and no --binding-note is a hard stop.

        Replaces test_unreadable_window_warns_but_tag_ci_still_runs, which
        expected the warning and a later verify_release_tag_ci call.
        """
        remote = f"{self.ancestor}\trefs/tags/{self.tag}\n"
        stderr = io.StringIO()
        with mock.patch.object(self.release, "require_clean"):
            with mock.patch.object(self.release, "verify_origin_main"):
                with mock.patch.object(self.release, "read_deploy_queue_text", return_value=None):
                    with mock.patch.object(self.release, "git_network", return_value=remote) as git_network:
                        with mock.patch.object(self.release, "verify_release_tag_ci") as verify_ci:
                            with mock.patch.object(self.release, "run") as run:
                                with contextlib.redirect_stderr(stderr):
                                    with self.assertRaises(RuntimeError) as caught:
                                        self.release.deploy(
                                            self.tag,
                                            "nas",
                                            "/opt/test-project",
                                            False,
                                            False,
                                            binding_sha=self.ancestor,
                                        )
        self.assertEqual(str(caught.exception), self.release.BINDING_UNVERIFIED_FAIL_CLOSED)
        self.assertNotIn(self.release.BINDING_UNVERIFIED_WARNING, stderr.getvalue())
        verify_ci.assert_not_called()
        run.assert_not_called()
        git_network.assert_not_called()

    def test_binding_note_without_window_still_reaches_tag_ci(self):
        events = []
        remote = f"{self.ancestor}\trefs/tags/{self.tag}\n"

        def note_resolve(raw, binding_note=None, queue_text=self.release._QUEUE_UNSET):
            events.append(("resolve", raw, binding_note))
            return orig_resolve(raw, binding_note, queue_text)

        def note_network(*args, **kwargs):
            events.append(("remote", args[0] if args else ()))
            return remote

        def note_ci(tag, commit):
            events.append(("ci", tag, commit))

        def note_anchor(tag, commit):
            events.append(("anchor", tag, commit))

        def note_run(*args, **kwargs):
            events.append(("run", args[0]))

        orig_resolve = self.release.resolve_binding_anchor
        stderr = io.StringIO()
        with mock.patch.object(self.release, "require_clean"):
            with mock.patch.object(self.release, "verify_origin_main"):
                with mock.patch.object(self.release, "read_deploy_queue_text", return_value=None):
                    with mock.patch.object(self.release, "resolve_binding_anchor", side_effect=note_resolve):
                        with mock.patch.object(self.release, "git_network", side_effect=note_network):
                            with mock.patch.object(self.release, "verify_release_tag_ci", side_effect=note_ci):
                                with mock.patch.object(self.release, "verify_release_anchor", side_effect=note_anchor):
                                    with mock.patch.object(self.release, "run", side_effect=note_run):
                                        with contextlib.redirect_stderr(stderr):
                                            self.release.deploy(
                                                self.tag,
                                                "nas",
                                                "/opt/test-project",
                                                False,
                                                False,
                                                binding_sha=self.ancestor,
                                                binding_note="no sha here",
                                            )
        self.assertEqual(stderr.getvalue().strip(), self.release.BINDING_UNVERIFIED_WARNING)
        self.assertEqual(
            events[:3],
            [
                ("resolve", self.ancestor, "no sha here"),
                ("remote", "ls-remote"),
                ("ci", self.tag, self.ancestor),
            ],
        )

    def test_verify_release_tag_ci_stays_before_archive(self):
        source = SCRIPT.read_text(encoding="utf-8")
        deploy_src = source.split("def deploy(", 1)[1].split("\ndef rollback(", 1)[0]
        ci_fn = source.split("def verify_release_tag_ci(", 1)[1].split("\ndef require_clean(", 1)[0]
        self.assertIn('raise RuntimeError("Deploy only the tag at current origin/main HEAD")', deploy_src)
        self.assertLess(
            deploy_src.index("remote_tag_commit(tag)"),
            deploy_src.index("verify_release_tag_ci(tag, commit)"),
        )
        self.assertLess(
            deploy_src.index("verify_release_tag_ci(tag, commit)"),
            deploy_src.index('run("git", "archive"'),
        )
        self.assertIn("Tag CI is not verified", ci_fn)
        self.assertNotIn("binding", ci_fn)

    def test_release_doc_tracking_line_records_the_opt_in(self):
        doc = (SCRIPT.parent.parent / "docs" / "RELEASE_AND_DEPLOY.md").read_text(encoding="utf-8")
        self.assertIn("opt-in 已提供、默认仍不启用", doc)
        self.assertNotIn("default to no change", doc)


if __name__ == "__main__":
    unittest.main()
