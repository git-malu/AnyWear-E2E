# Human-Readable Issue Comments

Use these templates for new AnyWear issue comments and role handoffs. Write titles, explanations, headings, table labels, and descriptive link labels consistently in **English**. Preserve literal repository names, stage names, commands, identifiers, and source evidence. Keep the common reading order: **title -> conclusion -> state -> changes/results -> evidence -> next step**. Adapt the relevant template to the event; omit empty sections and fields that do not apply.

## Writing Rules

- Start with a descriptive event title and one short paragraph explaining the outcome, its consequence, and any action the reader needs to take. Use short paragraphs and parallel bullets instead of semicolon-separated operational dumps.
- Distinguish **current observed state**, **planned action**, and **verified result**. A pre-mutation record says “ready” or “pending verification”; call work completed only after the required read-back. When adding a result, update the opening conclusion to the latest verified outcome while preserving the earlier intent and decision evidence. Keep failed, skipped, unknown, and Not Applicable results explicit, with their implications or reasons.
- Use small tables for repository deliveries, acceptance results, state comparisons, and ownership/resource inventories. Do not pack unrelated facts into a table cell or reproduce the entire issue history.
- Use descriptive Markdown links: `[Service PR #51](https://github.com/git-malu/AnyWear-Service/pull/51)` and `[Acceptance and cleanup evidence](https://github.com/git-malu/AnyWear/issues/87#issuecomment-6055496284)`. Include repository names for cross-repository PRs. Bare comment IDs, glued identifiers such as `Transfer0`, and unformatted path/hash strings are hard to read.
- Preserve required exact revisions and identifiers in immutable linked evidence or the traceability block below. A short commit label may link to the full commit SHA; do not replace an exact revision record with an ambiguous abbreviation. Reference the existing owner claim and earlier evidence when they remain unchanged.
- Keep blockers, missing gates, authorization scope/deadlines, resumption conditions, and required human actions in the visible body. Put supporting full paths, session IDs, Project item IDs, hashes, large inventories, and raw logs behind `<details>` or evidence links. Formatting must not conceal a decision boundary or remove required evidence.
- Post when stage, decision, delivery/check evidence, ownership, dependency, resource, or blocker facts materially change. Consolidate updates for the same operation, preserve prior intent/evidence, and append the observed result with its read-back time. Unchanged polling and retries do not need new comments. Apply the templates to new comments and handoffs; leave historical comments unchanged unless the human asks to revise them.

## Progress or Stage Record

```markdown
### Progress update: <specific delivery or stage change>

<One sentence explaining the observed result and its effect on subsequent work.>

| Item | Current record |
| --- | --- |
| Current state (verified) | <Issue state / Project Status / Priority> |
| Planned transition | <Current stage -> target stage; not yet executed or awaiting read-back; omit if unchanged> |
| Owner | <Role / person; link to the existing owner claim> |

#### Changes

- <Specific work completed or a new decision made in this update.>
- <Remaining gates, failed/skipped checks, and their implications; include only relevant items.>

#### Validation and evidence

| Check or delivery | Result | Evidence |
| --- | --- | --- |
| <Repository / check name> | <Passed, failed, pending verification, or N/A with reason> | <Descriptive PR / Actions / comment link> |

#### Next step

<Who will do what, and what remains before the next stage. After execution, append the observed state and read-back time to this record.>
```

## Delivery or Dependency Handoff

```markdown
### Delivery handoff: <deliverable or A -> B dependency>

<Explain what was published, whether the agreed release condition is satisfied, and who takes the next step.>

| Item | Current record |
| --- | --- |
| Producer / consumer | <Owner or issue links> |
| Dependency type and release condition | <Artifact release or Lifecycle dependency; the agreed condition> |
| Release result (verified) | <Available and native blocker removed / condition not yet satisfied with reason> |
| Consumer acceptance | <Awaiting pin / awaiting validation / passed; record separately from producer publication> |

#### Delivery and validation

| Repository or artifact | Pinned revision | Validation result | Evidence |
| --- | --- | --- | --- |
| <Service / API / documentation> | <Link to full SHA or immutable artifact> | <Producer checks> | <PR / Actions / artifact link> |

#### Next step and boundaries

- <Which input the consumer must pin and which validation to run.>
- <For a release: visibly state the environment, compatibility, order, and recovery conditions; link the full intended/observed revision tuple.>
- <Acceptance or release conditions that this handoff does not satisfy.>
```

## Escalation or Recovery Record

