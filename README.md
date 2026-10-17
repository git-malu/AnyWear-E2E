# AnyWear E2E

System-level tests for a reviewed combination of `AnyWear-Client` and
`AnyWear-Service`. This repository owns only behavior that crosses deployable
boundaries; repository-local tests remain with the Client or Service.

## Test Boundary

- Browser behavior with mocked APIs belongs in `AnyWear-Client`.
- Route and database tests belong in `AnyWear-Service`; CDK and infrastructure contract tests belong in `AnyWear-Infra` after the controlled ownership cutover.
- Browser flows that use both the real Client and Service belong here.
- Real cloud smoke tests belong here and must be explicitly tagged.

## Prerequisites

- Node.js 24
- pnpm 11.18.0
- AWS credentials for the Beta test identity boundary
- Deployed Beta Client and Service endpoints with HTTPS

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
path and deleted during worker teardown. Public registration remains governed by the
Service-owned tester policy; ordinary qualification does not mutate admission policy or
require a real tester mailbox.
The qualification and integration workflows share a non-cancelling Beta account-pool
concurrency group, and each run uploads its account-budget manifest for recovery.

## Commands

```bash
pnpm check             # compatibility, explicit core contracts, lint, typecheck and safe discovery
pnpm test:core         # 25 registered offline identity/cleanup/qualification/artifact contracts
pnpm test:tool-regressions # sixteen retained offline operational-support test files
pnpm test:deferred-sqs  # two source-only SQS prototype test files; manual #58 review
pnpm audit             # fail on high/critical dependency advisories
pnpm test:smoke        # on-demand deployed Beta diagnostic, @smoke only
pnpm test:regression   # the release-gating deployed selection, @regression only
pnpm test:instrumentation # a measurement workload or drill, @instrumentation only
pnpm test:full-stack   # deployed Beta scenarios marked @full-stack
pnpm test              # the release-gating selection: identical to test:regression
pnpm report            # open the latest HTML report
```

Playwright verifies the configured deployed stage endpoints. Browser execution fails
closed unless the stage is Beta or Production, external servers are selected, and both URLs use
HTTPS. Test discovery and source checks do not connect to the deployed environment.

The explicit file lists in [package.json](package.json) are the suite registry. A new
test file needs an ownership/classification decision before it enters an executed
suite; a filename wildcard cannot select a routine or release gate. The
[scenario inventory](docs/scenario-inventory.md) is that classification for the
deployed scenarios: each one's policy class, intent, selecting invocation, evidence
level, cleanup contract and red-result meaning, plus the admission rule a new
scenario must satisfy.

