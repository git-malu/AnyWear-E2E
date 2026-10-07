#!/usr/bin/env python3
"""Compatibility entry point for the Kanban skill's intake helper."""

import importlib.util
import sys
from pathlib import Path

SKILL_SCRIPT = (
    Path(__file__).resolve().parents[2]
    / ".agents/skills/kanban-workflow/scripts/issue_creation.py"
)
_spec = importlib.util.spec_from_file_location("anywear_kanban_issue_creation", SKILL_SCRIPT)
if _spec is None or _spec.loader is None:
    raise ImportError(f"Cannot load Kanban intake helper: {SKILL_SCRIPT}")
_implementation = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_implementation)

ISSUE_TYPES = _implementation.ISSUE_TYPES
PROJECT_URL = _implementation.PROJECT_URL
build_discussion_prompt = _implementation.build_discussion_prompt
add_create_arguments = _implementation.add_create_arguments
action_create = _implementation.action_create
action_create_chain = _implementation.action_create_chain
main = _implementation.main


if __name__ == "__main__":
    sys.exit(main())
