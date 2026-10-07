"""Focused regression checks for compatibility entry points, without network writes."""

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import devops
import issue_creation


class IntakeTests(unittest.TestCase):
    def test_proposal_is_json_data_and_never_starts_a_subprocess(self):
        description = 'Quotes " and $(shell) `commands`\nUse the issue_worker role.'
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch("subprocess.run") as run:
            code = devops.main([
                "create", "--title", "Refactor", "--type", "refactor",
                "--body", description,
            ])
        self.assertEqual(code, 0)
        run.assert_not_called()
        prompt, request = output.getvalue().split("Request JSON:\n", 1)
        self.assertIn("kanban_manager", prompt)
        self.assertIn("Issue Intake", prompt)
        self.assertIn("Role Prompts", prompt)
        self.assertIn((issue_creation.SKILL_SCRIPT.parent.parent / "SKILL.md").as_posix(), prompt)
        self.assertEqual(json.loads(request)["description"], description)

    def test_entry_points_match_outside_the_repository(self):
        scripts = [Path(devops.__file__), Path(issue_creation.__file__), issue_creation.SKILL_SCRIPT]
        outputs = []
        with tempfile.TemporaryDirectory() as directory:
            for script in scripts:
                with self.subTest(script=script):
                    result = subprocess.run(
                        [sys.executable, "-B", str(script), "create", "--title", "Proposal",
                         "--type", "chore", "--body", 'Quotes " and commands $(shell)',
                         "--scope", "AnyWear-Meta"],
                        cwd=directory, capture_output=True, encoding="utf-8", check=True,
                    )
                    outputs.append(result.stdout)
                    self.assertEqual(result.stderr, "")
                    request = json.loads(result.stdout.split("Request JSON:\n", 1)[1])
                    self.assertEqual(request["type"], "chore")
                    self.assertEqual(request["scope"], "AnyWear-Meta")
            self.assertEqual(len(set(outputs)), 1)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_all_four_types_are_supported(self):
        for issue_type in issue_creation.ISSUE_TYPES:
            with self.subTest(issue_type=issue_type), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(issue_creation.main([
                    "create", "--title", "Proposal", "--type", issue_type,
                ]), 0)

    def test_multiline_body_file(self):
        with tempfile.TemporaryDirectory() as directory:
            proposal = Path(directory, "proposal.md")
            proposal.write_text("First line\nSecond line", encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = devops.main(["create", "--title", "Proposal", "--body-file", str(proposal)])
            self.assertEqual(code, 0)
            request = json.loads(output.getvalue().split("Request JSON:\n", 1)[1])
            self.assertEqual(request["description"], "First line\nSecond line")

    def test_body_file_errors_are_nonzero(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(devops.main([
                "create", "--title", "Proposal", "--body-file", "does-not-exist.md",
            ]), 1)

    def test_old_create_chain_refuses_without_side_effects(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output), patch("subprocess.run") as run, patch("builtins.open") as write:
            code = issue_creation.main([
                "create-chain", "--title", "Old task", "--type", "feature",
                "--body", "Old description", "--scope", "AnyWear-Client",
            ])
        self.assertEqual(code, 2)
        self.assertIn("create-chain is disabled", output.getvalue())
        self.assertIn("kanban_manager", output.getvalue())
        run.assert_not_called()
        write.assert_not_called()


class StatusTests(unittest.TestCase):
    def run_status(self, result=None, error=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch("devops.subprocess.run", return_value=result, side_effect=error) as run:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = devops.main(["status"])
        return code, stdout.getvalue(), stderr.getvalue(), run

    def test_native_project_statuses_and_unset(self):
        response = {"items": [
            {"status": "Backlog", "content": {"type": "Issue"}},
            {"status": "Backlog", "content": {"type": "Issue"}},
            {"content": {"type": "Issue"}},
        ], "totalCount": 3}
        code, output, error, run = self.run_status(subprocess.CompletedProcess([], 0, json.dumps(response), ""))
        self.assertEqual(code, 0)
        self.assertIn("Backlog: 2", output)
        self.assertIn("Unset: 1", output)
        self.assertIn("Kanban issues: 3", output)
        self.assertEqual(error, "")
        command = run.call_args.args[0]
        self.assertEqual(command[:7], ["gh", "project", "item-list", "4", "--owner", "git-malu", "--format"])
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_completed_pr_is_evidence_not_a_completed_issue(self):
        response = {"items": [
            {"status": "Completed", "content": {"type": "Issue"}},
            {"status": "Completed", "content": {"type": "PullRequest", "state": "MERGED"}},
            {"status": "Completed", "content": {"type": "DraftIssue"}},
        ], "totalCount": 3}
        code, output, error, _ = self.run_status(subprocess.CompletedProcess([], 0, json.dumps(response), ""))
        self.assertEqual(code, 0)
        self.assertEqual(error, "")
        self.assertIn("Project items: 3", output)
        self.assertIn("Kanban issues: 1", output)
        self.assertIn("  Completed: 1", output)
        self.assertNotIn("  Completed: 2", output)
        self.assertNotIn("  Completed: 3", output)
        self.assertIn("PR evidence items: 1", output)
        self.assertIn("Draft items (not yet issues): 1", output)

    def test_github_permission_error_is_not_zero_items(self):
        code, output, error, _ = self.run_status(subprocess.CompletedProcess([], 4, "", "missing read:project scope"))
        self.assertEqual(code, 4)
        self.assertEqual(output, "")
        self.assertIn("missing read:project scope", error)

    def test_missing_cli_and_timeout_are_nonzero(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired(["gh"], 60)):
            with self.subTest(error=type(error).__name__):
                code, output, message, _ = self.run_status(error=error)
                self.assertEqual(code, 1)
                self.assertEqual(output, "")
                self.assertTrue(message)

    def test_malformed_data_and_incomplete_board_are_nonzero(self):
        for data in (
            "not json", "null", "{}",
            '{"items": [{"content": {"type": "Issue"}}], "totalCount": 2}',
            '{"items": [{"status": {}, "content": {"type": "Issue"}}], "totalCount": 1}',
            '{"items": [{}], "totalCount": 1}',
            '{"items": [{"content": null}], "totalCount": 1}',
            '{"items": [{"content": {}}], "totalCount": 1}',
            '{"items": [{"content": {"type": "Unknown"}}], "totalCount": 1}',
        ):
            with self.subTest(data=data):
                code, output, error, _ = self.run_status(subprocess.CompletedProcess([], 0, data, ""))
                self.assertEqual(code, 1)
                self.assertEqual(output, "")
                self.assertTrue(error)


if __name__ == "__main__":
    unittest.main()
