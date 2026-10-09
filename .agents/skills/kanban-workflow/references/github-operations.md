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
<checks, justified N/A gates, deployment triggers/compatibility/recovery, architecture references>
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

## PR Associations

The issue worker links each published delivery PR through the AnyWear Issue's **Development** sidebar: select the PR's repository, select the PR, and apply. This supports PRs from affected repositories. Use `gh` for supported operations; use the GitHub UI when native linking is not exposed by the CLI/API. Read back the Development association after linking; an ordinary URL or `Refs` mention alone is not a native association. Keep PR/check/deployment links in evidence comments as well.

The repository auto-close setting documented in the main skill allows these associations without closing the Issue on merge. Preserve manual closure after all applicable gates and cleanup. See GitHub's [PR linking instructions](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) and [auto-close setting](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-auto-closing-issues).

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

For each transition: read current scope, evidence, authorized claim/transfer, relations, and state; append an identifiable operation comment using the [comment templates](comment-templates.md); mutate intended records; read back and correct mismatches before advancing. Append the observed result and read-back time to the same operation comment while preserving the original intent and decision evidence. After interruption, reuse that comment and retry only missing steps. Do not duplicate evidence, worktrees, or workers.

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

## Beta Lifecycle Operations

Apply the main skill's [Beta lifecycle authority](../SKILL.md#beta-lifecycle-authority). Only the active manager changes Beta controls; workers report availability needs and preserve the current switch state. Inspect current `main` workflow definitions, automatic deploy triggers, recovery paths, live gate/environment variables, and recorded user start approval before taking the environment writer window.

```powershell
gh api repos/git-malu/AnyWear-Service/actions/variables/ENABLE_BETA_DEPLOY --jq '{name,value}'
gh api repos/git-malu/AnyWear-Service/environments/beta/variables
gh api 'repos/git-malu/AnyWear-Service/contents/.github/workflows/beta-lifecycle.yml?ref=main' -H 'Accept: application/vnd.github.raw+json'
```

The manual dispatcher is `beta-lifecycle.yml` in `git-malu/AnyWear-Service` on `main`, with `action=stop` or `action=start`. Both actions currently require `ENABLE_BETA_DEPLOY=true`. Setting this variable to `true` opens activation paths and needs explicit user start consent; a disabled gate is not proof of stopped AWS resources and must not be flipped by a worker to unblock tests or shutdown. The current stop pipeline calls `beta-lifecycle-stop.yml`, which can invoke `beta-lifecycle-recovery.yml` after partial failure and restore network/workload, with no verified stop-only mode. Inspect this complete dispatch graph: autonomous stop permission does not implicitly authorize that reactivation. Defer this pipeline without consent explicitly covering recovery activation or a verified stop-only implementation.

