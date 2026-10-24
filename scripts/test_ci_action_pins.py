import re
from pathlib import Path
import unittest


WORKFLOW_DIR = Path(__file__).resolve().parent.parent / ".github" / "workflows"
USES_RE = re.compile(r"^\s*-\s+uses:\s+(.+?)\s*$", re.MULTILINE)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class CiActionPinTest(unittest.TestCase):
    def test_all_remote_workflow_actions_use_full_commit_shas(self):
        workflows = sorted(
            [*WORKFLOW_DIR.glob("*.yml"), *WORKFLOW_DIR.glob("*.yaml")]
        )
        self.assertTrue(workflows, "expected at least one GitHub Actions workflow")

        remote_uses = []
        for workflow in workflows:
            text = workflow.read_text(encoding="utf-8")
            for raw in USES_RE.findall(text):
                spec = raw.split(" #", 1)[0].strip().strip("'\"")
                if spec.startswith("./") or spec.startswith("docker://"):
                    continue
                remote_uses.append((workflow.name, spec))
                self.assertIn("@", spec, f"{workflow.name}: remote action must pin a ref: {spec}")
                _action, ref = spec.rsplit("@", 1)
                self.assertRegex(
                    ref,
                    SHA_RE,
                    f"{workflow.name}: remote action must use a full commit SHA: {spec}",
                )

        self.assertTrue(remote_uses, "expected at least one remote action reference")

    def test_playwright_uses_the_exact_local_runtime(self):
        workflow = (WORKFLOW_DIR / "ci.yml").read_text(encoding="utf-8")
        self.assertIn(
            'npm install --no-save --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION"',
            workflow,
        )
        # Playwright must always be resolved through the local runtime, never a
        # globally installed or npx-fetched copy.
        self.assertIn("run: ./node_modules/.bin/playwright --version", workflow)
        self.assertNotIn("npx playwright", workflow)
        # The browser must come from somewhere explicit: either installed locally
        # together with its OS dependencies, or provided by the runner image -- in
        # which case its location is pinned and the image is verified before use.
        installs_locally = (
            "run: ./node_modules/.bin/playwright install --with-deps chromium" in workflow
        )
        uses_runner_browser = (
            "PLAYWRIGHT_BROWSERS_PATH: /ms-playwright" in workflow
            and 'ls -d "${PLAYWRIGHT_BROWSERS_PATH}"/chromium-*' in workflow
        )
        self.assertTrue(
            installs_locally or uses_runner_browser,
            "ci.yml must either install Chromium locally with its OS dependencies "
            "or pin and verify a runner-provided Chromium",
        )


if __name__ == "__main__":
    unittest.main()
