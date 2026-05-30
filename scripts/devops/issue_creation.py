#!/usr/bin/env python3
"""
issue_creation.py — Stage 1 of the AnyWear DevOps Pipeline

Triggers an interactive human-agent discussion to refine a feature/bug
proposal, then creates a properly formatted issue file and a kanban task
chain that the dispatcher drives through solving → verification.

Usage:
    python scripts/devops/issue_creation.py create --title "Dark mode" --type feature

Flow:
    1. Spawns a hermes agent session to discuss the proposal with the human
    2. Agent asks clarifying questions, refines the issue
    3. If accepted → creates issue .md file in AnyWear-Meta/issues/
    4. Creates a 2-card kanban chain:
       - [SOLVE] assigned to opencode (implements)
       - [VERIFY] assigned to anywear-qa, parent=[SOLVE] (E2E tests)
    5. The dispatcher drives the rest — no polling, no cron, no conflicts
"""

import argparse
import subprocess
import sys
import os
import json
from datetime import datetime

# -- Project paths --
ANYWEAR_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
META_DIR = os.path.join(ANYWEAR_ROOT, "AnyWear-Meta")
ISSUES_DIR = os.path.join(META_DIR, "issues")

OPENSOLVE_PROFILE = "opencode"
QA_PROFILE = "anywear-qa"


def run_hermes(args, **kwargs):
    cmd = ["hermes"] + args
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def kanban_create(title, body="", assignee=None, parent=None):
    """Create a kanban card. Returns task_id or None."""
    cmd = ["kanban", "create", title, "--json"]
    if body:
        cmd += ["--body", body]
    if assignee:
        cmd += ["--assignee", assignee]
    if parent:
        cmd += ["--parent", parent]
    result = run_hermes(cmd, timeout=30)
    if result.returncode != 0:
        print(f"[ERROR] kanban create failed: {result.stderr}", file=sys.stderr)
        return None
    try:
        data = json.loads(result.stdout)
        return data.get("id") or data.get("task_id")
    except json.JSONDecodeError:
        for line in result.stdout.split("\n"):
            if line.startswith("t_"):
                return line.strip().split()[0]
        return None


def create_issue_file(issue_type, title, body, scope=""):
    """Create an issue markdown file in AnyWear-Meta/issues/<type>/."""
    safe_name = title.lower().replace(" ", "_").replace("/", "-")[:60]
    safe_name = "".join(c for c in safe_name if c.isalnum() or c in "_-")

    category = "features" if issue_type == "feature" else "bugs"
    category_dir = os.path.join(ISSUES_DIR, category)
    os.makedirs(category_dir, exist_ok=True)

    filepath = os.path.join(category_dir, f"{safe_name}.md")

    today = datetime.now().strftime("%Y-%m-%d")
    scope_line = f"scope: {scope}\n" if scope else ""

    content = f"""---
status: backlog
created: {today}
{scope_line}---

# {title}

{body}

## Acceptance Criteria

- [ ] TBD — refine during implementation
"""
    with open(filepath, "w") as f:
        f.write(content)

    print(f"[OK] Issue file created: {filepath}")
    return filepath


def build_solve_card_body(issue_path, title, scope):
    """Build the body for the [SOLVE] kanban card."""
    return f"""## Issue
{issue_path}

## Scope
{scope or 'TBD — check the issue file'}

## Instructions

1. **Read the issue**: open {issue_path} to understand what needs to be built or changed.

2. **Implement** using the OpenCode CLI:
   - For straightforward tasks: `opencode run '<detailed prompt>' --agent build`
   - For complex multi-step work: start `opencode` interactive, iterate
   - Work from `{ANYWEAR_ROOT}`. The subdirectories are:
     - `AnyWear-Client/` — Tauri + React frontend
     - `AnyWear-Service/` — Node.js + Hono backend
     - `AnyWear-Meta/` — docs and specs (no application code)

3. **Verify** your work:
   - Run existing tests: `pnpm test` in the affected repo
   - Run the linter: `pnpm lint`
   - Ensure the build succeeds: `pnpm build`

4. **Commit** with a descriptive message referencing the issue.

5. **Complete** this task:
   - Call `kanban_complete()` with a summary of what was changed.
   - Include the changed files and test results in the metadata.
"""


def build_verify_card_body(issue_path, title, parent_id):
    """Build the body for the [VERIFY] kanban card."""
    return f"""## Issue
{issue_path}

## Parent Task
{parent_id} — read the parent's completion summary for what was implemented.

## Instructions

1. **Read the implementation summary** from the parent task (available in the
   kanban comment thread via `kanban_show`).

2. **Start the test environment**:
   ```
   cd {ANYWEAR_ROOT}/AnyWear-Service && pnpm dev &
   cd {ANYWEAR_ROOT}/AnyWear-Client && pnpm dev &
   ```
   Wait for the Vite dev server at http://localhost:1420 to be ready.

3. **Run E2E tests** using @playwright/cli:
   - `npx @playwright/cli open http://localhost:1420/<relevant-route> --session qa-{title[:20]} --headed`
   - `npx @playwright/cli snapshot --session qa-{title[:20]} --headed`
   - Interact with the feature described in the issue, verify expected behavior
   - `npx @playwright/cli screenshot --output e2e/screenshots/ --session qa-{title[:20]} --headed`
   - `npx @playwright/cli console --session qa-{title[:20]}`
   - Check the testing docs at `{META_DIR}/architecture/devops/agentic_autonomous_e2e_testing.md`

4. **If ALL tests pass**:
   - Call `kanban_complete()` with a summary of what was tested and the results.
   - Attach screenshot paths and test counts to metadata.

5. **If ANY test fails**:
   - Call `kanban_create()` to create a bug card with:
     - Title: `[BUG] QA failures in: {title}`
     - Body: detailed bug report — what failed, how to reproduce, console errors
   - Then call `kanban_complete()` on this card with a note about the bugs found
     and a link to the bug card.

6. **Clean up**: stop the dev servers when testing is complete.
"""


