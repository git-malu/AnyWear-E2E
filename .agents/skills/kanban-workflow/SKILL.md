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
goal, scope, design, acceptance criteria, prerequisite issue links, technical dependencies,
evidence, and closure notes.

### Issue Statuses

Every issue must have exactly one `status`:

- `backlog`: Work is drafted but not yet being analyzed or implemented.
- `analysis`: Scope, diagnosis, architecture, API contracts, prerequisite issues, technical dependencies, or risks are being evaluated.
- `development`: The approved solution is being implemented.
- `testing`: Development-only unit, integration, and queue-integration validation is in progress.
- `deployment`: The change is being released or qualified in Dev, Beta, or Production; Beta E2E belongs here.
- `pending_closure`: Implementation and delivery are complete, but reconciliation, acceptance records, documentation, or archive preparation remains.
- `completed`: All acceptance and closure work is verified; the issue may be archived in its category's `archived/` directory.
- `escalation`: Human intervention is required. Record `escalated-from` and resume from that stage after resolution.

Stage transitions are synchronous gates. Do not advance an issue while its current stage
gate, prerequisite issue, technical dependency, or required release/environment gate is incomplete.

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

### Issue History

Every issue must include a `History` section in its body, or an equivalent structured
`history` field. It is an append-only record of the issue's workflow journey and must show:

- the date of each status transition;
- the previous status and the new status;
- the reason, decision, or stage-gate result that caused the transition; and
- relevant evidence, links, or responsible owner when applicable.

Create an initial entry when the issue is opened, then append an entry for every transition,
including escalation, resumption, reopening, and completion. Do not rewrite or remove past
entries to hide the issue's history. The current `status` field must agree with the latest
status recorded in `History`.

Issue types are determined by their category under `issues/`:

- `features/`: Product capabilities or user-facing feature work.
- `bugs/`: Defects, regressions, or correctness problems.
- `refactor/`: Refactors, architecture changes, technical decisions, or reliability work.
- `chores/`: Maintenance, operational, release, or lifecycle work that is not primarily a feature or bug.

Supporting documents such as `design.md` are represented by their parent issue and do not
become separate Kanban cards unless they are independently actionable.

## Workflow
- **Control Loop:** Every main-agent or subagent-owned work item follows `define → execute → observe → adjust → verify` until its acceptance criteria and stage gate pass. The main agent owns the high-level loop; subagents own their assigned scopes.
- **Backlog:**
  - Define scope, acceptance criteria, ownership, upstream blockers, downstream dependents, and technical dependencies. Record each issue relationship explicitly as `A blocks B` / `B depends on A`.
- **Analysis:**
  - Confirm the design, root cause, architecture, API contracts, risks, and implementation boundaries.
- **Development:**
  - Implement the approved design. After the Service produces and the Client consumes an aligned API contract, independent Client and Service work may run in parallel with separate subagents.
  - Submit every code change through a GitHub pull request linked to the issue. The pull request is the code submission and review record; do not push directly to protected target branches or merge outside the pull request.
  - The PR author or an authorized agent may merge the pull request autonomously once all required branch-protection checks and any configured approvals pass. Never bypass branch protection or required PR checks; if a review or check fails, keep the issue in its current stage, resolve the failure, and rerun it.
- **Testing:**
  - Use the GitHub pull request's required checks as the test gate. Run unit and integration tests through PR checks; do not run end-to-end tests in this stage. Independent Client and Service test suites may run in parallel when their inputs are ready.
- **Deployment:**
  - Deploy to Dev, Beta, or Production through a GitHub Actions pipeline; do not treat ad hoc manual deployment as the delivery record.
  - The pipeline must include a post-deployment end-to-end test step, and the deployment or promotion is successful only when that step passes. Start qualification in Beta and continue through Production as required by the release plan.
  - Keep promotion gates synchronous; parallelize only independent environment checks.
- **Pending Closure:** Complete every item below before moving the issue to `completed`:
  - Verify that all issue tasks and acceptance criteria are complete.
  - Verify that required unit and integration tests passed, required E2E tests completed, and the relevant release/deployment gate passed.
  - Verify that the change is deployed to every environment required by the issue and that the deployed revision is recorded.
  - Verify that every prerequisite/blocking issue and technical dependency is complete or explicitly accepted as non-blocking.
  - For each downstream issue that depends on the current issue, check its status and handoff. Mark it complete when required by the acceptance or release plan; otherwise confirm that it is linked and unblocked.
  - Update the relevant architecture documentation and record the decision or reconciliation evidence.
  - Record the GitHub PR URL, review approvals, automated check results, issue history, links, evidence, and acceptance status.
  - Reconcile the issue, Kanban, and roadmap views. A subagent may own the checklist, but the main agent verifies it.
- Keep the issue open if any required closure item, prerequisite/blocking issue, technical dependency, release gate, or downstream handoff is incomplete.
- **Completed:** Mark the issue complete and archive it only after all closure checks are verified.
- **Escalation:** Record the blocker and `escalated-from`, set the status to `escalation`, and request human intervention. Resume at the recorded stage after resolution.
- Treat stage transitions as synchronous gates; parallelize only independent work within a stage. The main agent integrates results and verifies each gate before advancing.

## Multi-tasking

- Terminology: If issue A must finish before issue B can proceed, A is B's `prerequisite/blocking issue`, and B is the `dependent issue`; write this as `A blocks B` or `B depends on A`. A `technical dependency` is an API contract, shared schema, service, or external resource, not an issue itself; record release and environment gates separately.
- Identify each dependency pair as `A blocks B` / `B depends on A`; complete A and pass its stage gate before starting B. Record the direction in the issue body or frontmatter.
- Run issues in parallel only when they are independent, have no unresolved prerequisite issues, and do not modify the same files, API contracts, or shared resources. Shared API work must follow the technical dependency order: the Service produces the contract, then the Client consumes it.
- Give each parallel issue a separate subagent and separate `git worktree` to isolate its branch, working tree, and uncommitted changes; `git worktree` does not isolate ports, databases, credentials, or external services.
- The main agent owns ordering, integration, and conflict resolution. Recheck prerequisite issues, technical dependencies, API contracts, and stage gates before and after integration; never rely on uncommitted file state from another `git worktree`.

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