For an authorized shutdown, the manager verifies no conflicting worker, deployment, E2E, cleanup, or external resource user remains, rechecks board/resource state before dispatch, and retains the writer window through actual stop read-back and disabling later automatic activation. Where the heartbeat is used, follow its [idle shutdown conditions](../../kanban-manager-heartbeat/SKILL.md#stop-beta-when-the-board-is-idle). Record the run ID/URL, gate changes, target AWS account/region, observed resource state, and any start/recovery approval source. A lost dispatch response requires inspecting existing runs before retry; a green/skipped job alone is not stop evidence. On partial failure, preserve evidence and get the required approval before any recovery that would reactivate Beta.

After verified shutdown, the manager can disable the gate to prevent unattended redeployment; read back the value. Do not disable it before a stop that requires the gate. Before later activation, obtain or verify explicit user consent covering that start/window, have the manager enable the gate and dispatch start, then verify actual readiness before releasing authorized deployment/E2E work. A worker's assigned issue or writer window does not permit lifecycle control. Use `aws` only with a verified Beta account/profile/region; this procedure grants no Production authority.

## Evidence Comments

Use the [human-readable comment templates](comment-templates.md) for progress/stage records, delivery/dependency handoffs, escalation/recovery, and closure. Write these records consistently in English. Lead with the outcome and what the reader needs to do; use headings, short paragraphs, lists, and comparison tables. Record only changed facts and decision evidence; link earlier records for unchanged facts. Give links descriptive labels, such as `Service PR #51` or `Acceptance and cleanup evidence`, instead of bare numeric comment IDs.

Keep operation keys, full revisions, session/transfer identifiers, worktree inventories, hashes, and raw logs in a collapsed traceability section or linked evidence. Keep blockers, authorization scope/deadlines, missing gates, and required human actions visible. The templates change presentation, not the evidence required by ownership, release, recovery, and closure gates. A planned state transition is not a verified result; add the actual read-back before calling it complete.

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

Inspect fields, views, and automations. Preserve existing IDs; use the skill's exact Status options and native fields, re-reading affected cards. Keep an issue-only primary board grouped by Status/ordered by Priority, with PR evidence in a separate view. Keep repository auto-closing disabled; disable or adjust Project item-close, PR-link/merge, and archive automations that can complete issues prematurely. Native Development associations are allowed and do not replace lifecycle gates. Use configuration UI when API/CLI visibility is insufficient; absence from an API response proves nothing about a trigger.

Historical migration provenance and canonical identities remain in [the immutable migration map](https://github.com/git-malu/AnyWear-Meta/blob/0ff69d4043ec8ec99610249605e2da20d3adb83a/records/kanban-migration/migration-map.json). Historical completion must not be described as newly verified acceptance/cleanup.

## Workflow Simulation Checks

Dry-run these fixtures without creating issues, deploying, terminating processes, or removing worktrees. Unknown scopes require preservation and escalation.

| Fixture | Required result |
| --- | --- |
| Intake timeout finds issue without Project membership | Reuse it; finish Backlog/Priority/relations and read back; return URL without implementation/worktree. |
| Service auto-deploys Beta; Client is manual; producer artifact ready | Check old-consumer compatibility before merge; release artifact blocker; consumer pins/validates afterward. Lifecycle variant waits for Completed pair. Qualify actual runtime pair. |
| Delivery PR is linked in Development and merged; acceptance/cleanup is pending | Record delivery evidence; keep the Issue open at its applicable stage. Native association/merge does not authorize Completed or closure. |
| Analysis is ready to exit after design and gate review | Record an actionable next-stage plan in the Issue or linked artifact: ordered actions, responsible role/repository, dependencies/release conditions, and expected validation/evidence. Keep the plan current when findings change. |
| A progress/stage comment reports new work or a stage change | State the current overall completion percentage and its basis against the defined acceptance criteria/work items; do not infer progress from elapsed time or claim 100% before applicable closure gates pass. |
| Dense closure history must be presented to a human; close read-back is still pending | Use the closure template with a clear readiness conclusion, visible pending read-back, descriptive evidence links, and preserved exact revisions/operation/ownership details. Do not label the Issue completed or omit material limitations. |
| Owner/child disappears with ignored report/unpushed API commit | Verified stopped scopes permit numbered transfer; unknown/running scopes prohibit writes/cleanup and allow protective Escalation. Preserve work; cleanup later uses recorded origin. |
| Acceptance/cleanup passed; field/close times out | Read back: Completed+CLOSED+COMPLETED is done; Completed+OPEN restores Pending Closure then retries; CLOSED+COMPLETED with wrong Status repairs Status only. Reuse evidence; lifecycle release follows verified pair. |
| Idle Beta has no conflicting users; selected stop path cannot reactivate Beta | Manager may stop without renewed user approval, verify actual stop, and disable automatic activation paths. Workers leave controls unchanged. |
| Beta is stopped; an authorized issue needs E2E but no explicit start consent exists | Continue independent preparation; request user start consent through the manager. Do not enable the gate, dispatch start, or use a deploying merge/recovery to activate Beta. |
| A worker holds a Beta writer window or the manager is unavailable | Worker may inspect/report state but cannot change ENABLE_BETA_DEPLOY or invoke start/stop. Preserve the environment and request the manager decision. |
| Stop dispatch is gated off or its partial-failure recovery can restore Beta | Manager inspects the full graph and reports the concrete blocker; no worker gate flip or implicit recovery-start approval. Use a verified stop-only path or explicit user consent covering activation before a pipeline that may reactivate Beta. |
| Recorded user consent explicitly covers the intended Beta start/window | Manager verifies the consent's scope, enables/starts Beta, reads back readiness, and releases authorized work. Workers do not mutate lifecycle controls. |
| Platform is active but Workload is stopped, or Beta state is unknown | Preserve state and require the manager's activation decision/user approval before any deployment or recovery that may create active resources; checking only Platform is insufficient. |

Verify referenced links/anchors and role authority remain consistent. Fixtures validate the contract, not runtime releases.

## Role Prompts

All roles use the [comment templates](comment-templates.md) for issue comments and handoff reports; ownership and stopping conditions remain role-specific.

The optional [intake helper](../scripts/issue_creation.py) assembles manager requests:

```powershell
python .agents/skills/kanban-workflow/scripts/issue_creation.py create --title 'Refactor: <result>' --type refactor --body-file proposal.md
```

```text
Use kanban_manager. Triage <request> against Project #4: duplicates, priority, dependencies,
splits/resources. Add new issues in Backlog, verify records, return URLs/decisions. Start only
when requested. For board execution, assign one issue_worker per ready issue and reconcile handoffs.

Use issue_worker. Issue: <URL>. Own current stage through closure/escalation; verify claim,
worktree/gates; delegate slices, link delivery PRs in Development, integrate evidence,
record cleanup/closure. Return state,
PRs/revisions/checks, delivery/cleanup, and blockers.

Use submodule_worker. Issue: <URL>; repository/worktree: <absolute path>; scope: <outcome>;
stop at: <deliverable/blocker>. Preserve other owners' changes. Return commits/PRs/checks/
handoff revision; do not mutate lifecycle records or remove shared worktrees.
```
