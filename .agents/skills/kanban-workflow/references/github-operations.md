# GitHub Operations

Use this reference for intake, remote transitions, relationship updates, Project configuration, and resumable evidence. The main skill defines ownership and gates.

## Discovery and Intake

The issue home is `git-malu/AnyWear`; the operational Project is user `git-malu`, number `4`. Discover IDs and options from the live Project instead of hardcoding them. Issue mutations need repository access; Project reads need `read:project`, and writes need `project` for classic CLI tokens. Check effective access, not only the token's displayed scopes.

```powershell
gh auth status
gh project view 4 --owner git-malu --format json
gh project field-list 4 --owner git-malu --format json
gh project item-list 4 --owner git-malu --limit 1000 --format json
gh issue list --repo git-malu/AnyWear --state all --limit 1000 --json number,title,state,labels,url
gh issue view 47 --repo git-malu/AnyWear --json number,title,body,comments,assignees,labels,state,url
gh api --paginate repos/git-malu/AnyWear/issues/47/dependencies/blocked_by
gh api --paginate repos/git-malu/AnyWear/issues/47/dependencies/blocking
gh api --paginate repos/git-malu/AnyWear/issues/47/sub_issues
```

Verify coverage against returned totals; use pagination if a limit excludes relevant work. Include closed issues in duplicate/supersession checks, but distinguish historical outcomes from active work.

Prepare exact multiline bodies/comments in a temporary file using normal file-edit tools, then pass `--body-file`. Do not embed long text in shell quoting. A useful issue body is:

```markdown
## Goal
<one bounded, verifiable result>

## Scope
<affected repositories, boundaries, technical constraints>

## Acceptance Criteria
- [ ] <observable outcome>

## Coordination
<priority rationale, split/grouping decision, resource/integration constraints>
<dependency issue URL, affected work, release condition, expected evidence>
<future revisions may be pending; pin an available exact revision at verified handoff>

## Validation and Delivery
<applicable checks/environments and justified Not Applicable gates>
<stable links to larger Meta design documents>
```

```powershell
gh issue create --repo git-malu/AnyWear --title 'Refactor: <bounded result>' --label refactor --label kanban --body-file '<body-file>'
gh project item-add 4 --owner git-malu --url '<issue-url>' --format json
gh project item-edit --id '<item-id>' --project-id '<project-id>' --field-id '<status-field-id>' --single-select-option-id '<Backlog-option-id>'
gh project item-edit --id '<item-id>' --project-id '<project-id>' --field-id '<priority-field-id>' --single-select-option-id '<priority-option-id>'
```

Do not create another issue after an uncertain response: search for the new title/body and creation comment first. If issue creation succeeds but adding fields or relationships fails, complete the existing issue's intake and report the unfinished step.

For dependencies, obtain the prerequisite's numeric REST issue ID (different from its number and GraphQL node ID). To record that issue 48 is blocked by issue 47:

```powershell
gh api repos/git-malu/AnyWear/issues/47 --jq .id
gh api --method POST repos/git-malu/AnyWear/issues/48/dependencies/blocked_by -F 'issue_id=<numeric-issue-id-of-47>'
gh api --method DELETE 'repos/git-malu/AnyWear/issues/48/dependencies/blocked_by/<numeric-issue-id-of-47>'
```

Use DELETE only after the recorded release condition is verified; read back both sides. To add a child, use `POST repos/git-malu/AnyWear/issues/<parent-number>/sub_issues` with `-F 'sub_issue_id=<numeric-child-issue-id>'`. Check existing native relationships before mutation. If the deployment/account lacks native relation support, record the precise access/API blocker and request coordination rather than silently treating prose as a successful native update.

## Remote Read-Back and Partial Updates

Project membership and fields belong to the **Project item**, not the Project object. A GraphQL read-back can use:

```graphql
query {
  repository(owner: "git-malu", name: "AnyWear") {
    issue(number: 47) {
      url
      state
      stateReason
      projectItems(first: 100, includeArchived: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          project { id number url }
          fieldValues(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { id name } }
              }
            }
          }
        }
      }
    }
  }
}
```

Select Project #4's item, then verify Status/Priority, `isArchived`, and the expected open/closed state. Include archived items when recovering cancellation or reopening; an archived card is not missing membership. Do not accidentally update another Project's item. For additional pages, follow GraphQL cursors. Use `gh api repos/git-malu/AnyWear/issues/<number> --jq '{state,state_reason}'` to verify native closure reason.

A transition is a recoverable operation:

