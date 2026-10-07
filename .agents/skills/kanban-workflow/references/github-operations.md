# GitHub Operations

Use this reference for GitHub intake, mutations, release coordination, recovery, and evidence. The main skill owns roles, gates, dependencies, worktree allocation, and closure criteria.

## Discovery and Intake

The repository is `git-malu/AnyWear`; the operational Project is user `git-malu`, number `4`. Discover live IDs and options. Issue mutations need repository access; Project reads need `read:project`, and writes need `project` for classic CLI tokens. Check effective access, paginate where limits hide work, and include closed issues in duplicate checks.

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

Prepare multiline bodies/comments in a temporary file and pass `--body-file`. A useful body contains:

```markdown
## Goal and Scope
<bounded result, affected repositories, constraints>
## Acceptance Criteria
- [ ] <observable outcome>
## Coordination
<priority rationale, splits, dependencies and artifact/lifecycle release condition>
## Validation and Delivery
<checks, justified N/A gates, deployment triggers/compatibility/recovery, Meta links>
```

```powershell
gh issue create --repo git-malu/AnyWear --title 'Refactor: <result>' --label refactor --label kanban --body-file '<body-file>'
gh project item-add 4 --owner git-malu --url '<issue-url>' --format json
gh project item-edit --id '<item-id>' --project-id '<project-id>' --field-id '<status-field-id>' --single-select-option-id '<Backlog-option-id>'
gh project item-edit --id '<item-id>' --project-id '<project-id>' --field-id '<priority-field-id>' --single-select-option-id '<priority-option-id>'
```

After uncertain creation, search title/body before retrying. If fields or relationships failed after creation, finish intake on the existing issue and report the incomplete step.

Native dependency endpoints require the prerequisite's numeric REST ID, not its number or GraphQL node ID:

```powershell
gh api repos/git-malu/AnyWear/issues/47 --jq .id
gh api --method POST repos/git-malu/AnyWear/issues/48/dependencies/blocked_by -F 'issue_id=<numeric-id-of-47>'
gh api --method DELETE 'repos/git-malu/AnyWear/issues/48/dependencies/blocked_by/<numeric-id-of-47>'
```

Read both sides before/after relationship changes. Add a child with `POST repos/git-malu/AnyWear/issues/<parent-number>/sub_issues` and `-F 'sub_issue_id=<numeric-child-id>'`. Remove an artifact blocker after producer revision availability/checks; consumer acceptance follows separately. Remove a lifecycle blocker after the prerequisite's verified Completed/closed-as-completed pair. Preserve recorded conditions: an absent native blocker does not establish input release. Unsupported native relations require an explicit access/API blocker and coordination.

## Remote Read-Back and Partial Updates

Fields belong to the Project item. Read the issue's item, not just Project metadata:

```graphql
query {
  repository(owner: "git-malu", name: "AnyWear") {
    issue(number: 47) {
      url state stateReason
      projectItems(first: 100, includeArchived: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id isArchived project { id number url }
          fieldValues(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { ... on ProjectV2ItemFieldSingleSelectValue {
              name field { ... on ProjectV2SingleSelectField { id name } }
            } }
          }
        }
      }
    }
  }
}
```

Select Project #4's item; verify Status, Priority, archive state, and issue state. Follow cursors for additional pages. Native closure reason is also available with `gh api repos/git-malu/AnyWear/issues/<number> --jq '{state,state_reason}'`. Archived membership is not missing membership.

For each transition: read current scope, evidence, authorized claim/transfer, relations, and state; append an identifiable operation comment; mutate intended records; read back and correct mismatches before advancing. After interruption, reuse that comment and retry only missing steps. Do not duplicate evidence, worktrees, or workers.

Final acceptance/cleanup evidence precedes close mutations. If Status changed but closing failed, restore Pending Closure where possible and retry. If close succeeded with wrong Status, repair only that field. Success is `Status=Completed`, `state=CLOSED`, `stateReason=COMPLETED` verified together.

## Ownership and Unresponsive Workers

The initial claim records owner/session, UTC time, `Transfer: 0`, assigning manager/human, scope, Git/platform worktree origin/path, repository branches/Git writers, and resource/deployment writers. Reconcile existing manager/allocation records and competing claims before mutation; comments are assignment evidence, not atomic locks. Resuming owners read the current claim and stop if superseded. Later records link unchanged facts.

