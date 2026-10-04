---
name: kanban-workflow
description: Use when coordinating or executing AnyWear Kanban issues across the board, an issue, or its submodule repositories.
---

# Kanban Workflow

Use this skill as the shared contract for AnyWear delivery work. It applies at three nested scopes: the Kanban board, one issue, and one repository or submodule slice. The active role determines which scope the agent owns.

- A board-level agent uses `kanban_manager`.
- An agent assigned one issue uses `issue_worker` and owns that issue through closure.
- An agent assigned one repository or submodule slice uses `submodule_worker` and reports to the issue worker.
- A delegation must state the role, issue, repository, worktree, assigned scope, expected evidence, and stopping condition. Do not infer a role from the word "worker".

## Guiding Principles

These principles guide every role and every stage. They describe how to make decisions; the stage gates and evidence requirements below make those decisions executable.

1. **Lifecycle** - Every scope has a beginning, execution period, feedback and repair period, verification, and closure. Closure includes reconciling records and deleting temporary local resources such as issue worktrees. Do not treat creation, a commit, or a merged PR as the end of a scope.
2. **Control loop** - Apply `define -> execute -> observe -> adjust -> verify` at each level of the Hierarchy: board, issue, and repository or submodule slice. Each scope owner uses test results, reviews, CI, deployment checks, dependency changes, blockers, and child reports as feedback. A failed check keeps the scope in its current stage or sends it to `escalation`; it does not become success by assertion.
3. **Scheduling** - Execute issues in dependency order, and verify prerequisite deliverables before starting dependent work. Run ready, independent issues concurrently. Use a dedicated worktree and repository branches for each issue to isolate files and Git state. Coordinate shared runtime resources and integration order; worktrees do not isolate ports, databases, or external services.
4. **Hierarchy** - Scope is divided into layers. The `kanban_manager` coordinates the board, an `issue_worker` owns one complete issue lifecycle, and `submodule_worker` agents execute repository-specific slices. A child reports evidence to its parent; the parent integrates and verifies it. A child must not silently take ownership of a parent's scope.

## Source of Truth and Issue Records

- Use issue frontmatter as the source of truth for current status and metadata.
- Each issue is a Markdown work item under `issues/`. Its body records the goal, scope, acceptance criteria, dependencies, technical constraints, evidence, and closure notes.
- The issue files and Kanban view live in the `AnyWear-Meta` repository. The issue worker owns the assigned issue's frontmatter and History updates; it may delegate architecture or documentation edits to a submodule worker, but it remains responsible for the status record.
- Every issue has a `History` section or equivalent structured field. Append an entry for creation and every status transition, including escalation, resumption, reopening, and completion. Each entry records the date, previous and new status, reason or gate result, owner, and relevant evidence.
- The current `status` must agree with the latest history entry. Do not rewrite history to hide a failed attempt.

Issue frontmatter supports:

- `status` (required): One of the statuses listed below.
- `created` (optional): Creation date in `YYYY-MM-DD` format.
- `scope` (optional): Affected repository, subsystem, or area.
- `priority` (optional): Planning priority used to order issues within a Kanban column.
- `parent` (optional): Relative path to the parent issue when this is a sub-issue.
- `sub-issues` (optional): Child issue objects with `path` and `relationship` fields.
- `required-before` (optional): Release or environment gate that cannot proceed until the issue is resolved.
- `escalated-from` (optional): The stage to resume after escalation is resolved.

Issue types are determined by their category under `issues/`: `features/` for product capabilities, `bugs/` for defects, `refactor/` for refactors or architecture decisions, and `chores/` for maintenance or operational work. Supporting documents belong to their parent issue unless independently actionable.

## Roles and Ownership

| Role | Owns | Must deliver | Must not do without explicit reassignment |
| --- | --- | --- | --- |
| `kanban_manager` | The Kanban board and its issue scheduling | Dependency order, parallelism decisions, issue-worker assignments, cross-issue coordination, and board reconciliation | Implement an issue in place, compete with an issue worker for its status, or delete an issue worker's worktree |
| `issue_worker` | One issue from its current stage through `completed` or `escalation` | Issue status and history, worktree lifecycle, submodule-worker delegation, integration, PR and gate evidence, deployment, closure, and final report | Change unrelated issue statuses or accept unverified child work |
| `submodule_worker` | One repository or submodule slice of one issue | Repository changes, tests, commits, PR updates, and evidence or blockers | Change issue status, close or archive the issue, change unrelated repositories, or remove an issue worker's shared worktree |

The issue worker is the lifecycle owner for its issue. The Kanban manager supervises and coordinates many issue workers; it does not replace their issue-level ownership. The issue worker may delegate implementation, testing, investigation, or deployment slices to submodule workers, but remains responsible for integrating and verifying their results.

## Issue Statuses and Gates

Every issue has exactly one status:

