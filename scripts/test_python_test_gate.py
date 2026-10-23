import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name("run-python-tests-ci.py")


def load_gate():
    spec = importlib.util.spec_from_file_location("run_python_tests_ci", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PythonCiTestGateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gate = load_gate()

    def test_accepts_nonzero_clean_result(self):
        self.assertEqual(
            self.gate.evaluate_result(0, "", "Ran 10 tests in 0.1s\n\nOK\n"),
            [],
        )

    def test_rejects_zero_or_qualified_ok_results(self):
        zero = self.gate.evaluate_result(0, "", "Ran 0 tests in 0.0s\n\nOK\n")
        self.assertTrue(any("zero tests" in item for item in zero))

        for qualifier in (
            "skipped=1",
            "expected failures=1",
            "skipped=0",
            "unknown",
            "skipped=not-a-number",
        ):
            with self.subTest(qualifier=qualifier):
                problems = self.gate.evaluate_result(
                    0, "", f"Ran 10 tests in 0.1s\n\nOK ({qualifier})\n"
                )
                self.assertTrue(any("qualified OK result" in item for item in problems))

    def test_rejects_ok_followed_by_trailing_output(self):
        problems = self.gate.evaluate_result(
            0, "", "Ran 10 tests in 0.1s\n\nOK\ntrailing unexpected output\n"
        )
        self.assertTrue(any("final Python unittest result line" in item for item in problems))

    def test_rejects_nonzero_exit_and_missing_summary(self):
        problems = self.gate.evaluate_result(2, "", "boom\n")
        self.assertTrue(any("exited with code 2" in item for item in problems))
        self.assertTrue(any("missing Python unittest result count" in item for item in problems))
        self.assertTrue(any("missing final Python unittest OK result" in item for item in problems))

    def test_real_timeout_path_returns_failure(self):
        _, _, _, problems = self.gate.run_suite(
            [sys.executable, "-c", "import time; time.sleep(2)"],
            timeout=0.05,
        )
        self.assertTrue(any("timed out" in item for item in problems))

    def test_cli_rejects_filter_arguments_without_running_discovery(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--pattern", "one"],
            cwd=SCRIPT.parent.parent,
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("filtering/extra CLI arguments are disabled", result.stderr)


if __name__ == "__main__":
    unittest.main()
