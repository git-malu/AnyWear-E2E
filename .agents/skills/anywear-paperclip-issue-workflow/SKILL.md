---
name: anywear-paperclip-issue-workflow
description: |
  Paperclip issue-level orchestration for the AnyWear development workflow.
  Describes how to structure and drive work through three issue types:
  a parent (main) issue with Backlog Refinement, plus child Development
  and Verification (E2E) issues.

  Triggers when user mentions:
  - "AnyWear workflow" / "dev workflow" / "development pipeline"
  - "how to develop for AnyWear" / "AnyWear development process"
  - "backlog refinement" / "what should we build" / "should we do it"
  - "verify with e2e" / "run e2e tests" / "verification phase"
  - "issue structure" / "parent issue" / "sub issues"
  - "AnyWear issue orchestration"
---

# AnyWear Issue Workflow

Paperclip issue-level orchestration for the AnyWear project. Every piece of
work moves through exactly three issue types: a **parent (main) issue** for
Backlog Refinement, a **Development** child issue, and a **Verification (E2E)**
child issue.

## Workflow Diagram

```mermaid
flowchart TD
    MAIN["Parent Issue\n(ANY-{N})\nBacklog Refinement"]
    DEV["Development Issue\n(ANY-{N}-DEV)\nImplement the change"]
    VERIFY["Verification Issue\n(ANY-{N}-E2E)\nE2E testing"]

    MAIN -->|"what? should we?\n(approved)"| DEV
    DEV -->|"implementation done"| VERIFY

    VERIFY -->|"bug found, related\nto this change"| DEV
    VERIFY -->|"bug found, unrelated\n→ new Bug Issue"| BUG["Bug Issue\n(ANY-{M})\nFix later"]

    VERIFY -->|"all checks pass"| DONE(["Done"])
```

## Issue Structure

Every unit of work uses a parent issue with two child issues.

### Parent Issue (Main Issue)

The entry point. Its only job is **Backlog Refinement** — answering two
questions before any code is written:

1. **What do we want to do?** — define the change clearly.
2. **Should we do it?** — is it worth doing now?

The parent issue holds a short refinement document with:

- Problem statement
- Proposed solution (high-level, which repos are affected)
- Scope (in/out)
- Acceptance criteria
- Decision: what and should we?

Only after the refinement is approved does the parent issue spawn the
development child.

**Status flow**: `backlog` → `todo` → `in_progress` (refinement) → `in_review`
(approval) → spawns children → `in_progress` (tracking children) → `done` (when
both children complete).

### Development Issue (Child)

Implements the change defined in the parent's refinement. Works in the
AnyWear repositories (`AnyWear-Client/`, `AnyWear-Service/`, `AnyWear-Meta/`).

**Creation**: `POST /api/companies/{companyId}/issues` with:
- `parentId`: the parent issue ID
- `goalId`: same as parent's `goalId`
- `title`: derived from parent (`"{parent-title} — Development"`)
- `blockedByIssueIds`: empty (starts immediately after parent approval)

**Status flow**: `todo` → `in_progress` → `done` (when implementation complete
and all scripted tests pass).

### Verification Issue (Child)

Runs E2E testing against the completed development. Uses the
`autonomous-e2e-test` skill approach — Playwright-driven browser testing of the
AnyWear Client web layer.

**Creation**: created at the same time as the Development issue, but starts with
`blockedByIssueIds: [<dev-issue-id>]` so it waits for development to finish.

**Status flow**: `blocked` (waiting for dev) → `todo` (dev done) → `in_progress`
→ branches based on outcome:

| Outcome | Action |
|---------|--------|
| All E2E checks pass | → `done` |
| Bug found, related to this change | → reopen dev issue (`todo`), set `blockedByIssueIds: [<dev-issue-id>]`, add comment with findings |
| Bug found, unrelated to this change | → create a new **Bug Issue**, link it to the parent, set verification to `done` |

## Bug Handling

When the Verification issue finds a bug, determine if it's related to the
current parent issue:

### Related Bug
The bug is a regression or flaw in the feature being built. Reopen the
Development issue:

```
PATCH /api/issues/{dev-issue-id}
{ "status": "todo" }

PATCH /api/issues/{e2e-issue-id}
{ "status": "blocked", "blockedByIssueIds": ["{dev-issue-id}"] }
```

Add a comment on the verification issue describing the bug and linking to
the reopened dev issue. The developer fixes it, then verification reruns.

### Unrelated Bug
The bug exists in the codebase but is not caused by or related to the
current change. Create a standalone bug issue:

```json
POST /api/companies/{companyId}/issues
{
  "title": "Bug: <description>",
  "description": "<reproduction steps, observed behavior, expected behavior>",
  "status": "backlog",
  "priority": "medium",
  "parentId": "<parent-issue-id>",
  "goalId": "<same-goal-id>"
}
```

The current verification issue can then be marked `done` — the unrelated
bug is tracked separately for future work.

## Lifecycle Summary

```
Parent (backlog/todo) → Refinement (in_progress) → Approval (in_review)
  → Spawn: Dev (todo) + E2E (blocked on Dev)
  → Dev (in_progress → done)
  → E2E (todo → in_progress)
    → Pass: Parent + E2E → done
    → Related fail: Dev reopened (todo), E2E blocked → fix → retest
    → Unrelated fail: Bug issue created (backlog), E2E → done
```

## Key Rules

1. **Backlog refinement first** — answer "what?" and "should we?" before
   creating development/verification issues.
2. **Parent → children** — the parent spawns exactly two children: one
   Development, one Verification.
3. **E2E gates completion** — no issue is done until verification passes or an
   unrelated bug is extracted.
4. **Related bugs loop back** — reopen the dev issue, not a new one.
5. **Unrelated bugs are separate issues** — capture them in the backlog, don't
   block the current work.
6. **Blockers are first-class** — use `blockedByIssueIds` to express the
   dev → e2e dependency, not free-text comments.

## Cross-References

- `autonomous-e2e-test` skill — Playwright-based E2E testing of the client web layer
- `git-submodule-ops` skill — submodule pull/commit/push/merge commands
