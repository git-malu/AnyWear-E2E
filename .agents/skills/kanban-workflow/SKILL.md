---
name: kanban-workflow
description: Create, coordinate, or execute AnyWear GitHub Kanban issues across the board, an issue, or its repository slices.
---

# Kanban Workflow

This is the operating contract for `git-malu/AnyWear` Issues and Project #4. The Issue body owns scope, acceptance, affected repositories, and gate applicability; Project Status/Priority owns stage and relative priority. Use native relationships/labels and comments with linked PRs, Actions, and deployment evidence. Meta holds architecture and ADRs; working designs and evidence belong in Issue bodies/comments and linked artifacts. Read the relevant [GitHub operations](references/github-operations.md) section for CLI mutations, recovery, cleanup, release evidence, or delegation.

Issue history is primarily for people. Write new comments and handoff reports in English using the [comment templates](references/comment-templates.md): lead with a descriptive title and conclusion, then state, changes, evidence links, and next steps. Keep titles, prose, table labels, and descriptive link labels consistently in English; preserve exact evidence in linked records or a collapsed traceability section, and distinguish intended actions from observed results. Post meaningful changes rather than repeated unchanged-status logs.

## Ownership

| Role | Owns | Must return |
| --- | --- | --- |
| `kanban_manager` | Intake, board scheduling, priority/dependencies, shared resources and Beta lifecycle controls, cross-issue conflicts | Bounded issue decisions, assignments, verified handoffs, board reconciliation |
| `issue_worker` | One issue from its current stage through closure or escalation | Integrated changes, stage/evidence records, acceptance, delivery, cleanup, final state |
| `submodule_worker` | One repository slice | Exact revisions, PRs, checks, handoff evidence, or a blocker |

Use one active scheduling manager and one issue worker per issue. The assigning manager or human records an identifiable owner/session claim and numbered transfers. Each physical repository has one Git writer at a time; each shared environment has one deployment writer. Workers stay within their assigned issue, repository, absolute path, and scope. The manager does not implement issues or remove worktrees. A submodule worker does not change lifecycle state, close issues, alter unrelated repositories, or remove shared worktrees.

For requested execution or continuation, the manager keeps coordinating until the requested work is verified complete, the user explicitly pauses or cancels it, or a concrete external blocker leaves no authorized next action. Dispatch, running jobs, and handoffs are intermediate steps: receive and verify results, advance ready gates, and continue other ready work while a scope waits. A worker awaiting a manager-owned review or writer window needs a manager decision, not renewed user permission to start. Make that decision within existing authorization and preserve release gates and any approval required for actions outside that scope.

