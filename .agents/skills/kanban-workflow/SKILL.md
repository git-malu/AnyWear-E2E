---
name: kanban-workflow
description: Create, coordinate, or execute AnyWear GitHub Kanban issues across the board, an issue, or its repository slices.
---

# Kanban Workflow

Use this contract for [AnyWear issues](https://github.com/git-malu/AnyWear/issues) and [Project #4](https://github.com/users/git-malu/projects/4). It coordinates actionable delivery work; roadmap planning is outside its scope. Read [GitHub operations](references/github-operations.md) when creating issues, updating remote records, configuring the Project, or recording handoff/recovery/closure evidence.

## Principles and Ownership

1. **Lifecycle:** Finish acceptance, delivery, records, and temporary-resource cleanup before completion. Creating an issue, committing, or merging a PR is an intermediate result.
2. **Control loop:** Apply `define -> execute -> observe -> adjust -> verify` at board, issue, and repository/submodule scope. Child reports feed the parent's loop; the parent integrates and verifies them before advancing.
3. **Scheduling:** Verify prerequisite deliverables before dependent work. Run ready independent issues concurrently with dedicated worktrees and branches. Coordinate shared APIs, integration order, ports, databases, credentials, and environments; worktrees isolate only files and Git state.
4. **Hierarchy:** Each owner stays within its assigned scope. A delegation states role, issue URL, repository, absolute worktree path, scope, expected evidence, and stopping condition.

| Role | Owns | Delivers |
| --- | --- | --- |
| `kanban_manager` | Intake, the board, scheduling, worker assignments, cross-issue conflicts | Bounded issues, priority/dependency decisions, verified handoffs, resource coordination, board reconciliation |
| `issue_worker` | One issue's current stage through closure or escalation | GitHub stage/comments, worktree lifecycle, repository delegation, integrated acceptance and delivery evidence, recovery, final report |
| `submodule_worker` | One assigned repository slice | Changes, commits/PRs, relevant checks and deployment evidence, blockers, verified handoff inputs |

Assign one active issue worker per issue and one owner per writable repository directory. Concurrent child edits in a shared repository require explicitly disjoint scope and coordinated integration; serialize Git state mutations. The manager does not implement an issue, compete for its stage, or remove its worktree without explicit reassignment. A submodule worker does not change issue stage/state, close an issue, alter unrelated repositories, or remove shared worktrees. Scope owners remain responsible for their delegated results.

## Authoritative Records

- The canonical work item is a GitHub Issue in `git-malu/AnyWear`, identified by URL or `git-malu/AnyWear#number`.
- The issue body owns current goal, scope, affected repositories, constraints, acceptance criteria, and gate applicability. Large design and evidence documents stay in Meta and are linked by stable URLs.
- Project #4 `Status` owns the current lifecycle stage; `Priority` owns relative priority. Use native assignees, labels, timestamps, milestones, parent/sub-issues, and blocked-by/blocking relations. The Repository field identifies the issue's home, not all affected repositories.
- Use established labels for Feature, Bug, Refactor, and Chore classification. Size, estimates, and dates are optional. Do not create redundant custom state fields.
- Comments record meaningful decisions, transition reasons, failures, blockers, handoffs, recovery, and closure evidence. Native timeline events supply automatic history. Correct evidence with a new comment; avoid routine unchanged progress or duplicating automatic events.
- PRs, Actions runs, and deployment records are linked evidence. A repository delegation does not itself require a sub-issue.
- Retired Markdown issues and Kanban diagrams remain in Git history. Meta's `records/kanban-migration/migration-map.json` preserves their canonical GitHub identities and source provenance; `records/` holds supplementary designs/evidence, not another issue tracker. Do not recreate `AnyWear-Meta/issues`. GitHub access failures do not authorize a parallel local tracker.

## Issue Intake

The manager handles creation and triage against the existing board and issues:

1. Check duplicates and overlapping outcomes. Reuse an existing issue when it owns the requested result; explain any distinct boundary. Coordinate scope changes with an active owner.
2. Compare impact, urgency, and value of unblocking work against existing issues. Assign an existing `Priority` option (`P0` highest, then `P1`, `P2`, and any configured lower priority) and record a short rationale. Priority never bypasses a dependency.
3. Identify upstream and downstream blockers. Use native dependency relations and record each release condition and expected evidence. A future commit/API/document revision can remain pending at intake; pin an available exact revision when verifying the handoff.
4. Check for one bounded, verifiable outcome. Split independently deliverable outcomes or work with different execution times/priorities. Keep repository slices under one issue when they share one acceptance boundary. Time span is a review signal; uncertain work can begin as a bounded investigation issue.
5. Distinguish dependency, parent/child grouping, and shared-resource conflict. Record resource or integration coordination even when no blocking relationship is needed.
6. Record goal, scope, acceptance, labels, affected repositories, priority rationale, dependency conditions, split/grouping decision, and resource constraints. Add new issues to Project #4 with `Status=Backlog`; read back membership, fields, and relationships. Return issue URLs and coordination decisions. Creation does not start execution unless requested, and remote-only intake needs no worktree.

For a CLI-generated manager request, use [scripts/issue_creation.py](scripts/issue_creation.py) with `create --title <title> --type <type>`, optionally `--body`, `--body-file`, and `--scope`. It assembles proposal data and references this intake contract; it does not create an issue or start execution.

## Stages and Gates

The normal path is `Backlog -> Analysis -> Development -> Testing -> Deployment -> Pending Closure -> Completed`; `Escalation` suspends execution for required human intervention. Use these exact Project option names. Keep issues open through Pending Closure and Escalation.

| Stage | Gate before advancing |
| --- | --- |
| Backlog | Bounded scope and acceptance; owner, readiness, dependencies, resource needs, and worktree shape established |
| Analysis | Design/diagnosis, API contracts, repository order, risks, and applicable testing/deployment/release gates recorded |
| Development | Implemented changes delivered through linked repository PRs; shared API order is Service generates -> API revision available -> Client consumes |
| Testing | Applicable unit/integration and required PR checks pass on intended revisions; review feedback resolved |
| Deployment | Applicable pipeline, environment qualification, post-deployment/system E2E, and promotion checks pass on recorded revisions |
| Pending Closure | Acceptance, evidence, repository/resource reconciliation, downstream handoffs, and worktree cleanup verified |
| Completed | Final comment persisted, Project stage and closed-as-completed issue state read back successfully |
| Escalation | Blocker resolved, ownership/resources and resumption gates revalidated before returning to recorded stage |

Determine applicability in Analysis. Documentation/process-only work can record Deployment and runtime E2E as Not Applicable, with relevant document, link, schema, migration, and workflow validation. Still record the applicable gate results when advancing; skipped runtime delivery is not an invented deployment. E2E ownership remains with AnyWear-E2E and its pinned compatibility inputs, not root CI.

For runtime releases, qualify Beta through the repository pipeline with applicable post-deployment E2E; promote to Production when required by release scope. Record the intended revision and result for each required environment.

Run required checks and obey branch protection; failures repeat the current scope's control loop. Merge only when session authorization and repository rules permit. A closed unmerged PR requires repair/replacement, documented abandonment, or escalation; it is not delivered evidence. All required delivery PRs must merge before successful closure. Use neutral issue references rather than closing keywords or closing-type PR associations. Check Project automations so PR merge or an early issue close cannot mark this lifecycle Completed.

## Scheduling and Handoffs

- Record `A blocks B`, the affected work in B, release condition, and evidence. By default B waits for A to reach Completed; narrower release conditions require an explicit verified handoff.
- Verify the exact upstream commit, API revision, or document version is available and incorporated in the downstream workspace. Uncommitted files are not a handoff. Reconcile the native blocking relation when the documented release condition is met; it must represent active blockers.
- A producer whose handed-off input becomes invalid must record why, notify the manager and affected owners, and request suspension of affected consumer work. The manager reconciles the active blocking relation; affected issue owners suspend their own execution/delegations and acknowledge the result. Account for in-flight deployment state and any already-applied invalid revision before reporting consumers stopped; record required remediation. Resume only after verifying the replacement and rechecking dependent results. A newer revision or unrelated reopening alone does not invalidate a still-valid pinned handoff.
- Independent analysis/preparation may continue while blocked; execution requiring the input waits in its current stage with a recorded resumption condition. Escalation is for human intervention, not routine waiting. Detect cycles and resolve them before scheduling the affected work.
- Order ready issues by priority and capacity. Separate worktrees can change the same file concurrently when logical ownership and integration order are coordinated. Serialize shared contracts or resource access when interference cannot otherwise be prevented.
- Without an active manager, an issue worker reads the board, native dependencies, handoff comments, current owner, worktree records, and resource constraints before starting. It may execute its ready assigned issue, but must not silently reassign work, resolve cross-issue conflicts, or launch other issues; request manager/human coordination when needed.

## Worktrees and Resources

- Before the first local edit, the issue worker allocates or reuses one issue-owned worktree and records owner, absolute path, branches, and resource assignments in a comment. Fetch the target branch before creation; later synchronize at planned integration points.
- Default cross-repository location: `<primary-root-checkout>/.worktrees/issue-<number>-<slug>`. Initialize required submodules there; each changed repository has its own issue branch, commits, pushes, and PR. Submodule workers use the repositories already inside this worktree.
- A standalone repository issue with no root integration may use `<primary-repository-checkout>/.worktrees/issue-<number>-<slug>`. GitHub stores its issue record; no separate Meta status checkout is required.
- The `.worktrees/` container under the primary checkout is intentional. Never create another issue worktree under an existing issue/platform worktree or a submodule inside an issue coordination worktree. Resolve the owning primary checkout instead. Use distinct paths, verify the directory is ignored with `git check-ignore`, and use `.git/info/exclude` if needed rather than unrelated tracked configuration.
- Platform-managed worktrees follow their platform lifecycle; do not move or manually remove them. The issue worker owns agent-created Git worktrees; the manager does not clean them up.
- Give each worker an absolute repository path and stopping condition. Avoid root checkout/reset/recursive submodule switching while children are working; the issue worker coordinates integration and shared nested submodule pins.
- Keep unrelated changes intact. Assign separate runtime resource names or coordinated access before concurrent execution. Preserve worktrees on interruption or escalation and revalidate them on resumption.

## Recovery, Reopening, and Cancellation

Comments, fields, relationships, and issue state are separate remote mutations. Before updates, read the current records; after meaningful mutations, read back the expected result. If a mutation times out, inspect remote state before retrying. Reuse the existing issue, worker, worktree, and identifiable evidence comment instead of duplicating them. A partial transition is unfinished: repair the remote mismatch before advancing. Read the operations reference for the comment/field/state recovery sequence.

Escalation records the blocker, human action, resumption stage, existing worktree/branches/PRs, current delegated work, resources, and outstanding gates. Stop delegated mutations and await acknowledgment before releasing resources or transferring ownership. Resume in the recorded stage after revalidation; if GitHub is unavailable, retain local work and report the access blocker without declaring a remote transition successful.

For reopening, comment with the failed acceptance or new evidence, reopen the issue, unarchive its retained Project item (or add it if absent), and restore the earliest affected stage. Read back open state, stage, and `isArchived=false`, then revalidate affected handoffs. Reuse a retained workspace or allocate one after prior cleanup. The manager reconciles downstream dependencies; reopening is not blanket invalidation.

For cancellation or supersession, record the reason and replacement issue, stop child work, preserve or explicitly dispose of outstanding changes, and reconcile dependencies/resources/worktrees. Close as **not planned**; for duplication use GitHub's native duplicate link/reason when available. Clear the successful lifecycle stage and archive the Project item from the operational view. These are not Completed delivery; verify the native close reason, cleared stage, remaining links, and `isArchived=true`. Never discard dirty or unpushed work merely to clean up.

## Closure and Board Reconciliation

The issue worker verifies applicable acceptance/tests/release gates, intended deployed revisions, dependencies, child results, documentation, and downstream handoffs. Record merged delivery PRs, exact revisions, checks, applicable Not Applicable gates, and acceptance evidence in GitHub before removing local resources.

Reconcile every touched repository: delivered changes are committed/pushed/merged, abandoned work is explicitly handled, and working trees are clean. Preserve intentional submodule pins in their own integration commit/PR; restore temporary test pins to the baseline. Update only assigned clean base checkouts, with fetch and fast-forward, without overwriting other owners' work.

Release issue-owned runtime resources. Before removal, inventory untracked and ignored files in the root and every initialized/nested repository; `git status` alone does not cover ignored artifacts. Preserve any needed artifacts outside the removable tree and verify their preservation before proceeding. From the owning repository's base checkout, use `git worktree remove <absolute-path>` and prune stale metadata; never delete the directory directly. Initialized submodules can make Git require `--force` even when clean: inspect every repository for dirty state and unpushed commits, verify artifact/remote preservation and ownership, and use only the minimum force required. Do not force past locks or data loss. Record the inventory decisions, preservation locations, and actual cleanup result from the surviving base checkout.

Only after acceptance and cleanup pass, append final evidence, set Project Status to Completed, close the issue as completed, and read back both. If this sequence partially fails, repair the mismatch and retain Pending Closure where possible; do not report completion until the remote pair agrees. Evidence must survive worktree removal.

The manager reconciles Project membership, duplicate actionable work, stage/open-state consistency, owners, priority, active blockers, handoff revisions, evidence/PR links, and automation behavior. The primary operational view contains Issues; PR cards belong in a separate delivery/review view or as evidence. A clean board does not replace issue-level acceptance.

## Role Prompts

For intake and practical delegation prompts, read [GitHub operations](references/github-operations.md#role-prompts). Always identify the issue by its GitHub URL and repository work by an absolute path.
