"""Exercise the file-only release path without touching Docker or a real NAS."""

import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


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