| Command | Owner and trigger | Actual effects and evidence |
| --- | --- | --- |
| `check` / `test:core` | E2E maintainers; PR/main Quality and source preparation in Integration/Qualification | Offline fixtures, temporary files/Git repositories, lint, typecheck and discovery; no credentials, cloud calls or deployed result |
| `test:tool-regressions` | E2E operational-tool maintainers; affected-path PR/main workflow or explicit manual dispatch | Mock AWS/Cognito/fetch, temporary files, a loopback HTTP fixture and bounded Bash checkpoint helper; no AWS/App credentials or live drill proof |
| `test:deferred-sqs` | Repository maintainer under [#58](https://github.com/git-malu/AnyWear/issues/58); manual future-protocol review only | Two offline ARM/ACK/FIRE prototype files; no live transport, trusted AWS identity or receipt proof, and no #54 acceptance claim |
| `test:smoke` | E2E maintainers; allocated on-demand Beta+ Integration | Real login/dashboard/wardrobe navigation using a bounded worker identity and existing cleanup contract; diagnostic only |
| `test:regression` / `test` | E2E maintainers; the protected Beta Qualification suite step, or explicit local investigation | The release-gating business scenarios, including identity creation and cleanup and external VLM/provider work; only this workflow and its evidence can qualify a release |
| `test:instrumentation` | E2E maintainers; explicit opt-in in the protected Beta Qualification workflow, after the qualification job | A measurement workload with paid provider spend and its own cleanup contract, reported as a measurement; it can neither satisfy nor fail release qualification |
| `test:full-stack` | E2E maintainers; explicit local investigation | Every cross-repository scenario, the measurement included; not a release-gating selection on its own |
| `runtime:plan` / `runtime:preflight` / `runtime:verify` | E2E operational-tool maintainers; explicitly selected diagnostic | Plan/evidence file operations, or authenticated read-only Beta observations for preflight; never live drill execution |

The release-gating selection and the measurement are separated by a workflow job boundary,
not by a step: the measurement runs in its own job after the qualification job, so a failing
measurement fails that job and leaves the qualification record exactly as it was. The
[scenario inventory](docs/scenario-inventory.md) states which verdict each invocation
carries.

The 25 registered core files retain account-budget, Cognito cleanup, qualification
record, cleanup operation, wardrobe cleanup, worker cleanup and deployed-scenario
declaration contracts plus the current
`infra-source.test.mjs`, `infra-qualification.test.mjs` and
`trusted-deployment-inputs.test.mjs` contracts. `test:core` also owns
`scripts/beta-cleanup-diagnostic.test.mjs`, which asserts the cleanup diagnostic's
`DIAGNOSTIC_EXPECTED` evidence record offline, without credentials, cloud calls or
deployed reads; it belongs with its `cleanup-acceptance.test.mjs`,
`service-cleanup-operation.test.mjs` and `worker-cleanup.test.mjs` neighbours, and its
production module is consumed by `scripts/account-recovery-inputs.mjs` and
`scripts/cleanup-worker-accounts.mjs`. The infra contracts protect pinned source,
committed selection, direct native release verification, deployment identity and
execution validation; their offline assertions remain required by `check` without
claiming actual publication or qualification.

The tool workflow watches the registered tests, their implementation and fixture
dependencies, shared evidence/source contracts, vendored direct-release validators and
compatibility/lockfile inputs. It has only `contents: read` and no deployment
environment or credential steps. SQS prototypes are excluded from both routine core
and tool workflows and retain their [source-only handoff](scripts/beta-sqs-boundary-handoff.md).
The accepted [testing principles](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/system-component-architecture/technical-architecture/devops/test/test_governance.md)
define the classification, cost, evidence, admission and retirement policy this
repository applies.

## Execution Policy

Pull requests do not run cross-repository browser E2E as a required check. The E2E
Quality workflow runs compatibility validation, the explicit 25 core test files, lint, type checking, and
Playwright test discovery. Client and Service workflows remain responsible for their
required unit, repository integration, contract, database, and browser integration tests.

The E2E Integration workflow is an on-demand deployed Beta smoke diagnostic and runs
only the small `@smoke` subset. It checks out the reviewed peer commits for diagnostic
revision evidence, verifies their deployed identities, and exercises Beta's real
identity boundary. It does not run a local database or mutate the deployment.
Only Beta Qualification can issue a passing qualification record.

The protected `pnpm test` suite step is reserved for the deployed Beta Qualification
workflow, and it runs the release-gating selection. Only a passing run against the exact
reviewed Client, Service, and E2E revisions
produces qualification evidence that Production may consume. The
[scenario inventory](docs/scenario-inventory.md) records which scenarios that step's
selection contains; a measurement or drill result is not part of it and carries no release
verdict in either direction.

Test classification is explicit: `@smoke` marks the small, stable critical path for the
on-demand Beta diagnostic; `@regression` marks the scenarios admitted to the
release-gating selection; `@full-stack` marks cross-repository scenarios, which every
scenario here carries; `@instrumentation` marks a measurement workload or drill, which
is admitted as measurement and cannot gate a release. A tag selects; the
[scenario inventory](docs/scenario-inventory.md) states the class and the verdict.
Dev verification remains in the Client and Service unit and integration suites.

The non-skipped `worker-smoke.spec.ts` signs in with the existing leased
`workerAccount` fixture and opens Dashboard and Wardrobe. Provisioning, budget,
protected execution, quarantine and Service/Cognito cleanup controls remain shared with
the deployed selection. `auth.spec.ts` is optional public-registration acceptance; it
skips unless `E2E_PUBLIC_REGISTRATION_OPEN=true` and cannot appear
as a passing smoke gate. No workflow opens public registration for this scenario.

The manual `Beta Qualification` workflow is the production-readiness gate for an
already-deployed Beta environment. It reads the reviewed full SHAs from
`compatibility.json`, verifies those identities against the deployed Client
`build-metadata.json` and Service `/health`, runs the release-gating deployed selection, rechecks both
identities and the Service image digest, and uploads a checksummed qualification record.
A failed, mismatched, or changed deployment, or a worker task definition that changed during
the suite, cannot issue a passing record. The workflow
requests 90-day artifact retention, subject to GitHub's configured
repository or organization ceiling; durable release-ledger storage remains
out of scope for the initial Production launch. The finite GitHub retention window is an
accepted trade-off: after the artifact expires, that qualification can no longer authorize a
new Production deployment or rollback and the candidate must be qualified again. Persistent
S3 evidence storage will be reconsidered only if long-term audit or rollback requirements arise.

## Runtime Reliability Evidence

### Tester Admission Verification (Historical)

The one-time deployed synthetic allowlist acceptance and recovery workflows were
retired after the feature's acceptance completed. Their historical evidence, including
the owner's real email-code and normal-login confirmation, is recorded in
[AnyWear issue #59](https://github.com/git-malu/AnyWear/issues/59). The ordinary
Beta Qualification workflow does not mutate tester policy or claim to verify a real
tester mailbox. Future changes to admission behavior should define only the focused
tests needed for that change; the retired deployed harness is not a standing release gate.

The wardrobe scenario verifies repeated `Idempotency-Key` confirmation before and after
completion, recovery after a browser reload, consistent terminal state in two browser
pages, and a monotonic state version. It requires a successful `ready` state, so a
provider failure cannot pass merely because the processing indicator disappears.

Expanded Beta and Production reliability drills are deferred to
[AnyWear issue #58](https://github.com/git-malu/AnyWear/issues/58); they are not current
personal closed-Beta acceptance gates and have not been passed. The manual runtime-drill
and dedicated runtime-recovery workflows were retired under
[issue #79](https://github.com/git-malu/AnyWear/issues/79). Historical Actions runs and
artifacts remain available as evidence of their actual outcomes.

The repository retains read-only planning, preflight, and evidence-verification helpers.
They are separate from `pnpm test` and do not start or restore runtime drills:

```bash
pnpm runtime:plan                 # writes runtime-drill-plan.json; no AWS calls
pnpm runtime:preflight            # reads Beta health, stacks, ECS services, and queue attributes
pnpm runtime:verify -- evidence.json
```

Set `E2E_STAGE=beta`, `AWS_ACCOUNT_ID=650880818323`, `AWS_REGION=ap-east-1`, and both
HTTPS endpoint variables before the AWS-backed preflight. It checks deployed Client and
Service identities against `compatibility.json` and performs read-only observations.
Any future expanded-release work must first select the smallest required risk-based scope
in issue #58; the historical fault-injection design is not an instruction to rerun its
full matrix or rebuild a separate control platform.

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

Update `compatibility.json` only after the peer commits exist on their remotes
and their repository-owned pipelines pass.

## Infra qualification contract v2

[ADR 0021](https://github.com/git-malu/AnyWear-Meta/blob/a8eba148cfef4c124c46010276e66e4c8c41e420/architecture/ADR/0021-shared-infrastructure-repository.md)
defines the shared infrastructure cutover. Offline source checks still accept the
existing reviewed v1 Client/Service pins. The Infra qualification, integration and
recovery workflows require v2 and remain disabled until their required writer
authorization is in place. These changes do not select a newer image or refresh current pins.

A reviewed v2 compatibility file has these additional identities:

```json
{
  "version": 2,
  "client": { "repository": "git-malu/AnyWear-Client", "sha": "<full-client-sha>" },
  "service": { "repository": "git-malu/AnyWear-Service", "sha": "<full-image-producer-sha>" },
  "infra": { "repository": "git-malu/AnyWear-Infra", "sha": "<full-infra-sha>" },
  "service_artifacts": {
    "repository": "git-malu/AnyWear-Service",
    "release_id": 1,
    "manifest_asset_id": 2,
    "manifest_sha256": "<exact-manifest-byte-sha256>"
  },
  "deployment": {
    "repository": "git-malu/AnyWear-Infra",
    "workflow_path": ".github/workflows/runtime.yml",
    "run_id": 3,
    "run_attempt": 1,
    "artifact_id": 4,
    "record_sha256": "<exact-deployment-record-byte-sha256>"
  }
}
```

The placeholders above are rejected by validation. Keep the committed
`compatibility.json` at v1 until a real post-input Infra deployment record exists.
Then run `node scripts/migrate-compatibility.mjs --deployment-record
<downloaded-deployment-record.json> --output <reviewed-v2.json>`. The migration
always reads the committed v1 file as its baseline; there is no alternate-pin
override. Prepare
`.infra-source` as a clean checkout of the record's exact Infra SHA from its
expected origin. Supply the Infra reader as `GH_TOKEN`, the Service reader as
`SERVICE_ARTIFACT_READ_TOKEN`, and a Client-only Contents read token as
`CLIENT_CONTENTS_READ_TOKEN` for remote commit checks. The command checks remote
commit availability, uniquely resolves the genuine Infra artifact for the bound
completed run attempt, hashes the exact supplied record bytes, and retrieves the
trusted deployment artifact and sealed Service manifest through the existing
reader. It validates the pinned Infra committed selection and writes a new
candidate file with exclusive creation; it never modifies `compatibility.json`,
infers any pin, dispatches workflows, or runs a suite. The candidate is suitable
for review only after the exact deployment and its record have passed these
checks. The final #54 tuple must pin the deployment record produced **after the
authorized Beta maintenance migration and restart**; a rehearsal record cannot
substitute.

The evidence reader accepts only the protected Infra `runtime.yml` and Service
`service-artifacts.yml` completed-success main run/attempt. It rejects missing,
expired, tampered or duplicate-key records, unknown formats, unsealed releases,
asset/source mismatches and unverified release attestations. Selection, deployment
and operation runtime records use Infra schema v2; historical receipt-bearing v1
records are rejected without relabeling historical evidence. E2E loads the actual
regular tracked canonical `selections/*.json` file in the clean reviewed Infra
checkout, bound to the recorded raw SHA-256 and explicit `compatibility.infra.sha`.
The pinned consumer receives that relative path/hash and the trusted root/SHA;
its complete release/components must match the deployment record. A reconstructed
external JSON file cannot supply selection authority, and the vendored directory
cannot replace the runtime Infra checkout. Direct verification checks the
completed-success publisher identity before and after the native release and all
five asset verifications, API asset size/digest, and unchanged complete signed
statement. It needs no candidate, receipt, approval record or Actions publication
ZIP. See the exact staged source and raw hashes in [vendor provenance](scripts/vendor/README.md).
Private retrieval
uses separate GitHub App readers: Infra-only Contents/Actions read through
`GH_TOKEN`, and Service-only Contents/Actions/Attestations read through
`SERVICE_ARTIFACT_READ_TOKEN`. App token creation uses v3 so the declared
permissions are applied. Integration source checkouts use a separate Contents
read token limited to Client, Service, and Service-API; cleanup tokens retain only
Service Actions write. Native release verification and the pinned Infra observer
receive the Service reader through an explicit subprocess environment, with no
fallback to the Infra token or local authentication. It does not use a PAT.
`gh release verify` and `verify-asset` must be available. Source Quality and both
qualification workflows check these commands offline; qualification evidence
preserves the actual runner `github-cli-version.txt`. The Ubuntu
runner uses Python's ZIP reader to read exactly `deployment-record.json`, without
extracting any archive paths.

AWS credentials are assumed before the first observation through
`beta-e2e-qualification-role`. The exact compatibility-pinned Infra helper observes
the actual CFN Original templates, stable Lambda configuration and code hashes,
ECS task/image identity and queue settings, and runs a bounded read-only task from
the exact selected image to inspect full policy content and the actual DB migration
history. HTTP minimum schema values do not establish applied DB state. Compatible
extra applied migrations remain legal for image rollback; selected and applied
journal hashes describe different inputs and need not match.

Before and after snapshots must match the trusted deployed tuple, use different
verification tasks and remain stable across the release-gating deployed selection. Only Beta
Qualification emits v2 passing records. Its local `verifyQualificationRecord`
checks schema, integrity and all tuple bindings while the producer is in progress.
A release consumer must call `verifyQualificationForPromotion` with authenticated
completed-success E2E run/attempt, unexpired exact artifact metadata and the pinned
record bytes/hash. A checksum alone does not establish trusted publication.

## Ordinary E2E execution

For the offline cross-repository builder gate, first run the locked Service
`artifacts:build` command from its clean exact source checkout with explicit mock
producer/image inputs. Then, from E2E, run
`node scripts/verify-artifact-builder-fixture.mjs <actual-builder-output> <Infra-checkout>`.
This verifies real ZIP/policy/schema/manifest bytes through both Infra and E2E
public contracts and the v2 qualification consistency builder. The result under
`.qualification-inputs/builder-fixture/` labels all run IDs and deployment data as
offline mocks; it cannot establish publication, authenticated observation or a
passing deployed suite. Repeat on the final producer/consumer source revisions.
The [public-contract provenance and source acceptance](scripts/vendor/README.md)
records the exact Service builder and Infra revisions, asset integrity cases and
the limits of this offline result.

Verify that Infra/Client/legacy writers have ceased before allocating an E2E
qualification or recovery window. Repository-local concurrency
does not serialize those other repositories. Keep `ENABLE_INFRA_E2E` unset or
`false` during preparation. For an authorized protected Beta dispatch, configure:

| Variable | Required value |
| --- | --- |
| `ENABLE_INFRA_E2E` | `true` only after role/access/cutover gates pass |
| `E2E_CLEANUP_SERVICE_SOURCE_SHA` | Full reviewed deployed Service source SHA bound into the fixed cleanup capability |
| `E2E_CLEANUP_SERVICE_SHA` | Legacy source/operator guard value retained during cutover |
| `E2E_CLEANUP_SERVICE_IMAGE_DIGEST` | Reviewed deployed Service image digest |
| `BETA_CLEANUP_STATE_MACHINE_VERSION_ARN` | Immutable version ARN of the Infra-owned cleanup state machine |
| `E2E_WORKER_SLOT_OFFSET` | Allocated first slot, integer 0 through 6; selected workers must fit within slots 0 through 7 |
| `AWS_ACCOUNT_ID`, `AWS_REGION` | `650880818323`, `ap-east-1` |

The protected Beta environment, exact repository/owner IDs, main workflow dispatch,
allowed workflow path and matching workflow/checkout commit establish source identity.
`execution-guard.mjs --source-only` checks that identity before credentials. After
assuming the dedicated `beta-e2e-qualification-role`, each workflow captures fresh
STS account/principal values and checks the exact account, role and region. Those
values are supplied by the workflow, not dispatch inputs. The default guard requires
that captured principal before observations, suite and mutation boundaries, including
Cognito deletion after a fixed cleanup operation wait. Missing or mismatched identity
retains the cleanup manifest for protected recovery. Qualification has a 90-minute
job bound; integration and account recovery have 60-minute bounds. All three share
the `beta-e2e-account-pool` concurrency group with cancellation disabled. Verify
all local/Actions/CFN/ECS/nested Service jobs have ceased before handing the
environment to another writer; timeout alone never releases it.

The Infra-owned versioned Step Functions cleanup capability invokes Service's fixed
application-data task. Normal and recovery cleanup submit the same strict envelope,
wait for its exact execution and committed result, and require terminal success
before deleting Cognito identities. Recovery validates the completed
original E2E owner and captured worker subjects; unknown or unrecovered identities
and quarantined leases remain in its manifest and fail recovery. The account
artifact preserves the capability execution, source/image binding and exact cleanup
request before any Cognito deletion, including when later cleanup fails. Legacy
`service-cleanup-run.json` records remain accepted as historical recovery input;
new runs use `service-cleanup-operation.json`. E2E does not check out a mutable cleanup
helper or pass the Lifecycle/Cleanup task roles. Service's surviving operator must
select the dedicated `CleanupTaskRoleArn` with no fallback to the old Lifecycle
role. Its legacy image still needs narrowly reviewed data-cleanup permissions for
the two Beta DLQs, while admission controls remain outside that role. None of these
workflows deploy CDK, change admission policy, or revive the retired runtime drill.

Operation evidence uses schema 3 and records initiation, observed terminal state,
and a separate `proof_status`. Step Functions success alone does not permit identity
deletion: E2E rechecks the exact execution input/version, both stopped ECS tasks,
their immutable definitions, image/source, fixed command and log paths, and the
unique `ANYWEAR_BETA_CLEANUP_RESULT=` Service completion marker. The marker's envelope
hash binds the actual ECS command bytes, while its request hash binds the original
captured worker JSON. Requests exceeding ECS's 8192-byte serialized override bound
are rejected before starting an execution.

DLQ counters may include messages that the fixed Service implementation proves
belong to deleted terminal tasks. E2E validates nonnegative counters and refuses an
unassigned diagnostic `known_message`; those counters alone do not establish
per-message ownership. Source/image-bound Service validation and live unrelated
data/message preservation evidence provide that acceptance boundary.

Protected account recovery defaults to `operation_mode=normal`. Explicit recovery
requires `operation_mode=recovery` and `recovery_attempt` (1..999999). Attempt 1
uses the original integration or qualification run's authenticated owner artifact
and canonical captured request. Later runs also select the latest completed main
recovery workflow through `previous_recovery_run_id` and
`previous_recovery_run_attempt`; each artifact is named by that recovery workflow's
own run ID and attempt. These inputs are checked before AWS credentials.

Recovery execution names bind the original run scope and attempt alone. Resuming
the latest attempt preserves its exact source, image, version and input, including
after a lost success response. Repair requires explicit latest+1 after the prior
execution failed, timed out or was aborted. Full bounded execution/history records
bind the predecessor and every submitted task. Two stable current ECS inventory
scans must prove no active work; expired historical task descriptions do not block
a new attempt. Unavailable listed current tasks, incomplete pages, stale artifacts,
changed captured subjects or active work retain the accounts. Recovery does not
enter the legacy normal retry/no-commit path. Partial Cognito reconciliation never shrinks the
canonical cleanup request. Shared account-pool concurrency does not establish a
cross-repository writer allocation; that remains an operational preflight gate.

Integration and Qualification accept `worker_slot_offset` (default `0`) for a
pair of stable Chromium identities allocated to the run. Account allocation and
admission eligibility use the same validated offset; for example `2` selects slots
2 and 3 without reusing slots 0 and 1. Recovery always uses the exact captured
original emails/subjects, independent of later slot allocations. An offset does
not establish cessation of other jobs or authorize use of occupied slots: verify
outstanding executions, tasks and manifests are reconciled before reuse.

## Beta sizing evidence

`scripts/beta-sizing-benchmark.mjs` classifies collected sizing evidence. It does
not authenticate artifact publication or replace Beta Qualification. A normal
suite pass alone cannot qualify smaller tasks.

Measured result schema version 2 requires exact application/deployment and fixture
bindings, raw evidence URLs/hashes, initial configured desired/minimum/task sizes,
12 completed upload/tagging cases, four representative VTO shapes twice, two distinct
same-Worker overlap cases, per-task container high-water readings, complete CPU minute
coverage, at least 100 samples per ordinary route, and provider-separated local and
publication/execution intervals for each accepted task. Record every actual task and
scaling event in the evidence; configured desired count does not imply a constant
replica count. Each VTO observation must report the aggregate it submitted, which the
per-input bound does not cover: the VTO payload aggregates the base photo and the
garments and is a separate, unproven quantity. The five-garment 4K shape is deferred to
#140, not asserted as an invented product maximum. Retain uncertain provider/model
envelope limits.

Missing metrics, unsupported peak sources, incomplete workloads, mismatched inputs or
an unqualified fresh common S1 remain **unqualified**. Collector `evidence_gaps`
must be an explicitly empty array for S1 and candidates. Each upload must match its
unique canonical case ID, mode, format, size and frozen fixture hash/bytes/dimensions;
totals or partial matrix presence do not establish the 12-case coverage.
Observed correctness, headroom or
regression failures are **rejected**. S3 retains the smaller API headroom criterion.
CPU rejection requires five consecutive valid one-minute samples at or above 90%.
Compare local processing separately from provider time and both queue intervals
independently; preserve provider timings without treating provider variability as
local processing. Never substitute sampled memory, process RSS, missing buckets or
transaction acknowledgement for an unobserved peak, zero usage or exact DB commit.
Queue measurements may use exact common-clock intervals or verified conservative
phase bounds. Upper bounds compare against independently known S1 lower bounds;
unknown exact baseline delays use the conservative lower bound zero. A failing
upper-bound comparison remains inconclusive, while an exact measured regression
is rejected. Every task needs clock/error evidence and same-task correlation;
execution before send acknowledgement is legal, and the send-start boundary avoids
inventing a clamped zero delay. Unverified clocks or contradictory ordering cannot
qualify a result.

S0 records historical two-replica cost/configuration evidence. It is not a new
runtime gate. The changed telemetry image must first pass a fresh S1 workload at
one API replica, 512 CPU / 1024 MiB and the existing Worker size. S2/S3 compare
only against that passing S1 with identical E2E source, image, Client, fixture and observed
provider configurations. Do not reuse old-image timings or restore two replicas
merely to collect a new baseline.

The `sizing_stage` input of protected Beta Qualification defaults to `disabled`.
An explicitly reviewed S1/S2/S3 selection runs `tests/beta-sizing.spec.ts` in the
instrumentation job, after the qualification job and in `pnpm test:instrumentation`,
once with no retries: 12 uploads/tagging tasks (three formats, JPEG/PNG/WebP,
sequential/burst, two repeats), then four VTO shapes twice. Two
bursts overlap VTO submissions; actual same-Worker overlap must still be shown by
telemetry. VTO uses one/three garment references on the served ordinary base photo,
submitted smallest-first so each shape carries the least payload it can, with the
default 2K output. Every garment is a fixture the run submits before the first VTO
case, and each case resolves its garment ids from the frozen submission plan rather
than from the uploads recorded when that case starts, so the submission order and the
VTO order are independent of each other. These are representative cases bounded by
the measured envelope
below, not asserted product/provider maxima. The five-garment shape that carried the
representative larger 4K output is deferred to #140 with its aggregate recorded; see
the envelope section.
The reviewed provider PDF covers 5.0-lite, while deployed source uses 5.0; S1 failure
must resolve this applicability gap before candidate measurements. Model/settings stay
frozen after S1. The preflight requires ten existing daily credits; it changes no quota.

### The VTO terminal wait is the platform's recovery floor

The VTO terminal wait is a bound on the platform's own recovery floor, **not** a
measurement of observed provider latency. `scripts/beta-sizing-environment.mjs` owns
both numbers and the derivation between them. The floor is the larger of the two values
AnyWear-Service publishes as the deployed task runtime policy
(`src/tasks/runtime-policy.json`): the `vto` queue visibility of **900 s** and its
**960 s** database lease, so work a worker replacement interrupted cannot be redelivered
and claimed before 960 s. `SIZING_VTO_TERMINAL_WAIT_MS` is therefore **1,200,000 ms**,
and `terminalWaitMs('vto')` refuses any budget that does not outlast that floor. The
auto-tagging wait stays at **600,000 ms**: uploads already outlast their own, smaller
floor (300 s visibility, 360 s lease), so raising it would change a budget that was
never wrong.

The old 600,000 ms budget sat below the floor, and that is the defect issue #147 records
rather than a slow product. In qualification run
[38864061777](https://github.com/git-malu/AnyWear-E2E/actions/runs/38864061777) a
rotating Beta worker stopped the task holding the S1 `large-base-three-garments-0` case;
its provider call was killed by `SIGTERM` 40.7 s in and wrote nothing, the case stayed in
`Processing`, the queue redelivered the work exactly at its 900 s visibility floor, and
the suite had stopped looking 300 s earlier. Nothing about the shape was slow: it
completed in 46.8 s in an earlier run and 46.3 s in the other three-garment case of that
same run, and no provider call in either run exceeded 62,819 ms. The budget was never
tight on provider latency; it was set below the point at which the platform is allowed
to retry.

### Environment change during a suite

A qualification can run across a deployment rotation, and the run now says so instead of
reporting the platform's recovery as a product failure. The workflow records the
identity of the worker(s) serving Beta immediately before and immediately after the
suite - the worker service's task ARN set and the task definition those tasks run - and
compares them. `scripts/beta-sizing-environment.mjs` reads that identity from the
workflow, which holds the scoped AWS credentials; the Playwright spec reads no AWS and
decides no environment change, so the sizing support code owns the record shape and the
comparison rules while the spec keeps recording what it observed.

- `.qualification-inputs/beta-environment-before.json` and
  `.qualification-inputs/beta-environment-after.json` are the two captures; the
  after-capture runs even when the suite failed.
- `test-results/beta-environment-verdict.json` is the verdict: `environment-changed`,
  `unchanged`, or `unavailable` when an input is missing or malformed, with
  `product_failure_asserted` and the exact worker task ARNs that appeared and
  disappeared. When the suite passed and `comparison.task_definition_changed` is true,
  this same verdict is what refuses the qualification.
- `test-results/beta-sizing-workload.json` records the identity the workload started in
  (`worker_identity_before_sha256`), and the verdict reports whether the two agree.

A verdict of `environment-changed` **replaces the product-failure report**: the run
states that the platform was redeployed under the suite and that no product failure is
asserted. It does not turn the run green. When the suite failed, the job still ends
non-success and no qualification record is created. The converse is equally strict: a
case that fails while the worker identity is unchanged is still a product failure, and a
check that could not be established is reported as `unavailable` so the failure keeps
standing instead of being explained away. An `incomplete` suite - one that was cancelled
or ended by the job timeout and so neither passed nor produced a product failure -
asserts no product failure either, because none was established; its red run comes from
the cancelled step. The verdict is a conservative label rather than per-case causation -
the captures bracket the suite and cannot say when a rotation happened relative to the
interrupted case - so a genuine product failure that coincides with a worker replacement
is reported as an environment change and must be re-adjudicated by a re-run.

The verdict is a qualification gate on one branch only: the passing path. A suite that
**passed** while the worker task definition serving Beta changed cannot issue a
qualification - the record path refuses before it writes `qualification-record.json`, and
the `Refuse a qualification measured across two worker definitions` step fails the run with
the same sanitized sentence. The reason for the distinction is what the run measured: a
suite that spanned two task definitions measured neither of them, while a rotation of task
ARNs on one unchanged definition leaves the configuration under test intact. That rotation
is recorded and does not block, so a passing suite on one unchanged definition is still
qualified, and the reason line says which of the two happened: an added-only change reads as
a scale-out, not as workers being replaced. Run
[38879938899](https://github.com/git-malu/AnyWear-E2E/actions/runs/38879938899) is that
rotation - its suite passed, the verdict recorded 2 worker task(s) appeared and none removed
with the task definition unchanged, and the run still created its qualification record. A
redeployment that replaces the deployed tuple is still caught separately by
`Confirm deployed identities remained stable`.

The capture is unconditional for every qualification run, not only for the opt-in sizing
stage, because a deployment change cannot qualify release evidence of any kind. The
frozen shape set is untouched by any of this: the four VTO shapes, the three-garment
shapes included, still run twice each, and the environment record bounds no payload -
the VTO aggregate stays the separate, unproven quantity recorded per observation.

### Measured S1 input envelope and its limits

The sizing case set submits only inputs this deployment is demonstrated to serve. The
bound is not a provider maximum and not a guess: it is the largest input a real S1 run
served to a terminal `ready` state, taken from this run's own artifact
`beta-qualification-diagnostics-38768690421-1`
([run 38768690421](https://github.com/git-malu/AnyWear-E2E/actions/runs/38768690421))
at E2E `2fb06bce239e483eae77f7095062dc06fc395891`, stage S1, as recorded in
`test-results/beta-sizing-workload.json`. These are **historical run figures, not the
committed fixture sizes**: the shipped fixtures were later re-encoded and are smaller,
so the artifact's numbers and the repository's bytes must not be confused.

| Case | Fixture | Input | Outcome |
| --- | --- | --- | --- |
| `sequential-ordinary-jpg-0` | `trousers-ordinary.jpg` | 441,913 B, 1200x960 | `ready` in 25.7 s |
| `sequential-ordinary-jpg-1` | `jacket-ordinary.jpg` | 697,437 B, 900x1200 | `ready` in 85.0 s |
| `sequential-ordinary-png-0` | `sweater-ordinary.png` | 3,742,711 B, 1200x1039 | `failed` |

Therefore `S1_INPUT_BYTES_MAX` is **697,437 B**, the largest input demonstrated served.
The basis is **one submitted input**: it was derived from single-image uploads, where
one input is one provider payload. A VTO generation aggregates a base photo plus the
garments and is a separate quantity, so it is not bounded by, and not proven by, this
number.

The bound is on what is submitted, never a relaxation of what must pass: a case above
it is not made passable, it is not submitted. The constraint lives in
`scripts/beta-sizing-envelope.mjs` as explicit constants, and every path that could
exceed it fails loudly instead: `sizingUploadCases()` builds the matrix only from
`SIZING_WORKLOAD.size_classes` and asserts the resulting count, `loadSizingFixtures`
rejects any frozen fixture above the bound, any case input naming an excluded fixture,
any garment outside `S1_VTO_GARMENT_POOL`, and any garment list that is not the
canonical smallest-first one, and `evidenceGap`
marks a recorded upload, VTO base photo or VTO garment above the bound, or a VTO
observation that does not report its aggregate, unqualified. The fixture manifest
repeats the bound, its per-input basis, the measured inputs, the excluded fixtures, the
historical VTO shape names and the deferred VTO shape, and the loader refuses a manifest
whose declared envelope differs from these constants.

**The VTO garment pool and its rule.** A VTO case must resolve each garment to the
wardrobe item its upload created, so a garment may only be a fixture the run submits
*before* the first VTO case. `S1_VTO_GARMENT_POOL` is therefore the sequential half's
uploads restricted to the reviewed garment formats - `VTO_GARMENT_FORMATS`, the ordinary
JPEG and PNG. `sequentialGarmentUploads()` derives exactly that rule from
`mime` and the case set, and the loader refuses a pool that does not equal it;
`createSizingVtoGarmentPlan()` then refuses any case whose garment the plan cannot
resolve, naming the fixture and the case before the first VTO is accepted.

The rule costs coverage, and that trade is accepted rather than hidden. The sequential
half submits four distinct fixtures and the pool holds three:

- `bag-ordinary.jpg` and `shoes-ordinary.jpg` are **burst-only** - the only upload cases
  that carry them are `burst-ordinary-jpg-1` and `burst-ordinary-jpg-0`, which launch
  *inside* the VTO loop. No pre-VTO upload produces their wardrobe item, so they cannot
  be resolved when the first VTO case needs one. These two are the fixtures the
  previous five-id `S1_VTO_GARMENT_ORDER` named and the defect this change fixes.
- `sweater-ordinary.webp` is deliberately outside the reviewed garment formats: it is the
  WebP format-coverage fixture, not a garment reference. It is submitted sequentially,
  so it is excluded by the format rule rather than by timing.
- `sweater-ordinary.png` **is** a pool garment. It is submitted sequentially as
  `sequential-ordinary-png-0` - the case whose 696,168-byte upload reached terminal
  `ready` in run 38844432804 - and it is not burst-only.

So VTO coverage no longer includes the two smallest fixtures. The submitted shapes keep
their one/three garment counts and their smallest-first order within the pool, and the
aggregates that follow from the frozen bytes are stated in the aggregate bullet below.

The run aborted at that third case, so **no VTO generation has ever run in this
workload** and every route sample count is 0. The VTO cases are therefore unobserved
at every payload size. Each generated input is inside the bound - the base photo is the
served ordinary photo and the garment references are frozen upload fixtures - and each
observation reports the `aggregate_submitted_bytes` it actually sent, so the real
payload is visible in the evidence instead of left to be added up. That aggregate stays
**unproven**. The `large-base-*` shape identifiers are historical names retained for
binding stability, not a description of the fixture: every submitted shape uses
`base-photo-ordinary.jpg`, and the only shape that carried the large base photo is the
deferred five-garment one.

What this measurement covers, and what it does not:

- **This envelope only.** A green sizing run states that the 12 uploads and 8 VTO cases
  above passed, per submitted input, inside 697,437 B. It is not evidence for anything
  larger, and it says nothing about the VTO aggregate.
- **The large-input defect is unchanged.** The failed third case is the known defect
  tracked as **#140** (the pipeline base64-encodes original bytes to the VLM, the fixed
  60 s budget expires, three retries spend it again, and the case ends terminal).
  Constraining the case set does not fix it, and the removed fixtures and the deferred
  VTO shape stay recorded in the manifest and in `scripts/beta-sizing-envelope.mjs`
  rather than disappearing.
- **The VTO aggregate is deferred, not measured.** The five-garment shape that also
  carried the representative larger 4K output is deferred to **#140** and recorded in
  `s1_input_envelope.deferred_vto_shape`: 2,408,024 B of garments plus the 545,720-byte
  base photo is a 2,953,744-byte aggregate, about 79% of the 3,742,711-byte single input
  whose base64 payload exhausted the 60 s budget. Keeping it would stake the measurement
  on the shape most likely to reproduce the failure this bound works around. It returns
  when a run passes with it, with its aggregate recorded. The aggregates the **submitted**
  shapes carry are not frozen numbers but the sum of the frozen fixture bytes each case
  names: for the shipped bytes the one-garment shapes submit 933,902 B
  (545,720 + 388,182) and the three-garment shapes 2,294,523 B
  (545,720 + 388,182 + 664,453 + 696,168), both above the per-input bound and both
  recorded per observation, recomputed by `vtoAggregateSubmittedBytes` rather than
  restated, so a fixture re-encode cannot leave a stale claim behind.
- **The submitted-shape aggregates follow the pool.** The 933,902 B and 2,294,523 B
  above are the sums the current pool produces, not independent limits. Adding a fixture
  back as a garment - `bag-ordinary.jpg`, `shoes-ordinary.jpg` or
  `sweater-ordinary.webp` - or re-encoding a pool fixture moves them, which is why they
  are recomputed rather than restated. The deferred shape's own 2,408,024 B, 545,720 B and
  2,953,744 B are restated constants, so the test recomputes all three from the frozen
  fixtures and fails on any difference: those figures may not outlive the bytes they
  describe.
- **Widening needs a passing run.** Re-adding an input above 697,437 B — the removed
  `near-supported-limit` class, `base-photo-large.jpg`, or the deferred five-garment 4K
  shape — requires a run that passes at those sizes, and that run's evidence must then
  move the constant. A run inside the current envelope cannot qualify a wider one.
- **Submitted bytes are not provider cost.** The bound is measured in input bytes
  because that is what the evidence and the failure mechanism show; it is not a claim
  about pixel count, decode time or provider latency at the bound.

Frozen image bytes, dimensions, SHA-256 and source/license provenance live in
`tests/fixtures/beta-sizing/fixture-manifest.json`. That manifest also records the
`encoding` and `derivation` of every shipped fixture, so a rebuilt fixture cannot pass
as the original. Every shipped fixture was rebuilt for this envelope:

- The six JPEG fixtures - `sweater-ordinary.jpg`, `base-photo-ordinary.jpg`,
  `trousers-ordinary.jpg`, `shoes-ordinary.jpg`, `bag-ordinary.jpg` and
  `jacket-ordinary.jpg` - were re-encoded from the legacy 4:4:4 settings to quality 100
  with 4:2:0 subsampling. Their pixel dimensions did not change, but **their chroma
  did**, so this is a re-encode and not a byte-identical pass-through. Each manifest
  `derivation` states that per fixture with its own byte delta.
- `sweater-ordinary.png` was replaced by a lossless PNG transcode. Its uncompressed
  3,742,711-byte form and the normally compressed form of the same pixels (1,126,570 B
  at `compress_level: 9`) both exceed the bound, so its pixels were reduced to 879x761
  with the aspect ratio retained, for 696,168 B. No pixel was re-encoded lossily.
- `sweater-ordinary.webp` re-encodes to the reviewed lossless settings unchanged.

The `near-supported-limit` fixtures are not part of the set: they are recorded at their
original sizes and SHA-256 values in the manifest's `s1_input_envelope.excluded_fixtures`,
with `#140` as the reason, and a later reader must not read them as passing cases.
Valid codec encoding/resize creates the fixtures; no padding or noise is added. The
Pillow builder enforces the bound itself: it copies an accepted fixture through
byte-for-byte at the reviewed encoding and refuses to write anything above the bound.

The workflow preserves `.qualification-inputs/beta-sizing-runtime-before.json`
and `test-results/beta-sizing-workload.json` in qualification diagnostics, including
partial business results after failure. Protected leased-account application
cleanup handles all retained data and exact subjects; the scenario performs no
ad hoc deletion. Unfinished tasks/failed cleanup cannot qualify the stage.

Sizing captures a complete canonical Git path-byte/mode/type/object inventory at
the actual protected E2E HEAD before and after the workload, with exact source,
run/attempt, origin, tracked-byte, index-flag and clean initialized-submodule
checks. The benchmark digest excludes **only root `compatibility.json`**; gitlinks
remain pinned commit entries, and no tracked file is omitted through ignore
patterns. Actual E2E SHAs and full compatibility bytes/blob hashes stay visible.
S1/candidates require identical digests and strict compatibility, allowing only
`deployment.run_id`, `run_attempt`, `artifact_id` and `record_sha256` to change.
Client/Service/Infra/artifact/API/fixture/model or any other source/contract change
requires a fresh common S1. Missing or malformed proof remains unqualified.

The proof's self-hash is not an authenticity claim. Before candidate dispatch,
review the exact commit diff, confined to `compatibility.json` and those four fields.
During acceptance, independently authenticate the native
completed-success protected-main qualification run, exact head/attempt and artifact
IDs/name/run/digest/byte checksums. `assertSizingSourceRun` checks supplied native
run metadata, and `verifySizingSourceAtCommit` independently reconstructs the full
inventory from that trusted actual commit; use both with authenticated inputs.
Neither function fetches metadata or grants credentials. Collector/classifier
success does not satisfy this separate trust gate.

After independently authenticating/downloading that exact run artifact, the
owner uses `scripts/collect-beta-sizing-evidence.mjs` with explicit `--profile`,
`--workload`, `--workload-sha256`, `--before`, `--before-sha256`, and `--output`.
This tool only reads AWS STS, ECS, task definitions, scaling, CloudWatch CPU and
reviewed API/Worker log streams in account 650880818323 / ap-east-1. Run it within
50 minutes after the bounded workload starts so stopped-task evidence remains
available. Allow CloudWatch/log delivery first; missing minute buckets or final
high-water samples remain gaps. The E2E principal receives no new metrics IAM
grant. Preserve the resulting raw artifact and hash before composing final
classification. Separate readiness, queue/DLQ/lease/backlog, notification,
lost/duplicate-work and lifecycle evidence is still required; the collector never
fills those acceptance counters with assumed zeros.

Service's opt-in same-Worker causal method requires a complete unfiltered outbox-ID
snapshot (256-row cap, 200 ms statement timeout, 250 ms bounded observer wait), an
immutable task/outbox correlation, first send/ACK/execution and one process clock.
Commit-to-publication upper bound is ACK minus an earlier snapshot query start
that saw the ID absent; lower bound is zero. Publication-to-execution lies between
`max(0, execution - ACK)` and `execution - send-start`. Missing/truncated snapshots,
retry/republish/process replacement invalidate it. Both S1 and candidates retain
query overhead and raw proof; no API/Worker wall-clock error is invented.