1. Inventory owner/children, processes, worktrees, Git state, Actions/deployments, and resources. Record a stop request with an acknowledgment deadline; expiry triggers investigation, not takeover.
2. Ask reachable workers to stop mutations and report jobs/resources. Verify cessation using acknowledgments plus runtime evidence; acknowledgment alone does not stop external jobs.
3. For an unresponsive worker, inspect session/process termination, Git locks, jobs, and resource use. Record stopped, finished, running, and unknown scopes. Timeout, quiet comments, or an absent lock do not prove cessation; never remove locks or terminate unrelated processes to manufacture it.
4. After every conflicting writer is verified stopped, the manager (or assigning human) records the next numbered transfer, retained work/resources, evidence, and resume stage. The incoming owner reads it back and revalidates revisions, Git state, dependencies, and resources.
5. Preserve unknown/running scopes and dirty/unpushed work; prohibit conflicting writes/cleanup and escalate. The active manager may record protective suspension and set Escalation with the prior resume stage, then read back. This is not execution transfer or proof jobs stopped. A returning worker checks suspension before resuming. Without a manager, the assigning human coordinates intervention. GitHub failure leaves the scene preserved and remote transfer unverified.

## Release Coordination

Inspect actual pipeline triggers during Analysis. Record environment/deployment writer, intended and current versions, rollout order, intermediate compatibility, and recovery. A deploying merge needs applicable checks and authorization before merge; PR checks alone do not prove compatibility with the running peer.

Prefer additive Service -> published API -> Client rollout -> actual pair qualification -> later retirement. Keep supported old consumers functional, including installed clients after web rollout. Removal needs migration evidence or a versioned boundary; incompatible transitions need explicitly authorized interruption and recovery conditions.

For Beta and later stages, record intended full Client/Service SHAs, AnyWear-E2E revision/compatibility inputs, run links, and observed deployed versions from runtime provenance or deployment metadata. Verify identities match; otherwise the gate remains unfinished. Requalify changed inputs. Mocked browser checks/local smoke do not substitute for this evidence.

## Evidence Comments

Record only changed facts and decision evidence; reference earlier records for unchanged facts. These three examples are adaptable, not mandatory forms:

```text
Operation: <unique key>; Owner/claim/transfer: <reference>; Intended: <from -> to>.
Gate/result: <condition>; Evidence: <PRs/revisions/checks/deployments>; N/A: <rationale>.
For final closure: acceptance, release obligations, repository/resource reconciliation,
cleanup inventory/origin/method/result <links>; intended Completed/closed-as-completed.
```

```text
Producer release A -> B: <condition>; immutable revision/availability/checks: <links>.
Blocker: <artifact released/read back, or lifecycle Completed pair verified>.
Consumer acceptance on B: <pending, or pinned revision and behavior/check results>.
When deploying: <environment/writer/order/compatibility/recovery>; intended Client/Service/E2E
revisions, observed versions and qualification: <links>.
```

```text
Claim/recovery: <owner/session, UTC, assigning authority, transfer, scope/worktree/resources or prior link>.
Reason: <stop/blocker/cancellation/reopening/invalidation>; related issue/evidence: <links>.
Cessation: <session/process/lock/job/resource observations; stopped/finished/running/unknown>.
Decision: <authorized transfer or protective suspension>; retained work/resources: <paths>.
Resume: <stage, required human action/revalidation>; new owner/transfer: <if authorized>.
```

Post comments and verify the returned record. Use these mutation commands after the required evidence:

```powershell
gh issue comment <number> --repo git-malu/AnyWear --body-file '<comment-file>'
gh issue close <number> --repo git-malu/AnyWear --reason completed
gh issue close <number> --repo git-malu/AnyWear --reason 'not planned'
gh issue close <number> --repo git-malu/AnyWear --duplicate-of '<canonical-url>'
gh issue reopen <number> --repo git-malu/AnyWear
gh project item-edit --id '<item-id>' --project-id '<project-id>' --field-id '<status-field-id>' --clear
gh project item-archive 4 --owner git-malu --id '<item-id>'
gh project item-archive 4 --owner git-malu --id '<item-id>' --undo
```

Cancellation/duplicate: record reason/replacement, verify child cessation, preserve or explicitly dispose of changes, and reconcile dependencies/resources/worktrees. Close as not planned or native duplicate, clear Status, and archive. Verify close reason, cleared Status, links, and `isArchived=true`.

