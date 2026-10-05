# AnyWear E2E

System-level tests for a reviewed combination of `AnyWear-Client` and
`AnyWear-Service`. This repository owns only behavior that crosses deployable
boundaries; repository-local tests remain with the Client or Service.

## Test Boundary

- Browser behavior with mocked APIs belongs in `AnyWear-Client`.
- Route, database, contract, and infrastructure tests belong in `AnyWear-Service`.
- Browser flows that use both the real Client and Service belong here.
- Real cloud smoke tests belong here and must be explicitly tagged.

## Prerequisites

- Node.js 24
- pnpm 11.18.0
- AWS credentials for the Beta test identity boundary
- Deployed Beta Client and Service endpoints with HTTPS

The preferred local layout is the AnyWear shell repository:

```text
AnyWear/
|-- AnyWear-Client/
|-- AnyWear-Service/
|-- AnyWear-Meta/
`-- AnyWear-E2E/
```

## Setup

Install dependencies from this repository:

```bash
pnpm install --frozen-lockfile
```

Configure the ignored `.env` from `.env.example` with `E2E_STAGE=beta`,
`E2E_EXTERNAL_SERVERS=true`, the deployed `E2E_CLIENT_URL` and `E2E_SERVICE_URL`,
and Beta's Cognito IDs. The deployment workflows load the identity IDs from
`/anywear/beta/cognito_user_pool_id` and `/anywear/beta/cognito_client_id` in SSM.
Do not commit `.env` or Playwright authentication state.

The deployed qualification profile sets two workers, two active-account slots, four new
accounts per run, and two quarantine slots. Wardrobe tests use one exclusive synthetic
Cognito account per Playwright parallel slot, provisioned through the protected AWS admin
path and deleted during worker teardown. Public registration is qualified separately by the
controlled Beta allowlist suite; ordinary qualification does not require a real mailbox.
The qualification and integration workflows share a non-cancelling Beta account-pool
concurrency group, and each run uploads its account-budget manifest for recovery.

## Commands

```bash
pnpm check             # source checks, script tests, and Playwright test discovery; no browser execution
pnpm audit             # fail on high/critical dependency advisories
pnpm test:smoke        # on-demand deployed Beta diagnostic
pnpm test:full-stack   # deployed Beta scenarios marked @full-stack
pnpm test              # complete deployed Beta qualification suite
pnpm report            # open the latest HTML report
```

Playwright verifies the configured deployed stage endpoints. Browser execution fails
closed unless the stage is Beta or Production, external servers are selected, and both URLs use
HTTPS. Test discovery and source checks do not connect to the deployed environment.

## Execution Policy

Pull requests do not run cross-repository browser E2E as a required check. The E2E
Quality workflow runs compatibility validation, script tests, lint, type checking, and
Playwright test discovery. Client and Service workflows remain responsible for their
required unit, repository integration, contract, database, and browser integration tests.

The E2E Integration workflow is an on-demand deployed Beta smoke diagnostic and runs
only the small `@smoke` subset. It checks out the reviewed peer commits for diagnostic
revision evidence, verifies their deployed identities, and exercises Beta's real
identity boundary. It does not run a local database or mutate the deployment.
Only Beta Qualification can issue a passing qualification record.

The complete `pnpm test` suite is reserved for the deployed Beta Qualification workflow.
Only a passing run against the exact reviewed Client, Service, and E2E revisions produces
qualification evidence that Production may consume.

Test classification is explicit: `@smoke` marks the small, stable critical path for the
on-demand Beta diagnostic; `@full-stack` marks cross-repository scenarios. Beta
Qualification runs every discovered test, regardless of tag. Dev verification remains
in the Client and Service unit and integration suites.

The manual `Beta Qualification` workflow is the production-readiness gate for an
already-deployed Beta environment. It reads the reviewed full SHAs from
`compatibility.json`, verifies those identities against the deployed Client
`build-metadata.json` and Service `/health`, runs the complete suite, rechecks both
identities and the Service image digest, and uploads a checksummed qualification record.
A failed, mismatched, or changed deployment cannot issue a passing record. The workflow
requests 90-day artifact retention, subject to GitHub's configured
repository or organization ceiling; durable release-ledger storage remains
out of scope for the initial Production launch. The finite GitHub retention window is an
accepted trade-off: after the artifact expires, that qualification can no longer authorize a
new Production deployment or rollback and the candidate must be qualified again. Persistent
S3 evidence storage will be reconsidered only if long-term audit or rollback requirements arise.

## Runtime Reliability Evidence

### Private Tester Acceptance

The Service repository's protected `Beta Allowlist Acceptance` workflow owns the
`anywear-beta-runtime` lock and runs `playwright.allowlist.config.ts` against the
exact deployed compatibility set. This controlled scenario is excluded from the
ordinary qualification suite because it temporarily edits the private tester list
and admission suspension. It never opens public intake and restores the original
policy in test teardown and an unconditional workflow cleanup step.

The scenario uses unique `e2e-beta-allowlist-...@anywear.local` identities. It proves
that registration remains unconfirmed, an invalid confirmation code cannot sign
in, a verified tester can sign in through the real Client and finish an auto-tag
task, and revoked or suspended testers cannot create auto-tag or VTO tasks while
existing profiles, results, and credits remain readable. Cognito admin commands
explicitly verify and confirm only these synthetic accounts; this is not evidence
of mailbox delivery. The cleanup helper rejects active work before removing owned
database records, and the scenario then deletes only captured exact S3 keys and
synthetic Cognito users. Failed cleanup leaves a retryable runner-local snapshot;
that snapshot contains the original tester list and must never be uploaded.
The controlled configuration uses text reporters and disables browser recordings;
HTML step metadata can contain entered passwords or temporary S3 grants. Uploaded
`beta-allowlist-acceptance.json` and `beta-allowlist-recovery.json` contain only
assertion outcomes, revisions, and exact synthetic resource identifiers. The
recovery manifest excludes passwords, bearer tokens, signed URLs, and the original
tester list. A failed run's retained resources must be inspected until its task is
terminal, then cleaned through the pinned Beta cleanup helper before deleting the
manifest's exact S3 keys and Cognito identities.
The protected Service recovery workflow invokes
`node tests/support/beta-allowlist-recovery.ts --recover-manifest` with the exact
manifest in `BETA_ALLOWLIST_RECOVERY_JSON`. Its revision and digest must match the
currently ready Beta Service and pinned operator checkout; after a runtime repair,
update only those deployment fields to the newly verified revision. The recovery
entry point verifies the deployed Cognito pool, bucket, ownership paths, paused
admission, and unchanged policy before and after cleanup. It never configures or
opens admission.

This workflow produces focused allowlist acceptance evidence. It does not issue
the complete Beta qualification record or satisfy the runtime fault drills below.

The wardrobe scenario verifies repeated `Idempotency-Key` confirmation before and after
completion, recovery after a browser reload, consistent terminal state in two browser
pages, and a monotonic state version. It requires a successful `ready` state, so a
provider failure cannot pass merely because the processing indicator disappears.

Live Beta qualification still needs controlled drills for accepted tasks across API and
worker restarts or rolling deployments; SSE status delivery across identified distinct
API replicas; lease renewal and visibility expiry; provider retries and dead-letter
delivery; and exact current-state replay. Auto-tagging credit settlement is not applicable. Two browser
pages do not prove that requests reached different replicas. Record ECS task identities,
queue/DLQ observations and task state versions with those drills.

The E2E repository now provides a bounded, read-only preflight and an evidence verifier for
these drills. Preflight can run while Beta intake is closed; it reports the gate state and
does not open registration or accept tasks. Task-bearing drills require an approved Beta
private-only test window with `intake_open=false`. These tools are deliberately separate from `pnpm test` and
never run in Dev:

```bash
pnpm runtime:plan                 # writes runtime-drill-plan.json; no AWS calls
pnpm runtime:preflight            # reads Beta health, stacks, ECS services, and queue attributes
pnpm runtime:verify -- evidence.json
```

Set `E2E_STAGE=beta`, `AWS_ACCOUNT_ID=650880818323`, `AWS_REGION=ap-east-1`, and both
HTTPS endpoint variables before either AWS-backed command. Preflight fails closed when the
deployed Client/Service identities do not match `compatibility.json`. It does not restart
tasks, publish SQS messages, consume queue messages, change desired counts, or touch the
database. The generated plan describes the operator-approved mutations and requires the
unique `RUNTIME_DRILL_CONFIRM=beta-runtime-drill` marker before any future executor is
allowed to perform them.

The non-paid executor and restore-only recovery workflow are source checkpoints, locked
by `LIVE_RUNTIME_SOURCE_READY=false`. Neither has collected Beta runtime evidence. A
window owner must suspend dynamic scale-in, scale-out, and scheduled scaling for both
services before execution; the executor captures and checks these settings, but never
changes them. It closes private admission before worker replacement and admits only the
single run-owned synthetic tester after selecting the loopback fixture. Workers retain
their original IAM roles and network access; this is not IAM or network isolation.

Schema 2 evidence requires a passed accepted-task restart/rolling drill, raw two-replica
request attribution and matching terminal observers, and a retry/visibility/DLQ observation
with successful lease/visibility renewal and canonical worker receive counts. Two pinned
read-only DB audits must retain identical terminal snapshots for 440000ms. This finite
window proves neither historical uniqueness nor late stale-worker rejection or missed
heartbeats. Same-token StopTask completion is graceful drain; only a greater token is
takeover. Actual passing DB-enabled Service main CI at the deployed SHA supplies the
separate post-provider fencing assertions. Auto-tagging credit is explicitly N/A. A
rollback observation is optional in the record until a prior Beta WorkloadStack digest is
available. Provider-failure injection and database task-row inspection remain operational
requirements; the fixture sidecar uses only loopback, a dummy provider key, and no paid
provider forwarding. Exact run/user ownership, helper commands and task definitions,
baseline private-policy restoration, and committed cleanup logs are mandatory.

`Beta Runtime Recovery` selects one immutable recovery snapshot by source run, attempt,
snapshot number, and original run scope. It shares the protected Beta environment and
`anywear-beta-runtime` concurrency lock. It only reconciles and restores captured state;
it does not start a drill. Recovery rechecks actual helper tasks and their exact logs,
never trusting saved completion booleans. An irreversible known-DLQ deletion without a
committed DB cleanup record is not success. Only its exact original helper deletion
marker authorizes omitting that known message on a DB-cleanup retry; a separate committed
cleanup record is still required. Missing or foreign evidence fails closed. Recovery
snapshots contain baseline policy values and must remain restricted artifacts; they
exclude passwords, bearer tokens, and signed URLs. Runner-loss snapshots are uploaded
before subsequent mutations, not only by the final `always()` step.

Every durable save uploads an immutable three-digit snapshot (`001` through `400`).
At the shared hard bound, snapshots plus the final outcome use 401 artifacts, leaving
99 slots under GitHub's 500-artifact per-job limit. Cloud-mocked production orchestration
measures 198 saves / 31 helpers for an initially unpaused baseline and 203 / 32 for a
paused baseline. Replaying the snapshot-150 interruption in a fresh recovery run needs
85 or 108 uploads respectively, with its own counter; snapshot-151 response loss needs
85 or 107. All snapshots remain parseable under the 262144-byte and 100-helper record
limits; observed maximum size is 94817 bytes.
These are source regression measurements, not Beta or timing evidence. At an assumed
5 seconds per artifact, 203 sequential uploads add about 16.9 minutes, in addition to
the 14.7-minute terminal stability waits and cloud operations. The 60-minute workflow
deadline still needs live qualification; a larger snapshot allowance does not guarantee
that deadline. Exhaustion or upload failure fails closed before subsequent mutation.

The deployed Client must serve the exact reviewed build at an HTTPS URL, support its
browser routes, and expose `/build-metadata.json`. The Client-owned Beta workflow publishes
the static build to the Beta PlatformStack's CloudFront distribution; set `BETA_CLIENT_URL`
to that stable `https://<distribution>.cloudfront.net` endpoint before qualification.

## CI Model

`compatibility.json` is the CI source of truth for the Client and Service
revisions under test. It accepts only full commit SHAs; branch and tag names are
rejected. When invoked, the E2E Integration workflow checks out those exact private
repositories, including their recursive API submodules, and records every tested
revision as an artifact.

The AnyWear shell repository remains a convenient local workspace and may pin
the same revisions, but it does not run CI or hold cross-repository credentials.
Update `compatibility.json` only after the peer commits exist on their remotes
and their repository-owned pipelines pass.
