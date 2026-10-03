---
name: kanban-workflow
description: Use when handling issues on the AnyWear Kanban board, following its delivery workflow, stage gates, closure, and subagent coordination.
---

# Kanban Workflow

Use this skill to process issues tracked on the AnyWear Kanban board, from Backlog through delivery and closure.

- Use issue frontmatter as the source of truth for issue metadata and status; keep issues, the Kanban view, and the roadmap synchronized.

## Issue

An issue is a standalone Markdown work item under `issues/` that records a feature request,
bug report, refactor or architecture decision, or maintenance chore. Its YAML frontmatter
defines the issue metadata and current workflow status; its body contains the problem or
goal, scope, design, acceptance criteria, dependencies, evidence, and closure notes.

### Issue Statuses

Every issue must have exactly one `status`:

- `backlog`: Work is drafted but not yet being analyzed or implemented.
- `analysis`: Scope, diagnosis, architecture, API contracts, dependencies, or risks are being evaluated.
- `development`: The approved solution is being implemented.
- `testing`: Development-only unit, integration, and queue-integration validation is in progress.
- `deployment`: The change is being released or qualified in Dev, Beta, or Production; Beta E2E belongs here.
- `pending_closure`: Implementation and delivery are complete, but reconciliation, acceptance records, documentation, or archive preparation remains.
- `completed`: All acceptance and closure work is verified; the issue may be archived in its category's `archived/` directory.
- `escalation`: Human intervention is required. Record `escalated-from` and resume from that stage after resolution.

Stage transitions are synchronous gates. Do not advance an issue while its current stage
gate or required dependency is incomplete.

### Issue Fields

Issue frontmatter supports these fields:

- `status` (required): One of the statuses listed above.
- `created` (optional): Creation date in `YYYY-MM-DD` format.
- `scope` (optional): Affected repository, subsystem, or area.
- `priority` (optional): Planning priority used to order issues within a Kanban column.
- `parent` (optional): Relative path to the parent issue when this is a sub-issue.
- `sub-issues` (optional): List of child issue objects with `path` and `relationship` fields.
- `required-before` (optional): Release or environment gate that cannot proceed until the issue is resolved.
- `escalated-from` (optional): The stage to resume after an escalation is resolved.

### Issue History / Log

Every issue must include a `History` or `Status Log` section in its body, or an equivalent
structured `history`/`log` field. It is an append-only record of the issue's workflow
journey and must show:

- the date of each status transition;
- the previous status and the new status;
- the reason, decision, or stage-gate result that caused the transition; and
- relevant evidence, links, or responsible owner when applicable.

Create an initial entry when the issue is opened, then append an entry for every transition,
including escalation, resumption, reopening, and completion. Do not rewrite or remove past
entries to hide the issue's history. The current `status` field must agree with the latest
status recorded in the history/log.

Issue types are determined by their category under `issues/`:

- `features/`: Product capabilities or user-facing feature work.
- `bugs/`: Defects, regressions, or correctness problems.
- `refactor/`: Refactors, architecture changes, technical decisions, or reliability work.
- `chores/`: Maintenance, operational, release, or lifecycle work that is not primarily a feature or bug.

Supporting documents such as `design.md` are represented by their parent issue and do not
become separate Kanban cards unless they are independently actionable.

## Workflow
- **Control Loop:** Every main-agent or subagent-owned work item follows `define → execute → observe → adjust → verify`, repeating until its acceptance criteria and stage gate pass.
- The main agent owns the high-level loop across the workflow; each subagent owns a low-level loop within its assigned scope. Feedback flows upward and back into planning, while stage transitions remain synchronous.
- **Backlog:** Define scope, acceptance criteria, dependencies, and ownership.
- **Analysis:** Develop the design and identify bug root causes as applicable; confirm architecture, API contracts, risks, and implementation boundaries.
- **Development:** Implement the approved design. After the Service produces and the Client consumes the aligned API contract, Client and Service work may run in parallel with separate subagents.
- **Testing:** Run development-only Unit Tests and Integration Tests; do not run E2E here. Independent Client and Service test suites may run in parallel when their inputs are ready.
- **Deployment:** Release to Dev/Beta/Production and run E2E qualification during release, starting in Beta and continuing through Production; parallelize independent environment checks, but keep promotion gates synchronous.
- **Pending Closure:** Update architecture docs, issue status and acceptance records, Kanban/roadmap views, links, and evidence; verify every dependent work item is complete. If any dependency is incomplete, keep the current item open and do not advance it to Completed. A subagent may own the reconciliation checklist.
- **Completed:** Mark complete and archive only after all closure work is verified.
- **Escalation:** Record the blocker and `escalated-from`, update the issue status to `escalation`, and ask for human intervention. Resume at the recorded stage after the intervention is complete.
- Treat stage transitions as synchronous gates; parallelize only independent work within a stage.
- Use subagents for stage ownership where useful; the main agent integrates results and verifies each stage gate before advancing.

## Kanban

Kanban is a derived view that displays issues as cards grouped into workflow-status columns.
It is not a replacement for issue frontmatter: update the issue first, then reconcile the
Kanban view and roadmap. A board may be split into category-specific Mermaid diagrams, but
each actionable issue should appear exactly once in the appropriate status column.

Use Mermaid's `kanban` diagram syntax for the board. Card titles should link to the issue
files with paths relative to the Kanban document. Column names should correspond to the
workflow statuses, with `Escalation (Human Intervention Required)` shown as an exception
column rather than a normal transition.

Within every column, sort cards by `priority` from highest to lowest so that the highest-
priority issue appears at the top and is handled first. Use a stable order for equal
priorities. If an issue has no explicit priority, place it after prioritized issues and
preserve its existing relative order; do not silently invent a priority value.
