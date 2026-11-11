"""Exercise the file-only release path without touching Docker or a real NAS."""

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("nas_deploy.py")
COMMIT = "a" * 40


class NasDeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / "docker-compose.yaml").write_bytes(b"services: {}\n")
        (self.project / ".env").write_text("secret=kept\n", encoding="utf-8")
        (self.project / "data").mkdir()
        (self.project / "data" / "keep").write_text("vault state", encoding="utf-8")
        (self.project / "README.md").write_bytes(b"old\n")
        self.archive = self.root / "release.tar"
        self.make_archive({"docker-compose.yaml": b"services: {}\n", "README.md": b"new\n"})

    def make_archive(self, files):
        with tarfile.open(self.archive, "w") as tar:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))

    def command(self, mode, tag="v2026.09.24", *extra):
        args = [sys.executable, str(SCRIPT), mode, "--project", str(self.project),
                "--tag", tag]
        if mode != "rollback":
            args += ["--archive", str(self.archive), "--commit", COMMIT]
        return subprocess.run(args + list(extra), text=True, capture_output=True)

    def test_preview_apply_drift_and_rollback(self):
        preview = self.command("check")
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertIn('"first_deploy_requires_adopt": true', preview.stdout)
        self.assertEqual(self.command("apply").returncode, 1)
        applied = self.command("apply", "v2026.09.24", "--adopt")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual((self.project / "README.md").read_text(), "new\n")
        self.assertEqual((self.project / ".env").read_text(), "secret=kept\n")
        self.assertEqual((self.project / "data" / "keep").read_text(), "vault state")
        manifest = self.project / "data" / "deployed-version.json"
        self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["version"], "v2026.09.24")
        self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["commit"], COMMIT)
        (self.project / "README.md").write_text("manual edit\n")
        self.make_archive({"docker-compose.yaml": b"services: {}\n", "README.md": b"newer\n"})
        rejected = self.command("apply", "v2026.09.24.1")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("drift", rejected.stdout)
        self.assertIn("Production drift", rejected.stderr)
        self.assertNotEqual(self.command("rollback").returncode, 0)
        (self.project / "README.md").write_bytes(b"new\n")
        rolled_back = self.command("rollback")
        self.assertEqual(rolled_back.returncode, 0, rolled_back.stderr)
        self.assertEqual((self.project / "README.md").read_text(), "old\n")
        self.assertFalse(manifest.exists())

    def test_archive_rejects_secrets_and_parent_traversal(self):
        for name in (".env", "../escape", "data/secret.txt"):
            with self.subTest(name=name):
                self.make_archive({"docker-compose.yaml": b"services: {}\n", name: b"bad"})
                result = self.command("check")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Unsafe archive path", result.stderr)

    def test_example_environment_is_allowed(self):
        self.make_archive({"docker-compose.yaml": b"services: {}\n",
                           ".env.example": b"API_KEY=\n"})
        result = self.command("check")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_line_endings_do_not_force_rebuild(self):
        (self.project / "app").mkdir()
        (self.project / "app" / "Dockerfile").write_bytes(b"FROM node:22\r\n")
        self.make_archive({"docker-compose.yaml": b"services: {}\n",
                           "app/Dockerfile": b"FROM node:22\n",
                           "README.md": b"old\n"})
        result = self.command("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"changes": []', result.stdout)
        self.assertIn('"action": "files-only"', result.stdout)


    def test_health_url_is_the_published_loopback_port(self):
        spec = importlib.util.spec_from_file_location("nas_deploy_for_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        # The plaintext port is published on 127.0.0.1 only, so the deploy checks it there.
        (self.project / ".env").write_text(
            "MCP_BIND_ADDR=192.0.2.9\nMCP_PORT=18923\n", encoding="utf-8")
        self.assertEqual(module.health_url(self.project), "http://127.0.0.1:18923/healthz")

        (self.project / ".env").write_text("MCP_BIND_ADDR=0.0.0.0\n", encoding="utf-8")
        self.assertEqual(module.health_url(self.project), "http://127.0.0.1:18923/healthz")

    def test_a_code_change_rebuilds_the_image(self):
        # Compose mounts no source over /app, so a restart would serve the previous image.
        (self.project / "app").mkdir()
        (self.project / "app" / "server.js").write_bytes(b"old server\n")
        for name in ("app/server.js", "app/src/app/routes.js", "app/src/app/assets/app.js"):
            with self.subTest(name=name):
                self.make_archive({"docker-compose.yaml": b"services: {}\n", name: b"new bytes\n"})
                result = self.command("check")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('"action": "rebuild"', result.stdout)

    def test_non_code_changes_do_not_rebuild(self):
        self.make_archive({"docker-compose.yaml": b"services: {}\n", "README.md": b"new\n"})
        result = self.command("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"action": "files-only"', result.stdout)

    def test_rebuild_override_is_reported_in_the_preview(self):
        # The one-off case: the image predates the payload, so compose and code are unchanged and
        # the inventory alone would only sync files.
        self.make_archive({"docker-compose.yaml": b"services: {}\n", "README.md": b"new\n"})
        result = self.command("check", "v2026.09.24", "--rebuild")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"action": "rebuild"', result.stdout)

    def test_ops_log_directory_is_prepared_for_the_runtime_uid(self):
        spec = importlib.util.spec_from_file_location("nas_deploy_for_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        target = self.project / "data" / "ops-log"
        module.ensure_ops_log_dir(self.project)
        self.assertTrue(target.is_dir(), "a missing bind source would be created as root:root")

        with mock.patch.object(module.os, "geteuid", return_value=0), \
                mock.patch.object(module.os, "chown") as chown:
            module.ensure_ops_log_dir(self.project)
            chown.assert_called_once()
            self.assertEqual(chown.call_args[0][1:], (1002, 10))

    def test_pending_mutation_journal_blocks_code_rollback(self):
        applied = self.command("apply", "v2026.09.24", "--adopt")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        journal = self.project / "data" / "mutation-journal" / ("a" * 36)
        journal.mkdir(parents=True)
        (journal / "manifest.json").write_text('{"state":"committing"}', encoding="utf-8")
        rejected = self.command("rollback")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("Pending mutation journal", rejected.stderr)
        self.assertEqual((self.project / "README.md").read_text(), "new\n")


if __name__ == "__main__":
    unittest.main()
