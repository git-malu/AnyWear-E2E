# Account reconcile runbook

The `reconcile` operation of the protected `beta-qualification.yml` entry bounds E2E leftover
data by time instead of by an operator (#217). It runs as a job before every `qualify` suite
and daily through `reconcile-schedule.yml`, which dispatches `operation=reconcile` with
`trigger=scheduled` through the same protected `workflow_dispatch` entry: the execution guard
requires that event, so a `schedule` event on the qualify entry would fail closed.

There is no manual repair step and no attempt or predecessor chain to supply. A teardown that
cannot prove deletion records the identity `retained` with a reason and a `reconcileBy` bound
(24 hours after the retention write), fails its own run exactly as before, and is resolved by
this operation.

## What the operation reads

Both sources are read over the same seven-day window, and the window is recorded in the
result.

- **Lifecycle manifests** — the recent `beta-account-lifecycle-<run>-<attempt>` and
  `beta-smoke-account-lifecycle-<run>-<attempt>` artifacts, `account-budget.json` each. A
  manifest entry is authoritative for its address and captured subject. Every non-`deleted`
  worker record is a leftover: `reserved`, `provisioning`, `in_use` and `cleanup_pending` mean
  the teardown never proved absence, and `retained` (or a historical `quarantined`) means it
  ran and failed. The latest record for an address wins, because a stable pool address is
  reused: a later `deleted` record proves the address was resolved after the older record was
  written.
- **CloudTrail `AdminCreateUser`** — the Beta pool creations in the window. A creation inside a
  manifest record's own lifetime belongs to that record. A creation outside every window has
  no manifest entry: only an address in the scoped historical grammar
  (`e2e-beta-<runScope>-<slot>-<8hex>@anywear.local`) proves it synthetic then — it carries its
  own run scope, so its `sub` is read back with `AdminGetUser` and it becomes a reconcile
  identity. A **stable allowlist row** (`e2e-beta-worker-<n>-chromium@anywear.local`) is an
  address a human tester can hold too, so it is reconciled only when a manifest captures its
  subject, and is otherwise reported as `unprovable_ownership` and never deleted. A creation
  whose caller is not the E2E qualification role is reported as `unattributable_caller` and
  **never deleted**.

## What the operation does per identity

1. Read the identity from Cognito (`AdminGetUser`). An absent identity whose manifest carries a
   subject still replays the Service cleanup, because the rows and objects may remain; an
   absent identity with no captured subject is `already_absent`, exit 0, with no request.
2. Verify the address and the captured subject. A mismatch, a missing immutable username or an
   unprovable address is reported and never deleted.
3. Submit the existing exact-reference Service cleanup in **normal** mode
   (`{runScope, users:[{sub,email}]}`, at most eight users), grouped by the captured run scope.
   The Service deletes the captured users' rows, then their `wearable-items/<sub>/` and
   `base-photos/<sub>/` objects, and commits `objects` and `objectsMissing`. Both counters are
   required: a Service release without them cannot prove the object phase, and the identity
   stays `retained` rather than being reported clean.
4. Delete the Cognito identity by its immutable username — never by address — then read absence
   back. Only `UserNotFoundException` on a fresh read makes it `reconciled`.

## The record

`reconcile/account-reconcile.json` is uploaded as
`beta-account-reconcile-<run>-<attempt>`. It is the `anywear_e2e_account_reconcile` v1 record
and the durable audit trail — the artifacts it was built from expire, the record does not.

```json
{
  "schema_version": 1,
  "record_type": "anywear_e2e_account_reconcile",
  "reconcile_id": "<dispatch run>-<attempt>",
  "window": { "from": "2026-10-16T00:00:00.000Z", "to": "2026-10-23T00:00:00.000Z" },
  "sources": { "artifacts": 12, "cloudtrail_events": 34 },
  "identities": [
    {
      "email": "e2e-beta-<scope>-0-<hash>@anywear.local",
      "subject": "<captured or read-back sub>",
      "origin": { "kind": "manifest", "run": 123, "attempt": 1 },
      "actions": { "service_cleanup": "committed", "cognito": "deleted", "objects": "deleted", "readback": "absent" },
      "outcome": "reconciled"
    }
  ],
  "unresolved": [],
  "result": "passed"
}
```

- `origin` is `{kind: manifest, run, attempt}` or
  `{kind: cloudtrail, event_id, event_time}`. `subject` is `null` only for an absent orphan
  whose subject could not be read back.
- `actions.service_cleanup` is `committed`, `refused`, `unavailable` or `not_required`;
  `actions.cognito` is `deleted`, `already_absent`, `refused` or `not_attempted`;
  `actions.objects` is `deleted`, `absent`, `none`, `unavailable` or `not_required`;
  `actions.readback` is `absent`, `present`, `unreadable` or `not_attempted`.
- `outcome` is `reconciled`, `already_absent` or `retained`.
- `unresolved[]` entries carry `{email, reason, origin}` and, for a foreign caller, `caller`.
  Reasons: `cognito_delete_refused`, `cognito_readback_failed`, `deadline_exceeded`,
  `object_cleanup_unproven`, `service_cleanup_refused`, `service_cleanup_unavailable`,
  `subject_mismatch`, `unattributable_caller`, `unprovable_ownership`.

## Result and failure

`result` is `passed` when every leftover was resolved or is still inside its `reconcileBy`
bound, and `failed` when a leftover is past its bound. A failed run emits one error annotation
per unresolved identity naming its address, its reason and the original run (or CloudTrail
event), so the alert carries the attribution:

```text
::error title=Unresolved E2E leftover::e2e-beta-worker-3-chromium@anywear.local (service_cleanup_refused) from run 123 attempt 1
```

The job fails closed without deleting when the artifact list or CloudTrail is unavailable, and
it stops starting new work after 720 seconds so an in-flight cleanup can finish and the record
is still written. The job itself is bounded to 15 minutes.

A `full` run whose own cleanup is not verified still withholds the qualification record: the
teardown gate is unchanged, and a deferred cleanup is never evidence of a verified one.

## Relationship to `recover`

`recover` and its six dispatch inputs, `account-recovery-inputs.mjs`, the frozen cleanup
diagnostic (`beta-cleanup-diagnostic.mjs`) and the retained diagnostic tuple are removed in the
stacked #217 pull request once this operation has been delivered. Their runbook is
[account-recovery.md](account-recovery.md) until that removal lands. `reconcile` needs none of
them: it reads the manifests and CloudTrail, not a pinned historical evidence artifact.
