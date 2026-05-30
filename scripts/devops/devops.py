#!/usr/bin/env python3
"""
devops.py — AnyWear DevOps Pipeline CLI

Thin entry point for the dispatcher-driven 3-stage development pipeline.
There are no cron jobs, no polling scripts, no dual drivers — the kanban
dispatcher owns the state machine. This script just creates the chain and
shows status.

Usage:
    python scripts/devops/devops.py create --title "Dark mode" --type feature
    python scripts/devops/devops.py status
"""

import argparse
import subprocess
import sys
import os
import json

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
ANYWEAR_ROOT = os.path.abspath(os.path.join(SCRIPTS_DIR, "../.."))

OPENSOLVE_PROFILE = "opencode"
QA_PROFILE = "anywear-qa"


def run_hermes(args, timeout=30):
    cmd = ["hermes"] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def count_cards(status=None, assignee=None):
    """Count kanban cards matching criteria."""
    cmd = ["kanban", "list", "--json"]
    if status:
        cmd += ["--status", status]
    if assignee:
        cmd += ["--assignee", assignee]
    result = run_hermes(cmd, timeout=15)
    if result.returncode != 0:
        return 0
    try:
        return len(json.loads(result.stdout))
    except json.JSONDecodeError:
        return 0


def cmd_create(args):
    """Trigger issue creation (delegates to issue_creation.py)."""
    script = os.path.join(SCRIPTS_DIR, "issue_creation.py")
    cmd = [
        sys.executable, script, "create",
        "--title", args.title,
        "--type", args.type or "feature",
    ]
    if args.body:
        cmd += ["--body", args.body]
    subprocess.run(cmd, cwd=ANYWEAR_ROOT)


def cmd_status(args):
    """Show pipeline status."""
    print("\n" + "=" * 60)
    print("  AnyWear DevOps Pipeline Status")
    print("=" * 60)

    # Check profiles
    print("\n  Profiles:")
    for profile in [OPENSOLVE_PROFILE, QA_PROFILE]:
        result = run_hermes(["profile", "list"], timeout=10)
        found = profile in result.stdout
        mark = "✓" if found else "✗ (not found)"
        print(f"    {profile}: {mark}")

    # Check kanban board
    print("\n  Kanban Board (board: anywear-dev):")
    for status_name, label in [
        ("todo", "  Gated (waiting on parent)"),
        ("ready", "  Ready (dispatcher will claim)"),
        ("running", "▶ In Progress"),
        ("blocked", "⏸ Blocked (needs human)"),
        ("done",   "✓ Done"),
    ]:
        count = count_cards(status=status_name)
        print(f"    {label}: {count}")

    # Show pipeline cards specifically
    print("\n  Pipeline cards by assignee:")
    for profile, label in [(OPENSOLVE_PROFILE, "opencode (solving)"), (QA_PROFILE, "anywear-qa (verification)")]:
        total = count_cards(assignee=profile)
        ready = count_cards(status="ready", assignee=profile)
        running = count_cards(status="running", assignee=profile)
        done = count_cards(status="done", assignee=profile)
        print(f"    {label}: {total} total ({ready} ready, {running} running, {done} done)")

    # Check gateway
    print("\n  Gateway (dispatcher host):")
    gw = run_hermes(["gateway", "status"], timeout=10)
    if gw.returncode == 0:
        print(f"    {gw.stdout.strip().split(chr(10))[0] if gw.stdout else 'unknown'}")
    else:
        print("    NOT RUNNING — start with: hermes gateway start")

    print()


def main():
    parser = argparse.ArgumentParser(
        description="AnyWear DevOps Pipeline CLI"
    )
    subp = parser.add_subparsers(dest="command")

    create_parser = subp.add_parser("create", help="Create a new issue (Stage 1)")
    create_parser.add_argument("--title", required=True, help="Issue title")
    create_parser.add_argument("--type", default="feature",
                               choices=["feature", "bug"], help="Issue type")
    create_parser.add_argument("--body", help="Initial description")

    subp.add_parser("status", help="Show pipeline and kanban board status")

    args = parser.parse_args()

    if args.command == "create":
        cmd_create(args)
    elif args.command == "status":
        cmd_status(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
