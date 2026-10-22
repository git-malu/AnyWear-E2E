# Account recovery runbook

The `recover` operation of the protected `beta-qualification.yml` entry restores one captured E2E run's exact account scope. It re-runs the deterministic Service cleanup operation, deletes only the captured Cognito identities after the Service proves a committed cleanup, and reads their absence back. It never produces or withholds a qualification record.

## Preconditions

- The original run is a completed `workflow_dispatch` on `main` of `.github/workflows/beta-qualification.yml`, or a historical `integration.yml` original a retained artifact still binds. Its exact `beta-account-lifecycle-<run>-<attempt>` artifact exists uniquely and is unexpired.
- The retained `account-budget.json` binds that exact run and attempt, and every identity recovery may touch is captured there with its subject and address.
- A validated Beta cleanup diagnostic record exists for the currently deployed cleanup tuple: state-machine version ARN, Service source commit and Service image digest. The diagnostic record matches the currently deployed cleanup tuple.
- The dispatch runs from `main` in the `beta` environment, with the repository variable `ENABLE_BETA_MUTATION` set to `true` and the dedicated `beta-e2e-qualification-role` principal.
- The Beta environment writer is released to this dispatch: verify every local, Actions, CloudFormation, ECS and nested Service job has ceased and record the post-state. A timeout never releases the writer.

## Dispatch

```text
gh workflow run beta-qualification.yml --repo git-malu/AnyWear-E2E --ref main \
  -f operation=recover \
  -f source_run_id=<failed run id> \
  -f source_run_attempt=<attempt>
```

- `operation` is required. `recover` is the only operation that accepts `source_run_id` and `source_run_attempt`. `worker_slot_offset` is unused by recovery; leave its default.
- The replay inputs removed with the single-rule consolidation (`operation_mode`, `recovery_attempt`, `previous_recovery_run_id`, `previous_recovery_run_attempt`, `retry_failed_execution`) are not dispatch inputs. The preflight refuses a stale dispatch that still supplies one.
- One dispatch recovers one captured scope. There is no predecessor artifact, attempt sequence or execution-history hash to supply: the entry point resolves the deterministic execution name for the captured scope, resumes a running execution, verifies a succeeded one, and only after a terminal non-success performs the bounded predecessor check before the one retry name.

## Quarantine repair

A quarantined worker record is terminal only while its ownership cannot be proven.

- The record must carry a captured UUID-shaped subject and an address in its own run scope. `prepareAccountRecovery` then normalizes it to `cleanup_pending`, and `createServiceCleanupInputs` admits it to the same request as an ordinary pending record.
- The repair uses the same reviewed capability tuple, the same Service commit proof (`proof_status: verified`) before any identity deletion, and the same subject-verified absence readback.
- On success the ledger record becomes `deleted` and keeps its original quarantine `reason`, which is the trace of the teardown defect that produced it.
- A record whose subject is missing or malformed, or a repair the Service refuses or that cannot prove its result, stays `quarantined`, keeps its reason and fails the step. Unproven ownership is never admitted.
- The run that produced the quarantine keeps its failed teardown gate; a repair does not rewrite that run's product or teardown result.

## Refusals

The dispatch refuses before any AWS credential when:

- the operation or input scope is wrong: a stale replay input, or recovery inputs on a non-`recover` operation;
- the original run is not a completed trusted `main` dispatch, or the manifest does not bind that exact run and attempt;
- the exact lifecycle artifact is missing, duplicated, expired, or its digest does not match the downloaded bytes;
- no captured worker request can be built, or an evidence-bearing artifact's operation does not match the canonical request;
- the diagnostic tuple is unavailable or does not bind the deployed cleanup.

A refusal writes `account-recovery-failure.json` with `phase: owner_preflight`, `proof_status: refused` and `identities_retained: true`, and leaves every identity in place.

## Budget interaction

The recovered run's `E2E_WORKERS`, `E2E_MAX_ACTIVE_ACCOUNTS`, `E2E_MAX_NEW_ACCOUNTS_PER_RUN` and `E2E_MAX_QUARANTINED_ACCOUNTS` come from the retained manifest, not from the workflow defaults for a fresh qualification run. A quarantine consumes a slot in the run that produced it; a later run has its own manifest, its own budget and a fresh worker address.

## Artifact

`beta-account-recovery-<run>-<attempt>` contains:

- `account-budget.json` — the recovered manifest, with each repaired record `deleted` and its original `reason` preserved;
- `service-cleanup-operation.json` — schema 3 operation evidence with the committed `proof_status`, the execution identity and the request binding;
- `beta-cleanup-diagnostic.json` — the validated capability tuple the cleanup was bound to;
- `original-account-budget.json`, `original-owner.json`, and `original-service-cleanup-operation.json` / `original-service-cleanup-run.json` when the original carried them — the retained origin evidence;
- `account-recovery-failure.json` — only when the run refused or failed.

The recover job's final gate fails the run unless every account in `account-budget.json` is `deleted`.