Reopening: comment failed criterion/new evidence, reopen, unarchive the retained item (add only if absent), and restore the earliest affected stage. Verify open state, stage, `isArchived=false`; revalidate affected handoffs and reuse a retained workspace or allocate after prior cleanup. Reopening alone does not invalidate pinned inputs. Inspect outcomes before retrying any timed-out mutation.

## Worktree Cleanup Inventory

Inspect the root and every initialized/nested repository:

```powershell
git -C '<issue-root>' submodule status --recursive
git -C '<repository-path>' status --short --untracked-files=all
git -C '<repository-path>' ls-files --others --exclude-standard
git -C '<repository-path>' ls-files --others --ignored --exclude-standard
```

Classify artifacts as needed/disposable. Preserve needed files outside the removable tree and verify content/hashes before removal; record decisions and locations. Clean status/merged PR does not prove ignored reports/configuration are disposable.

Remove agent-created Git worktrees with `git worktree remove <absolute-path>` from the owning base checkout, then prune stale metadata; never delete the directory directly. Initialized submodules may require force even when clean: first check every repository for dirty/unpushed work, ownership, and remote/artifact preservation, then use minimum necessary force. Never force past locks or data loss. Platform-managed worktrees use the platform lifecycle; unavailable cleanup remains unfinished. Verify and record cleanup from a surviving checkout.

## Project Configuration

Inspect fields, views, and automations. Preserve existing IDs; use the skill's exact Status options and native fields, re-reading affected cards. Keep an issue-only primary board grouped by Status/ordered by Priority, with PR evidence in a separate view. Disable or adjust item-close, PR-link/merge, auto-close, and archive triggers that can complete issues prematurely. Use configuration UI when API/CLI visibility is insufficient; absence from an API response proves nothing about a trigger.

Historical migration provenance and canonical identities live in [Meta's records](../../../../AnyWear-Meta/records/README.md) and [migration map](../../../../AnyWear-Meta/records/kanban-migration/migration-map.json). Retained historical completion must not be described as newly verified acceptance/cleanup.

## Workflow Simulation Checks

Dry-run these fixtures without creating issues, deploying, terminating processes, or removing worktrees. Unknown scopes require preservation and escalation.

| Fixture | Required result |
| --- | --- |
| Intake timeout finds issue without Project membership | Reuse it; finish Backlog/Priority/relations and read back; return URL without implementation/worktree. |
| Service auto-deploys Beta; Client is manual; producer artifact ready | Check old-consumer compatibility before merge; release artifact blocker; consumer pins/validates afterward. Lifecycle variant waits for Completed pair. Qualify actual runtime pair. |
| Owner/child disappears with ignored report/unpushed API commit | Verified stopped scopes permit numbered transfer; unknown/running scopes prohibit writes/cleanup and allow protective Escalation. Preserve work; cleanup later uses recorded origin. |
| Acceptance/cleanup passed; field/close times out | Read back: Completed+CLOSED+COMPLETED is done; Completed+OPEN restores Pending Closure then retries; CLOSED+COMPLETED with wrong Status repairs Status only. Reuse evidence; lifecycle release follows verified pair. |

Verify referenced links/anchors and role authority remain consistent. Fixtures validate the contract, not runtime releases.

## Role Prompts

The optional [intake helper](../scripts/issue_creation.py) assembles manager requests:

```powershell
python .agents/skills/kanban-workflow/scripts/issue_creation.py create --title 'Refactor: <result>' --type refactor --body-file proposal.md
```

```text
Use kanban_manager. Triage <request> against Project #4: duplicates, priority, dependencies,
splits/resources. Add new issues in Backlog, verify records, return URLs/decisions. Start only
when requested. For board execution, assign one issue_worker per ready issue and reconcile handoffs.

Use issue_worker. Issue: <URL>. Own current stage through closure/escalation; verify claim,
worktree/gates; delegate slices, integrate evidence, record cleanup/closure. Return state,
PRs/revisions/checks, delivery/cleanup, and blockers.

Use submodule_worker. Issue: <URL>; repository/worktree: <absolute path>; scope: <outcome>;
stop at: <deliverable/blocker>. Preserve other owners' changes. Return commits/PRs/checks/
handoff revision; do not mutate lifecycle records or remove shared worktrees.
```