The manager may put an unresponsive issue into protective `Escalation` and preserve its prior resumption stage. This does not transfer execution ownership or authorize cleanup. Transfer or cleanup requires verified cessation of conflicting sessions, processes, Git writers, jobs, and resources. Follow [ownership and recovery](references/github-operations.md#ownership-and-unresponsive-workers); timeout alone is not evidence of cessation.

## Beta Lifecycle Authority

The active Kanban manager exclusively owns Beta on/off controls, including the `AnyWear-Service` repository variable `ENABLE_BETA_DEPLOY`, lifecycle start/stop dispatches, and equivalent direct infrastructure operations. The manager has standing user authorization to stop Beta autonomously when shutdown conditions and the shared environment writer window are satisfied. **Starting or reactivating Beta requires the user's explicit consent covering that start.** General issue execution, deployment authorization, a manager assignment, or a need for E2E does not imply permission to start Beta. Reuse an existing explicit user approval only within its recorded scope; retain its source with the environment coordination evidence.

`issue_worker`, `submodule_worker`, and other delegated workers may inspect Beta state and request a manager decision, but must not change the Beta switch or invoke start/stop, even during retries, recovery, or cleanup. An assignment or deployment writer reservation does not transfer this authority. If the manager is unavailable, preserve the current state and report the blocker; a worker must not take over Beta controls.

Before a gate change, workflow dispatch, deploying merge, or recovery, inspect whether it can activate a stopped or partially stopped Beta; preserve unknown environment state until verified. Enabling `ENABLE_BETA_DEPLOY` when it releases activation paths is part of the start permission boundary and requires explicit user consent; setting the gate to `false` does not itself prove resources stopped. After shutdown, the manager keeps automatic activation paths disabled until an approved start. Workers may deploy within their authorized scope to an already-running Beta only after the manager confirms the environment and release window; operations that could activate stopped, partially stopped, or unknown-state resources must return to the manager for the required user approval. Stop authorization alone does not authorize reactivation by automatic recovery: use a verified stop-only path or user consent explicitly covering that recovery before dispatching a pipeline that may restart Beta. Follow [Beta lifecycle operations](references/github-operations.md#beta-lifecycle-operations) for gate inspection, dispatch, and read-back. This authority does not expand Production permissions.

## Issue Intake

The manager checks duplicates and overlap, chooses an existing `Priority` option with a short rationale, identifies dependencies and shared-resource conflicts, and keeps one bounded, verifiable outcome per issue. Split outcomes with different acceptance boundaries or schedules; keep repository slices together when they share one boundary.

Record the goal, scope, acceptance criteria, affected repositories, labels, priority rationale, dependency conditions, applicable gates, and resource constraints in the Issue. Add new work to Project #4 as `Backlog`, read back membership/fields/relationships, and finish the intake at that stage. Intake does not allocate a worktree or start implementation unless execution is requested. For the helper that assembles an intake prompt, use [scripts/issue_creation.py](scripts/issue_creation.py); it never creates the Issue itself.

When a new issue arrives during active execution, finish intake-only requests at `Backlog` and resume the existing work. If execution is also requested, add the issue to active scheduling with its dependencies and resources. Do not pause, cancel, or replace existing execution unless the user asks.

## Stages and Gates

The normal path is:

`Backlog -> Analysis -> Development -> Testing -> Deployment -> Pending Closure -> Completed`

`Escalation` suspends work and records the blocker, owner/workspace, resources, current delegated work, required action, and resumption stage. Keep Issues open through `Pending Closure` and `Escalation`.

| Stage | Exit condition |
| --- | --- |
| Backlog | Scope, acceptance, owner, dependencies, resources, and workspace shape are ready |
| Analysis | Design/diagnosis, API contracts, repository order, rollout compatibility, automatic deployment triggers, risks, and applicable gates are recorded |
| Development | Required changes are published in repository PRs natively linked in the Issue's Development section; API order is Service -> published API revision -> Client |
| Testing | Required checks and review pass on intended revisions |
| Deployment | The target environment runs the intended revisions and applicable qualification passes |
| Pending Closure | Acceptance, evidence, producer release obligations, repository/resource reconciliation, and cleanup pass |
| Completed | Final evidence exists and Project Status plus native issue state read back as `Completed`, `CLOSED`, `COMPLETED` |

Determine gate applicability in Analysis. Process-only work may mark runtime Deployment and system E2E `Not Applicable`, with document/link/schema/migration/workflow validation. Client browser checks mock Service/cloud boundaries; local smoke is optional and non-gating. Real cross-repository system E2E belongs to AnyWear-E2E in Beta and later stages. A merged PR is delivery evidence, not Issue completion.

The owner has disabled `Auto-close issues with merged linked pull requests` in `git-malu/AnyWear`. Use the Issue's Development section to natively associate delivery PRs, including PRs from affected repositories; with this setting disabled, merging a linked PR does not close the Issue. Keep check/deployment/acceptance evidence in comments, avoid closing keywords, and close only after the lifecycle gates and cleanup pass. Follow [PR associations](references/github-operations.md#pr-associations) for linking and read-back.

Run required checks, obey branch protection and existing session authorization, and repeat affected checks when revisions change. Record evidence before advancing; resolve failures in the current scope.

For runtime work, qualify the required environment through its repository pipeline and AnyWear-E2E. Record intended and observed Client/Service revisions, full E2E compatibility inputs, run links, and recovery results. A merge that deploys is a release action: validate its compatibility and authorization before merging. Read [release coordination](references/github-operations.md#release-coordination) for rollout and qualification details.

## Scheduling and Handoffs

Record `A blocks B`, the affected work, dependency kind, release condition, and evidence in native relationships and comments.

- **Artifact release (default for new dependencies):** A publishes an immutable commit/API/document revision and producer checks. The manager releases the blocker after verifying availability and reads back the relation. B later pins the revision and records consumer acceptance.
- **Lifecycle dependency:** B explicitly waits for A's verified Completed/closed-as-completed pair. Publish A's deliverable evidence before closure, then reconcile the relation.

Preserve existing documented conditions; clarify unspecified legacy conditions before execution. Producer closure does not generally wait for consumer acceptance. If A's own acceptance requires integrated A+B behavior, state that boundary explicitly or keep the work under one Issue; never create a cycle where B waits for A Completed while A waits for B acceptance.

If a released input becomes invalid, the producer records the reason, notifies the manager and consumers, and requests suspension. Consumers stop dependent mutations and account for in-flight deployments and already-applied revisions. Resume only after a replacement is verified and affected results are rechecked. A newer revision or unrelated reopening alone does not invalidate a pinned input. Independent preparation may continue while dependent execution waits in its current stage; Escalation is for required human intervention.

Without a manager, an issue worker may execute its ready assigned issue after checking board ownership, dependencies, handoffs, and resources. It may reconcile a documented incoming blocker but cannot silently change its condition, reassign work, resolve cross-issue conflicts, launch other issues, or operate Beta lifecycle controls.

## Worktrees and Resources

Before the first edit, the issue worker allocates or reuses one issue-owned worktree and records its Git/platform origin, absolute path, owner claim, branches/Git writers, and resource assignments. Recover the existing recorded workspace before creating another. Default to `<primary-root-checkout>/.worktrees/issue-<number>-<slug>`; standalone work may use the owning primary repository. Verify ignore rules, fetch the target branch, and initialize required submodules. Never nest issue worktrees or switch shared checkouts while children work. Coordinate runtime resources separately; worktrees isolate only files and Git state.

## Closure and Board Reconciliation

Before closure, merge required delivery PRs, verify acceptance and producer release obligations, update affected documentation, and reconcile every touched repository. Persist delivery/acceptance evidence remotely before removing local resources. Preserve intentional submodule pins in integration commits/PRs and restore temporary pins. Update only assigned clean base checkouts by fetch/fast-forward. Release resources after writers and in-flight jobs stop or finish, and preserve needed ignored/untracked artifacts outside the removable tree. Follow [cleanup inventory](references/github-operations.md#worktree-cleanup-inventory) for nested repositories, preservation checks, and removal safeguards.

Agent-created Git worktrees use Git lifecycle operations; platform-managed worktrees use their platform lifecycle. Record actual cleanup from a surviving checkout. Only then append final evidence, set `Completed`, close as completed, and read back both. Dirty/unpushed work must be preserved; unavailable cleanup leaves closure unfinished. A closed unmerged PR is not delivered evidence.

The manager reconciles membership, owners, priority, active blockers, stage/open-state consistency, native PR associations, evidence links, and automation behavior. The primary view contains Issues; PRs are evidence or belong in a separate review view.

## Recovery, Reopening, and Cancellation

Read current records before remote mutations and read back meaningful results. On timeout, inspect actual state and retry only missing steps, reusing the issue, evidence, owner, and workspace. Preserve work on interruption, revalidate ownership/suspension before resuming, and do not report unverified remote success or maintain a fallback local tracker.

Reopening restores the earliest affected stage and revalidates handoffs. Cancellation/supersession preserves or explicitly handles outstanding work, reconciles resources/dependencies, closes as not planned or duplicate, and clears/archives the Project lifecycle item. Neither asserts successful delivery. Read [remote recovery](references/github-operations.md#remote-read-back-and-partial-updates) for exact mutation order and read-back.

## Validation and Delegation

At each scope use `define -> execute -> observe -> adjust -> verify`. Parents integrate and verify child results before advancing. Delegate with role, Issue URL, repository, absolute worktree path, scope, expected evidence, and stopping condition; see [role prompts](references/github-operations.md#role-prompts).

When revising this contract, run the read-only [simulation checks](references/github-operations.md#workflow-simulation-checks), skill validation, affected links, and relevant repository documentation checks. Add a rule only when it changes a concrete decision; prefer correcting an existing rule over accumulating exceptions or duplicating it in entry-point files.