1. Read body, latest comments, stage/state, relationships, owner/worktree record, and relevant evidence. For a new owner, claim the issue with an identifiable agent/session and read back the latest claims; an existing active owner must be reconciled before work starts. A shared GitHub assignee alone does not distinguish multiple agent owners.
2. Record an identifiable evidence comment describing the gate result and intended transition, for example `Operation: issue-47-testing-to-deployment-<revision>`. Keep this key when recovering an interrupted operation.
3. Update the intended Project field/relationship/state. Read it back. Correct mismatches before executing work in the next stage; append a correction if the earlier comment's intended result did not occur.
4. After a timeout or interruption, find the existing operation comment and compare remote records with the intended result. Retry only missing steps. Do not repost evidence, allocate another worktree, or start a second worker by default.

Closing requires the final acceptance/cleanup comment to exist before `Completed` and close mutations. If Status changed but closing failed, restore Pending Closure where possible and retry after inspecting native state. If closing succeeded but Status is wrong, repair that field without redoing delivery/cleanup. Never claim success until the verified pair is `Status=Completed`, `state=CLOSED`, `stateReason=COMPLETED`.

## Evidence Comments

Use concise records suited to the actual transition; these examples show the needed information, not mandatory boilerplate.

```text
Operation: issue-47-analysis-to-development-<revision>
Owner: <agent/session>; Worktree: <absolute path>; Branches: <repository -> branch>
Gate: scope/design and dependency readiness verified; intended Analysis -> Development.
Acceptance: <body criteria>; Validation: <checks>; Deployment/runtime E2E: N/A, process-only.
Resources: <allocated or coordinated>; Evidence: <document/commit links>.
```

```text
Handoff: A -> B; release condition: <narrow deliverable, or A Completed>.
Revision: <producer commit/API/document version>; Availability: <remote link>.
Verification: <check result>; Consumer incorporated: <consumer revision/check>.
Native blocking relation: <retained until completion, or released after this condition>.
```

```text
Handoff invalidated: <revision> because <concrete failing condition>.
Affected: <issue URLs, work/tests>; owners/manager notified; suspension requested.
Blocking relation: <manager reconciliation>; Consumer acknowledgment: <pending or evidence>.
In-flight deployments: <owner-verified state/results and required remediation>.
Suspension confirmed only for: <acknowledged scopes>; replacement/revalidation: <conditions>.
```

```text
Escalation from Testing: <blocker>; required human action: <decision/access>.
Owner: <agent/session>; Worktree/branches/PRs: <paths and links>.
Children: <stopped/acknowledged>; Resources: <retained/released>.
Remaining gates: <checks>; resume at Testing after <condition and revalidation>.
```

```text
Reopened: <failed criterion or new evidence>; intended stage: Testing.
Existing delivery: <revisions/PRs>; workspace: <reuse/new after prior cleanup>.
Affected handoffs: <invalidated inputs or still-valid pinned revisions>.
Required repair/reverification: <scope>; owner/manager coordination: <decision>.
```

```text
Acceptance verified: <criteria, PRs/revisions, check/deployment links, N/A rationale>.
Downstream handoffs: <conditions and revisions>; repository/base reconciliation: <results>.
Cleanup: <absolute worktree removed and metadata pruned; resources released>.
Final intent: Pending Closure -> Completed; close as completed; verify remote pair.
```

```text
Cancelled/duplicate: <reason>; canonical or replacement issue: <URL>.
Children stopped; outstanding changes preserved/disposed by <recorded decision>.
Dependencies/resources/worktree reconciled: <evidence>; cancel as not planned or use native duplicate closure.
Clear lifecycle Status and archive Project item; this does not assert successful delivery.
```

Use `gh issue comment <number> --repo git-malu/AnyWear --body-file '<comment-file>'` and verify the returned comment. For cancellation, `gh issue close <number> --repo git-malu/AnyWear --reason 'not planned'`; for duplication, use `--duplicate-of '<canonical-issue-url>'`; for delivery, use `--reason completed`. Reopen with `gh issue reopen`. Clear cancellation/duplicate Status with `gh project item-edit --id '<item-id>' --project-id '<project-id>' --field-id '<status-field-id>' --clear` and archive with `gh project item-archive 4 --owner git-malu --id '<item-id>'`. Preserve history and membership; unarchive with `--undo` when restoring an archived operational issue. Read back archived-inclusive membership and `isArchived=true` after cancellation or `isArchived=false` with open state/intended stage after reopening. After a timeout, inspect these results before repeating archive/unarchive or adding membership.

