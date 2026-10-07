#!/usr/bin/env python3
"""Compatibility CLI for GitHub Kanban intake and read-only Project status."""

import argparse
import collections
import json
import subprocess
import sys
from pathlib import Path

from issue_creation import PROJECT_URL, action_create, add_create_arguments

ANYWEAR_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ITEM_LIMIT = 1000
PROJECT_CONTENT_TYPES = {"Issue", "PullRequest", "DraftIssue"}


def cmd_create(args):
    return action_create(args)


def cmd_status(args):
    """Read GitHub's Project data and preserve failures instead of reporting zero."""
    command = [
        "gh", "project", "item-list", "4", "--owner", "git-malu",
        "--format", "json", "--limit", str(PROJECT_ITEM_LIMIT),
    ]
    try:
        result = subprocess.run(
            command, cwd=ANYWEAR_ROOT, capture_output=True,
            text=True, encoding="utf-8", timeout=60,
        )
    except FileNotFoundError:
        print("GitHub CLI (gh) is required for Project status.", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print("GitHub Project status request timed out after 60 seconds.", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"Cannot run GitHub CLI: {error}", file=sys.stderr)
        return 1
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        print(f"GitHub Project status failed (exit {result.returncode}): {detail}", file=sys.stderr)
        return result.returncode

    try:
        data = json.loads(result.stdout)
        items = data["items"]
        total = data["totalCount"]
        if not isinstance(items, list) or not isinstance(total, int) or total < 0:
            raise ValueError("expected an items list and non-negative totalCount")
        for item in items:
            if not isinstance(item, dict) or (
                "status" in item and not isinstance(item["status"], (str, type(None)))
            ):
                raise ValueError("expected Project item objects with text Status values")
            content = item.get("content")
            if not isinstance(content, dict) or content.get("type") not in PROJECT_CONTENT_TYPES:
                raise ValueError("expected content.type Issue, PullRequest, or DraftIssue")
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(f"Invalid GitHub Project response: {error}", file=sys.stderr)
        return 1
    if total != len(items):
        print(
            f"Incomplete GitHub Project response: received {len(items)} of {total} items. "
            "Use 'gh project item-list 4 --owner git-malu --format json --limit <total>' "
            "to inspect the full board before coordinating work.",
            file=sys.stderr,
        )
        return 1

    content_counts = collections.Counter(item["content"]["type"] for item in items)
    counts = collections.Counter(
        item.get("status") or "Unset" for item in items
        if item["content"]["type"] == "Issue"
    )
    print(f"AnyWear Kanban: {PROJECT_URL}")
    print(f"Project items: {total}")
    print(f"Kanban issues: {content_counts['Issue']}")
    for status, count in sorted(counts.items()):
        print(f"  {status}: {count}")
    print(f"PR evidence items: {content_counts['PullRequest']}")
    print(f"Draft items (not yet issues): {content_counts['DraftIssue']}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    create = commands.add_parser("create", help="Print a kanban_manager intake prompt")
    add_create_arguments(create)
    commands.add_parser("status", help="Read issue stages and evidence counts from GitHub Project #4")
    args = parser.parse_args(argv)
    if args.command == "create":
        return cmd_create(args)
    if args.command == "status":
        return cmd_status(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
