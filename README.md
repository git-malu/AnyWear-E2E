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

The preferred local layout is the AnyWear shell repository:

```text
AnyWear/
|-- AnyWear-Client/
|-- AnyWear-Service/
|-- AnyWear-Meta/
|-- AnyWear-Infra/
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
path and deleted during worker teardown. Public registration remains governed by the
Service-owned tester policy; ordinary qualification does not mutate admission policy or
require a real tester mailbox.
The qualification and integration workflows share a non-cancelling Beta account-pool
concurrency group, and each run uploads its account-budget manifest for recovery.

## Commands

```bash
pnpm check             # compatibility, explicit core contracts, lint, typecheck and safe discovery
pnpm test:core         # eight current offline identity/cleanup/qualification/artifact contracts
pnpm test:tool-regressions # sixteen retained offline operational-support test files
pnpm test:deferred-sqs  # two source-only SQS prototype test files; manual #58 review
pnpm audit             # fail on high/critical dependency advisories
pnpm test:smoke        # on-demand deployed Beta diagnostic
pnpm test:full-stack   # deployed Beta scenarios marked @full-stack
pnpm test              # complete deployed Beta qualification suite
pnpm report            # open the latest HTML report
```

Playwright verifies the configured deployed stage endpoints. Browser execution fails
closed unless the stage is Beta or Production, external servers are selected, and both URLs use
HTTPS. Test discovery and source checks do not connect to the deployed environment.

The explicit file lists in [package.json](package.json) are the suite registry. A new
test file needs an ownership/classification decision before it enters an executed
suite; a filename wildcard cannot select a routine or release gate.

| Command | Owner and trigger | Actual effects and evidence |
| --- | --- | --- |
| `check` / `test:core` | E2E maintainers; PR/main Quality and source preparation in Integration/Qualification | Offline fixtures, temporary files/Git repositories, lint, typecheck and discovery; no credentials, cloud calls or deployed result |
| `test:tool-regressions` | E2E operational-tool maintainers; affected-path PR/main workflow or explicit manual dispatch | Mock AWS/Cognito/fetch, temporary files, a loopback HTTP fixture and bounded Bash checkpoint helper; no AWS/App credentials or live drill proof |
| `test:deferred-sqs` | Repository maintainer under [#58](https://github.com/git-malu/AnyWear/issues/58); manual future-protocol review only | Two offline ARM/ACK/FIRE prototype files; no live transport, trusted AWS identity or receipt proof, and no #54 acceptance claim |
| `test:smoke` | E2E maintainers; allocated on-demand Beta+ Integration | Real login/dashboard/wardrobe navigation using a bounded worker identity and existing cleanup contract; diagnostic only |
| `test` / `test:full-stack` | E2E maintainers; allocated Beta+ qualification | Deployed business flows, identity creation and cleanup, external VLM/provider work; only the complete qualification workflow and its evidence can qualify a release |
| `runtime:plan` / `runtime:preflight` / `runtime:verify` | E2E operational-tool maintainers; explicitly selected diagnostic | Plan/evidence file operations, or authenticated read-only Beta observations for preflight; never live drill execution |

The eight routine core files retain account-budget, Cognito cleanup, qualification
record, wardrobe cleanup and worker cleanup contracts plus the current
`infra-source.test.mjs`, `infra-qualification.test.mjs` and
`trusted-deployment-inputs.test.mjs` contracts. The latter protect pinned source,
committed selection, direct native release verification, deployment identity and execution validation; their
offline assertions remain required by `check` without claiming actual publication or
qualification.

The tool workflow watches the registered tests, their implementation and fixture
dependencies, shared evidence/source contracts, vendored direct-release validators and
compatibility/lockfile inputs. It has only `contents: read` and no deployment
environment or credential steps. SQS prototypes are excluded from both routine core
and tool workflows and retain their [source-only handoff](scripts/beta-sqs-boundary-handoff.md).
The accepted [testing principles](https://github.com/git-malu/AnyWear-Meta/blob/3277d2d98cc6e66a5d9ca3e9d2661e07e7463a2d/architecture/system-component-architecture/technical-architecture/devops/test/test_governance.md)
define classification, cost, evidence and retirement policy.

## Execution Policy

Pull requests do not run cross-repository browser E2E as a required check. The E2E
Quality workflow runs compatibility validation, the explicit eight core test files, lint, type checking, and
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

The non-skipped `worker-smoke.spec.ts` signs in with the existing leased
`workerAccount` fixture and opens Dashboard and Wardrobe. Provisioning, budget,
protected execution, quarantine and Service/Cognito cleanup controls remain shared with
the full suite. `auth.spec.ts` is optional public-registration acceptance tagged only
`@full-stack`; it skips unless `E2E_PUBLIC_REGISTRATION_OPEN=true` and cannot appear
as a passing smoke gate. No workflow opens public registration for this scenario.

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

The AnyWear shell repository remains a convenient local workspace and may pin
the same revisions, but it does not run CI or hold cross-repository credentials.
Update `compatibility.json` only after the peer commits exist on their remotes
and their repository-owned pipelines pass.

## Infra qualification contract v2

[ADR 0021](https://github.com/git-malu/AnyWear-Meta/blob/a8eba148cfef4c124c46010276e66e4c8c41e420/architecture/ADR/0021-shared-infrastructure-repository.md)
defines the shared infrastructure cutover. Offline source checks still accept the
existing reviewed v1 Client/Service pins. The Infra qualification, integration and
recovery workflows require v2 and remain disabled until the manager activates their
writer gate. These changes do not select a newer image or refresh current pins.

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
verification tasks and remain stable across the complete suite. Only Beta
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

The manager records and verifies cessation of Infra/Client/legacy writers before
allocating an E2E qualification or recovery window. Repository-local concurrency
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
the `beta-e2e-account-pool` concurrency group with cancellation disabled. The manager
must verify all local/Actions/CFN/ECS/nested Service jobs have ceased before handing
the environment to another writer; timeout alone never releases it.

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

Protected account recovery consumes the preserved original operation input and
version before any invocation. A completed successful named execution is resumed
and its real task/log proof is revalidated. A failed, timed-out or aborted execution
is retained by default. The optional `retry_failed_execution` workflow input permits
one deterministic `-retry1` execution only after complete original history accounts
for every submitted task and read-only ECS observations prove those exact tasks
stopped. Unknown launches, truncated history, missing tasks, source/version drift,
or a failed retry retain the accounts. This input does not authorize environment
activation, deployment, queue deletion or broader cleanup.

Integration and Qualification accept `worker_slot_offset` (default `0`) for the
manager-allocated pair of stable Chromium identities. Account allocation and
admission eligibility use the same validated offset; for example `2` selects slots
2 and 3 without reusing slots 0 and 1. Recovery always uses the exact captured
original emails/subjects, independent of later slot allocations. An offset does
not establish cessation of other jobs or authorize use of occupied slots: the
manager still reconciles outstanding executions, tasks and manifests before reuse.

## Beta sizing evidence

`scripts/beta-sizing-benchmark.mjs` classifies collected sizing evidence. It does
not authenticate artifact publication or replace Beta Qualification. A normal
suite pass alone cannot qualify smaller tasks.

Measured result schema version 2 requires exact application/deployment and fixture
bindings, raw evidence URLs/hashes, initial configured desired/minimum/task sizes,
24 completed upload/tagging cases, five representative VTO shapes twice, two distinct
same-Worker overlap cases, per-task container high-water readings, complete CPU minute
coverage, at least 100 samples per ordinary route, and provider-separated local and
publication/execution intervals for each accepted task. Record every actual task and
scaling event in the evidence; configured desired count does not imply a constant
replica count. The larger VTO shape is a justified representative case confirmed on S1,
not an invented product maximum. Retain uncertain provider/model envelope limits.

Missing metrics, unsupported peak sources, incomplete workloads, mismatched inputs or
an unqualified fresh common S1 remain **unqualified**. Collector `evidence_gaps`
must be an explicitly empty array for S1 and candidates. Each upload must match its
unique canonical case ID, mode, format, size and frozen fixture hash/bytes/dimensions;
totals or partial matrix presence do not establish the 24-case coverage.
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
An explicit manager-reviewed S1/S2/S3 selection runs `tests/beta-sizing.spec.ts`
once with no retries: 24 uploads/tagging tasks (three formats, ordinary/9-9.75 MB
valid images, sequential/burst, two repeats), then five VTO shapes twice. Two
bursts overlap VTO submissions; actual same-Worker overlap must still be shown by
telemetry. VTO uses one/three/five garment references, ordinary/large base photos,
default 2K or the representative larger 4K output. These are baseline-successful
representative cases, not asserted product/provider maxima. The reviewed provider
PDF covers 5.0-lite, while deployed source uses 5.0; S1 failure must resolve this
applicability gap before candidate measurements. Model/settings stay frozen after
S1. The preflight requires ten existing daily credits; it changes no quota.

Frozen image bytes, dimensions, SHA-256 and source/license provenance live in
`tests/fixtures/beta-sizing/fixture-manifest.json`. Valid codec encoding/resize
creates the large fixtures; no padding or noise is added. The optional Pillow
builder records its version and requires separately downloaded exact source
bytes. The near-limit WebP uses a detailed jacket photo because lossless encoding
of the sweater cannot reach that byte range inside the pixel envelope.

The workflow preserves `.qualification-inputs/beta-sizing-runtime-before.json`
and `test-results/beta-sizing-workload.json` in qualification diagnostics, including
partial business results after failure. Protected leased-account application
cleanup handles all retained data and exact subjects; the scenario performs no
ad hoc deletion. Unfinished tasks/failed cleanup cannot qualify the stage.

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