## Worktree Cleanup Inventory

Before removing an issue worktree, list its initialized submodules and run these inventories in the root and each initialized/nested repository:

```powershell
git -C '<issue-root>' submodule status --recursive
git -C '<repository-path>' status --short --untracked-files=all
git -C '<repository-path>' ls-files --others --exclude-standard
git -C '<repository-path>' ls-files --others --ignored --exclude-standard
```

The two `ls-files` commands distinguish untracked non-ignored files from ignored files. Root inventory does not substitute for checking submodules. Classify artifacts as needed or disposable; preserve needed files outside the entire tree being removed, then verify the preserved files are readable and match the originals (compare content or hashes as appropriate). Record the inventory decisions and preservation locations in cleanup evidence before removal. A clean status or merged PR does not establish that ignored reports, local configuration, or other artifacts can be discarded. Keep the main skill's dirty/unpushed-work, ownership, and minimum-force safeguards.

## Project Configuration and Legacy Migration

- Inspect the live field options, views, and built-in/custom workflows. Keep exact Status options from the main skill and reuse Priority/native fields. Preserve existing IDs where possible when editing options; re-read all affected cards afterward.
- Use an issue-only primary board (`is:issue`), grouped by Status and ordered by Priority; keep PR evidence/review cards in a separate view. Verify native assignees, labels, parent/sub-issue progress, and dependency information can be inspected without duplicating fields.
- Audit automations for item closed, PR linked/merged, auto-close, and auto-archive. Disable or adjust triggers that can prematurely close lifecycle issues or set Completed. Configuration UI may be required when CLI/public API cannot expose the setting; absence from an API response is not evidence that an automation is disabled.
- Inspect existing Ready/Design/Review/Done records against their actual evidence. Readiness is a scheduling condition; review is a PR gate. Do not mechanically promote Done to Completed when cleanup/acceptance cannot be verified.
- Distinguish retained historical owner completion from a new verified closure. Record its provenance and missing historical evidence; never assert that current gates were retroactively verified or rerun.
- Reconcile each actionable legacy record to one canonical GitHub issue and Project item, preserving goal, scope, acceptance, priority, native parent/dependency relations, historical evidence, and stable source references. Reuse matching GitHub issues; supporting designs/checklists stay in Meta as linked documents. Keep a migration mapping for auditability, not as a second live tracker.
- After verifying migration coverage, remove the retired local tracking tree and replace operational links with GitHub URLs. Preserve useful supplementary designs/evidence under Meta `records/`, accepted contracts under `architecture/`, and original tracking history through immutable Git revisions and the migration map. Publish an annotated migration tag on the delivered commit. Verify coverage, duplicates, link resolution, and stage/open-state consistency; do not recreate `AnyWear-Meta/issues` as a fallback tracker.

## Role Prompts

The optional [intake helper](../scripts/issue_creation.py) assembles a request for the manager using this reference and the skill's Issue Intake section. From the root checkout:

```powershell
python .agents/skills/kanban-workflow/scripts/issue_creation.py create --title 'Refactor: <bounded result>' --type refactor --body-file proposal.md
```

Intake:

```text
Use the kanban_manager role.
Create or triage an AnyWear issue for: <request>.
Inspect existing issues and Project #4 for duplicates, scope, relative priority,
dependencies, split suitability, and shared-resource conflicts. Use native fields
and relationships. Add new issues in Backlog, verify remote records, and return
issue URLs and coordination decisions. Begin execution only when requested.
```

Board coordination:

```text
Use the kanban_manager role.
Coordinate Project #4 intake, readiness and verified handoffs, concurrent ready
issues, worker assignments, shared resources, and board reconciliation.
Delegate one issue_worker per issue with explicit ownership and stopping conditions.
```

Issue execution:

```text
Use the issue_worker role. Issue: <GitHub issue URL>.
Own its current stage through closure or escalation. Verify readiness and ownership,
allocate/reuse its project-local worktree, delegate repository slices, integrate
evidence, satisfy applicable gates, and record cleanup before final remote closure.
Return stage/state, PRs, checks, delivery/cleanup evidence, and outstanding blockers.
```

Repository slice:

```text
Use the submodule_worker role. Issue: <GitHub issue URL>.
Repository: <name>. Worktree: <absolute repository path>.
Scope: <owned files/outcome>. Evidence: <commits/PRs/checks/handoff revisions>.
Stop at: <verified deliverable or blocker>. You are not alone: preserve other owners'
changes. Return evidence to the issue worker; do not change lifecycle records or
remove shared worktrees.
```