- `backlog`: Work is drafted but not yet analyzed or implemented.
- `analysis`: Scope, diagnosis, architecture, API contracts, prerequisites, dependencies, and risks are being evaluated.
- `development`: The approved solution is being implemented.
- `testing`: Development-only unit, integration, and queue-integration validation is in progress.
- `deployment`: The change is released or qualified in Dev, Beta, or Production; Beta E2E belongs here.
- `pending_closure`: Implementation and delivery are complete, but reconciliation, acceptance records, documentation, or cleanup remains.
- `completed`: All acceptance and closure work is verified; the issue may be archived in its category's `archived/` directory.
- `escalation`: Human intervention is required. Record `escalated-from` and resume at that stage after resolution.

The normal path is `backlog -> analysis -> development -> testing -> deployment -> pending_closure -> completed`. Stage transitions are synchronous gates: do not advance while the current stage's gate, an applicable dependency condition, or a release/environment gate is incomplete. Apply the dependency conditions defined under Dependency Scheduling and Coordination before starting dependent work.

If a PR closes without merging, the issue worker retains its worktree and records the decision. Continue in `development` or `testing` when work will continue, or enter `escalation` when a human decision is required. An unmerged PR cannot lead to `pending_closure` or `completed`.

## Control Loop at Every Scope

Each scope owner applies this loop at its level of the Hierarchy: `kanban_manager` for the board, `issue_worker` for an issue, and `submodule_worker` for a repository or submodule slice. Child reports feed the parent's control loop.

1. **Define** the goal, scope boundary, dependencies, acceptance criteria, and evidence needed to exit the current stage.
2. **Execute** only work inside that scope and its assigned worktree or repository.
3. **Observe** code review, tests, CI, deployment results, runtime behavior, dependency changes, and child reports.
4. **Adjust** the plan, assignments, ordering, or implementation in response to observed feedback. Record blockers and decisions.
5. **Verify** the exit gate and evidence. Repeat the loop if the gate fails; escalate when the remaining action requires human intervention.

## Workflow

The `issue_worker` drives the issue through the following gates while the `kanban_manager` coordinates dependencies between issues:

- **Backlog:** Define scope, acceptance criteria, ownership, upstream blockers, downstream dependents, technical dependencies, and the required worktree shape.
- **Analysis:** Confirm design, root cause, architecture, API contracts, risks, repository boundaries, and implementation order.
- **Development:** Implement the approved design through submodule workers. For API work, the Service produces the contract first and the Client consumes the resulting API revision. Submit every code change through a GitHub pull request linked to the issue; do not push directly to protected target branches.
- **Testing:** Use PR required checks as the test gate. Run unit and integration tests through PR checks; do not run cross-repository E2E here. Independent repository test suites may run in parallel when their inputs are ready.
- **Deployment:** Deploy through the GitHub Actions pipeline. The pipeline must include post-deployment E2E; promotion succeeds only when that step passes. Start qualification in Beta and continue through Production as required by the release plan.
- **Pending Closure:** Complete every closure item below before changing the issue to `completed`.
- **Completed:** The issue worker marks the issue complete and archives it only after all closure checks pass. The Kanban manager then reconciles the board.
- **Escalation:** Record the blocker and `escalated-from`, set `escalation`, and request human intervention. Resume at the recorded stage after resolution.

The PR author or an explicitly authorized issue worker may merge a PR after required branch-protection checks and approvals pass. Never bypass branch protection or required checks. A failed review or check feeds back into the control loop.

## Workspaces and Resource Ownership

- The issue worker allocates one dedicated issue worktree before the first edit. By default it is a root-repository worktree with initialized submodules, because it is the issue's coordination and integration workspace.
- The Kanban manager keeps board edits in its own clean Meta or root workspace. It must not edit the board inside an issue worker's worktree or share a writable Meta checkout with another issue worker.
- For a cross-repository issue, all involved submodules used for shared testing stay in that same root worktree. Each changed submodule remains an independent repository with its own issue branch, commits, pushes, and PR. The issue worker owns the root worktree; submodule workers receive repository-specific paths and may not create a second root worktree for the same issue.
- If an issue intentionally changes only one submodule and needs no root-level integration, the issue worker may allocate a worktree directly in that submodule repository. In this mode it uses a separate issue-owned Meta or base checkout for the issue record; it must not write issue metadata in the submodule worker's checkout or the manager's board workspace. The issue worker still owns the issue record and lifecycle. Never create a worktree inside another worktree or inside a submodule directory of a root worktree.
- At most one agent edits a given repository directory at a time. The issue worker owns issue frontmatter and History in `AnyWear-Meta`; any delegated Meta documentation work must be serialized with those edits. A submodule worker must not run root-level checkout, reset, recursive submodule switching, or commands that change another worker's repository state. The issue worker coordinates integration pins and shared nested submodules.
- Progress on one issue must not overwrite another issue's files, branches, uncommitted changes, credentials, or runtime resources.
- A worktree isolates its branch, files, and uncommitted changes, but not ports, databases, credentials, or external services. The issue worker assigns safe resource names or coordinates serialized access before parallel execution.
- Fetch the target branch before allocating a worktree. During development, fetch again only at planned synchronization points, such as before rebasing or integration; fetching alone does not incorporate commits into the worktree.

