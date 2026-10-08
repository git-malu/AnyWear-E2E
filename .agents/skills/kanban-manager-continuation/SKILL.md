---
name: kanban-manager-continuation
description: Resume already-authorized AnyWear Project #4 work as the existing Kanban manager on scheduled wakeups or manual continuation. Reuse current owners and live evidence; intake alone does not authorize execution.
---

# Kanban Manager Continuation

Continue coordination in the existing authorized manager session for `git-malu/AnyWear` and [Project #4](https://github.com/users/git-malu/projects/4). A wakeup resumes work within that session's authorization; it does not start a second manager or grant new execution, deployment, trust, credential, or Production authority. If invoked outside the recorded manager session, establish an authorized handoff before scheduling work.

Read the current primary checkout's `AGENTS.md`, [kanban-workflow](../kanban-workflow/SKILL.md), and the relevant [GitHub operations](../kanban-workflow/references/github-operations.md) sections. Those sources own roles, lifecycle gates, dependencies, release coordination, ownership recovery, and closure. Use the primary checkout specified by the caller when running from a temporary worktree. Keep schedule, target session, and app notification settings in the automation configuration; keep live issue state in GitHub.

## Observe Each Wakeup

1. Check the session's latest user instructions, pauses, cancellations, and release freezes. Verify the effective `gh` account is `git-malu` and the repository and Project identities match before remote operations. If access, ownership, or required source files cannot be verified, preserve the scene and report the concrete blocker.
2. Read the live Project items with pagination, including Status, Priority, archive state, native issue state, and repository. For relevant issues, read scope, acceptance, current owner/session/Transfer, workspace, native dependencies, comment-defined artifact or lifecycle release conditions, and latest PR, Actions, deployment, and acceptance evidence. Inspect active writers, delegated work, and in-flight jobs before deciding what remains to be done.
3. Select only already-authorized, unarchived, open issues in `Analysis`, `Development`, `Testing`, `Deployment`, or `Pending Closure`. Exclude `Backlog`, `Completed`, PR cards, and items without a valid lifecycle Status from automatic execution. Intake is not execution authorization. Recover documented partial lifecycle mutations under the workflow before treating an inconsistent item as complete. For `Escalation`, first inspect the specific blocker without mutation; resume only when its recorded recovery conditions are actually met and the user has not paused the work.

## Continue Coordination

Order ready work by Priority and dependency readiness. Reuse the recorded issue owner, Transfer, and issue-owned workspace. Check the owner's latest progress before dispatching work; retain running jobs and existing assignments. Apply the workflow's verified-cessation rules for recovery or transfer, and coordinate repository, main-branch integration, and deployment writer windows. The manager coordinates decisions and evidence; issue owners implement and clean their workspaces.

For each ready scope, identify and perform the next action within existing authorization. A worker awaiting manager review or a writer window needs a manager decision. Receive and independently verify handoffs, resolve failures within scope, advance gates only after their evidence passes, and continue other ready issues while one waits. Dispatch, running jobs, and status reports are intermediate steps; continue until the requested work is verified complete, explicitly paused or cancelled, or concrete external blockers leave no authorized next action.

When dependencies are unreleased, continue only independent, authorized preparation. Preserve the recorded artifact/lifecycle conditions, branch protection, every applicable issue-specific gate, and user freezes. Consult the workflow and current issue records for source, publication, native release, receipt, runtime, rollback, E2E, and cleanup checks rather than treating this skill as a shortcut around them.

After a new result or uncertain operation, compare intended and observed remote state, retry only missing steps, and read back meaningful mutations. Preserve evidence and resources when a result cannot be confirmed. Issue owners complete acceptance, remote evidence, reconciliation, and cleanup under the workflow; the manager independently verifies the final Project Status and native completion state before reporting completion.

## Reporting and Recurrence

Do not repeat comments, state changes, or user-facing status updates when there is no actionable new information. Report verified delivery completion, a genuine failure, or a blocker requiring user action concisely, with the necessary evidence links and next action.

Leave the long-term schedule active when no issue is currently ready, including when the current issues have completed, so later authorized work entering an active stage can be continued. Stop or hand off the scheduled continuation only when the user requests stopping it or changing the manager session. Pausing one issue preserves that pause without cancelling unrelated authorized work.