```markdown
### Escalation or recovery: <specific blocker or recovery task>

<Explain what happened, its impact, and which work is suspended or may continue.>

| Item | Current record |
| --- | --- |
| Current state / resumption stage | <Issue state / Project Status; the previous resumption stage> |
| Owner | <Current owner claim; add the new owner / Transfer only for an authorized transfer> |
| Completed / remaining work | <Partial results; specify missing operations and unknown state> |
| Writer / job / resource state | <Stopped / finished / running / unknown; link cessation evidence> |

#### Decision and authorization boundaries

- <Suspension, recovery, or authorized action; link its basis.>
- <The specific repositories, paths, resources, and authorization expiry, where applicable.>
- <Unknown or active scopes, artifacts to preserve, and boundaries that recovery must not cross.>

#### Evidence

<Use descriptive links for partial execution results, cessation evidence, preserved artifacts, and authorization records. Put detailed inventories/logs in traceability information.>

#### Resumption conditions and next step

<Who resolves which specific gap, and which conditions allow resumption. Retry only the steps that remain incomplete.>
```

## Closure Record

Before close mutations, use **Closure preparation** and state that read-back is pending. After successful joint read-back, update the title and opening conclusion to **Closure completed**, and append an explicit **Closure result (verified)** section and the read-back time to the same operation record. Preserve the earlier preparation, authorization, and evidence with their original context. If a mutation partially fails, report the observed mismatch and recovery action instead of a success conclusion.

```markdown
### Closure preparation: <the issue's concrete outcome>

<Briefly state that acceptance, delivery, and cleanup have passed and closure is ready; final Project and Issue state changes and read-back remain pending.>

| Item | Current state (verified) | Planned target |
| --- | --- | --- |
| Project Status | <Pending Closure or another observed value> | Completed |
| Issue state / close reason | <OPEN / no close reason, or other observed values> | CLOSED / COMPLETED |
| Priority / archive state | <Observed values> | <Expected values> |

#### Acceptance and delivery

| Acceptance item or repository | Verified result | Evidence |
| --- | --- | --- |
| <Acceptance boundary> | <Concrete behavior or delivery result> | <Acceptance record / PR / pinned revision link> |
| <Applicable checks> | <Check results; distinguish local/mock/source from live/deployed evidence> | <Corresponding Actions / report link> |
| Deployment / full system E2E | <Passed, or N/A with its accepted reason> | <Applicability decision / environment and revision evidence> |

#### Cleanup and reconciliation

- <Worktrees / branches / resources actually removed or released; needed artifacts preserved; link the full results.>
- <Producer release obligations, affected repositories/pins, and dependencies reconciled; do not claim success while relevant unknowns remain.>

#### Limitations and follow-up

<Material validation limits, deferred scope, or independent gates owned by other issues; link their records. Omit if none apply.>

#### Next step

<The assigned owner sets Project Completed, closes the Issue as completed, and jointly reads back both records. On partial failure, repair only the missing steps.>

<!-- Append the following section only after successful mutations and joint read-back. -->
#### Closure result (verified)

<Read-back time>: Project **Completed**; Issue **CLOSED / COMPLETED**; Priority <observed value>; archive state <observed value>.
<Link to the result; identify the owner and follow-up issue for any remaining work.>
```

## Traceability Block

Append only the fields required for this event. The initial claim still records owner/session, UTC time, assigning authority, numbered transfer, worktree origin/absolute path, branches/Git writers, and resource/deployment writers. Later comments can link that claim. Release, deployed qualification, and cleanup still preserve their required exact inputs, commands/results, hashes, inventories, and observed state; folding these details does not weaken those gates.

```markdown
<details>
<summary>Traceability: operation identifiers, exact revisions, and raw evidence</summary>

| Field | Record |
| --- | --- |
| Operation | `<Unique operation key; reuse on retries>` |
| Record / read-back time | `<UTC times; identify what each timestamp represents>` |
| Owner claim / authorization | <Descriptive comment links; include full identity and scope fields for the initial claim> |
| Session / Transfer | `<Full values only for the initial record or a change>` |
| Worktree / writer / resources | <Git or platform origin, absolute path, branches and writers; or existing claim/cleanup record links> |
| Exact revisions | <Full Client / Service / E2E / Meta / API SHAs or immutable evidence links; distinguish intended and observed deployment inputs> |
| Project item / operation result | `<Required exact IDs, observed state, or partial-failure records>` |
| Raw evidence | <Full paths/permanent links, SHA256 values, command results, and inventories; use fenced code blocks or links for long logs> |

</details>
```