def build_discussion_prompt(title, issue_type, body_hint):
    """Build the prompt for the human-agent discussion session."""
    return f"""You are the AnyWear DevOps issue creation agent.

A human has proposed a new {issue_type}:

  TITLE: {title}
  {"BODY: " + body_hint if body_hint else "(no additional details provided)"}

Your job: discuss this with the human to refine it. Follow these steps:

1. **Understand**: Read the proposal. If anything is unclear, use the clarify
   tool to ask the human.

2. **Refine**: Help the human think through:
   - What exactly needs to be built or changed?
   - Which repos are affected? (AnyWear-Client, AnyWear-Service, or both?)
   - Are there dependencies or architectural decisions needed?
   - What are the acceptance criteria?

3. **Decision**: Ask the human: "Should we accept this {issue_type} and create it?"

4. **If accepted**: Create the issue file and kanban chain by running:
   ```
   python {os.path.join(os.path.dirname(__file__), 'issue_creation.py')} create-chain \\
     --type {issue_type} --title "{title}" --body "BODY_TEXT_HERE" --scope "SCOPE_HERE"
   ```
   - BODY_TEXT_HERE: the refined body (one paragraph, clear and concise)
   - SCOPE_HERE: affected repo(s), e.g. "AnyWear-Client" or "AnyWear-Client,AnyWear-Service"

   Then tell the human the chain is set up and the dispatcher will handle it.

5. **If rejected**: Just say the issue is rejected and why. No files created.

Be concise. The human's time is valuable.
"""


def action_create_chain(args):
    """Create the issue file + 2-card kanban chain. Called by the agent."""
    issue_path = create_issue_file(args.type, args.title, args.body, args.scope)

    print("\n  Creating kanban chain...\n")

    # Card 1: SOLVE (assigned to opencode)
    solve_title = f"[SOLVE] {args.title}"
    solve_body = build_solve_card_body(issue_path, args.title, args.scope)
    solve_id = kanban_create(solve_title, body=solve_body, assignee=OPENSOLVE_PROFILE)

    if not solve_id:
        print("[ERROR] Failed to create SOLVE card", file=sys.stderr)
        return 1

    print(f"  [SOLVE]  {solve_id} → assigned to {OPENSOLVE_PROFILE}")

    # Card 2: VERIFY (assigned to anywear-qa, depends on SOLVE)
    verify_title = f"[VERIFY] {args.title}"
    verify_body = build_verify_card_body(issue_path, args.title, solve_id)
    verify_id = kanban_create(
        verify_title,
        body=verify_body,
        assignee=QA_PROFILE,
        parent=solve_id,
    )

    if not verify_id:
        print("[ERROR] Failed to create VERIFY card", file=sys.stderr)
        return 1

    print(f"  [VERIFY] {verify_id} → assigned to {QA_PROFILE} (waits for {solve_id})")

    print(f"""
  ┌─────────────────────────────────────────────────────┐
  │  Pipeline chain created                              │
  │                                                      │
  │  {solve_id} ──→ {verify_id}
  │                                                      │
  │  The dispatcher will:                                │
  │    1. Claim {solve_id}  → spawn opencode worker      │
  │    2. On completion     → promote {verify_id}        │
  │    3. Claim {verify_id} → spawn anywear-qa worker    │
  │                                                      │
  │  No cron jobs needed. No conflicts.                  │
  └─────────────────────────────────────────────────────┘
""")
    return 0


def action_create(args):
    """Start the interactive human-agent discussion."""
    prompt = build_discussion_prompt(args.title, args.type, args.body)

    print("\n" + "=" * 60)
    print(f"  STAGE 1: Issue Creation — {args.title}")
    print("=" * 60)
    print("\n  Spawning agent for discussion...\n")

    result = subprocess.run(
        ["hermes", "chat", "-q", prompt],
        cwd=ANYWEAR_ROOT,
    )
    return result.returncode


def main():
    parser = argparse.ArgumentParser(
        description="AnyWear DevOps — Stage 1: Issue Creation"
    )
    subp = parser.add_subparsers(dest="command")

    # create: start interactive discussion
    create_parser = subp.add_parser("create", help="Start interactive issue creation")
    create_parser.add_argument("--title", required=True, help="Issue title")
    create_parser.add_argument("--type", default="feature",
                               choices=["feature", "bug"], help="Issue type")
    create_parser.add_argument("--body", default="", help="Initial body/description")

    # create-chain: internal — called by the agent during discussion
    chain_parser = subp.add_parser("create-chain", help=argparse.SUPPRESS)
    chain_parser.add_argument("--type", required=True, choices=["feature", "bug"])
    chain_parser.add_argument("--title", required=True)
    chain_parser.add_argument("--body", required=True)
    chain_parser.add_argument("--scope", default="")

    args = parser.parse_args()

    if args.command == "create-chain":
        sys.exit(action_create_chain(args))
    elif args.command == "create":
        sys.exit(action_create(args))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