## Pending Closure

The issue worker must verify all of the following and record the evidence:

- All issue tasks and acceptance criteria are complete; required unit, integration, and E2E tests passed; and release/deployment gates passed.
- Every required environment has the intended deployed revision recorded.
- Every prerequisite and technical dependency has met its recorded condition, and all blockers are resolved or explicitly accepted as non-blocking with a recorded reason and evidence.
- Downstream issues have a verified handoff. Do not change another issue's status unless explicitly assigned that issue and its gate is verified.
- Relevant architecture documentation and decision or reconciliation evidence are updated.
- PR URLs, approvals, automated results, issue history, links, evidence, and acceptance status are recorded.
- Every touched repository has been reconciled. After related PRs merge and all gates pass, check the root repository and each changed submodule for uncommitted changes and unpushed commits. If a submodule pointer is an intentional integration pin, preserve it through its own integration commit and PR. If it was only a temporary test pin, restore the clean baseline before checking status. Never treat a temporary pointer change as delivered work.
- After repositories are clean and all delivered changes are preserved, remove the issue-specific worktree from the repository that owns it and prune stale worktree metadata there. Only then fetch each relevant target branch and fast-forward a clean base checkout without overwriting unrelated local work; record branches and revisions.
- If any PR is unmerged, any work is uncommitted or unpushed, or any required cleanup is unresolved, keep the issue out of `completed`.
- The issue worker reconciles the issue record and evidence. The Kanban manager verifies and updates the Kanban view.

## Dependency Scheduling and Coordination

- Record dependencies as `A blocks B` / `B depends on A`, including the affected work in B, the condition that releases it, and the evidence required to verify that condition. Unless a narrower condition is recorded, B's execution waits for A to reach `completed`.
- The Kanban manager starts dependent work only after verifying its prerequisite condition. For a deliverable handoff, record the upstream commit, API revision, or document version and ensure the downstream workspace incorporates it. Another agent's uncommitted files are not a verified handoff.
- Run ready, independent issues concurrently when workspace ownership and resource access are isolated or coordinated. Use priority to order ready issues; it never overrides an unresolved dependency.
- Editing the same file in separate worktrees does not by itself forbid parallel execution. Coordinate ownership and integration order for logically overlapping changes or shared API contracts. Serialize conflicting work or resource access when interference cannot otherwise be prevented.
- Independent planning and worktree preparation may proceed while a dependency is pending, but work that requires the blocked inputs must wait. Keep a waiting issue in its current stage and record its blocker and resumption condition; use `escalation` only when human intervention is required. Continue other ready issues.
- Technical dependencies are distinct from issue dependencies. Shared API work follows Service produces -> API revision is available -> Client consumes.
- The Kanban manager assigns one issue worker and requires one isolated issue worktree per issue. The issue worker creates and owns that worktree. The manager supplies dependency and resource context needed to avoid cross-issue interference.
- The issue worker assigns submodule workers only after defining repository boundaries and the required evidence. A child's commit or PR is input to the issue worker's control loop, not automatic issue completion.
- The Kanban manager resolves conflicts between issue workers, shared resources, and release order. It must not use a child's uncommitted files as delivered evidence.

## Kanban Reconciliation

The Kanban board is a derived view; issue frontmatter remains authoritative. Update the issue record first, then reconcile the board.

- Use Mermaid `kanban` diagrams with one linked card for every actionable issue file. Supporting documents do not become separate cards unless independently actionable.
- Maintain Feature, Refactor, Bug, and Chore boards with the workflow columns: Backlog, Analysis, Development, Testing, Deployment, Pending Closure, and Completed. Keep `Escalation (Human Intervention Required)` as a separate exception column.
- Sort cards by `priority` from highest to lowest, with stable order for ties. Issues without priority follow prioritized issues in their existing relative order.
- Update `Last reconciled` whenever the board is reconciled. The Kanban manager verifies that every actionable issue appears once and each card's column agrees with its issue's current status.

## Role Prompt Examples

Kanban manager:

```text
Use the kanban_manager role.
Coordinate the AnyWear Kanban board, dependency conditions and verified handoffs, concurrent execution of ready independent issues, issue-worker assignments, shared resources, and board reconciliation.
Do not take ownership of an issue implementation unless explicitly reassigned as its issue_worker.
```

Issue worker:

```text
Use the issue_worker role.
Issue: <issue path>
Own this issue from its current status through completed or escalation. Create and clean up its issue worktree, delegate repository slices to submodule workers, integrate and verify their results, and return status, PR, test, deployment, and closure evidence to the kanban_manager.
```

Submodule worker:

```text
Use the submodule_worker role.
Issue: <issue path>
Repository: <repository>
Worktree: <worktree path>
Assigned scope: <scope>
Execute only this repository slice, return commits, PR URL, tests, deployment evidence, and blockers, and stop when the assigned deliverable is ready for issue-worker verification. Do not change issue status or remove shared worktrees.
```
