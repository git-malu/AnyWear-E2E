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
The operations of the `qualify` entry share a non-cancelling Beta account-pool
concurrency group, and each run uploads its account-budget manifest for recovery.

## Commands

```bash
pnpm check             # compatibility, explicit core contracts, lint, typecheck and safe discovery
pnpm test:core         # 27 registered offline identity/cleanup/qualification/artifact contracts
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
| `check` / `test:core` | E2E maintainers; the automatic Check entry (PR/main) and qualify preflight source preparation | Offline fixtures, temporary files/Git repositories, lint, typecheck and discovery; no credentials, cloud calls or deployed result |
| `test:tool-regressions` | E2E operational-tool maintainers; the automatic Check entry's `tool-regressions` job on every PR/main | Mock AWS/Cognito/fetch, temporary files, a loopback HTTP fixture and bounded Bash checkpoint helper; no AWS/App credentials or live drill proof |
| `test:deferred-sqs` | Repository maintainer under [#58](https://github.com/git-malu/AnyWear/issues/58); manual future-protocol review only | Two offline ARM/ACK/FIRE prototype files; no live transport, trusted AWS identity or receipt proof, and no #54 acceptance claim |
| `test:smoke` | E2E maintainers; the `smoke` operation of the protected `qualify` entry | Real login/dashboard/wardrobe navigation using a bounded worker identity and existing cleanup contract; diagnostic only |
| `test:regression` / `test` | E2E maintainers; the `full` operation's protected Beta qualification suite step, or explicit local investigation | The release-gating business scenarios, including identity creation and cleanup and external VLM/provider work; only this operation and its evidence can qualify a release |
| `test:instrumentation` | E2E maintainers; explicit opt-in through the `measure` operation of the protected `qualify` entry | A measurement workload with paid provider spend and its own cleanup contract, reported as a measurement; it can neither satisfy nor fail release qualification |
| `test:full-stack` | E2E maintainers; explicit local investigation | Every cross-repository scenario, the measurement included; not a release-gating selection on its own |
| `runtime:plan` / `runtime:preflight` / `runtime:verify` | E2E operational-tool maintainers; explicitly selected diagnostic | Plan/evidence file operations, or authenticated read-only Beta observations for preflight; never live drill execution |
| `compatibility:pin` | E2E maintainers, used by the maintainer accountable for a change that moved the deployed tuple | Offline byte-hash and binding comparison of the committed pin against a downloaded deployment record and the previous pin; no credentials, cloud calls or deployed reads |

The release-gating selection, the smoke diagnostic, the measurement and account recovery are
separated by the signed `operation` field, not by a workflow boundary, a step or a job. One
protected dispatch surface, the `qualify` entry in `beta-qualification.yml`, carries
`full`, `smoke`, `measure` and `recover`. A release consumer accepts a qualification record
only from the `full` operation of a completed-success qualification run; the record states
`operation: full` and is produced only by that operation, so a `smoke`, `measure` or
`recover` run can neither produce nor withhold a record the gate legitimately produced. The
three properties separation keeps are: the record is produced only by `full`; the record
binds the operation dispatched, so its producer is uniquely identifiable; and both this
repository's producer/verifier and the Infra-side executor allow-list check
`operation == full`. The [scenario inventory](docs/scenario-inventory.md) states which
verdict each invocation carries.

The 27 registered core files retain account-budget, Cognito cleanup, qualification
record, cleanup operation, wardrobe cleanup, worker cleanup and deployed-scenario
declaration contracts plus the current
`infra-source.test.mjs`, `infra-qualification.test.mjs` and
`trusted-deployment-inputs.test.mjs` contracts, and `entry-census.test.mjs` asserts the
two-entry face, the one manual dispatch surface, the credential ordering and the single
`ENABLE_BETA_MUTATION` name. `test:core` also owns
`scripts/beta-cleanup-diagnostic.test.mjs`, which asserts the cleanup diagnostic's
`DIAGNOSTIC_EXPECTED` evidence record offline, without credentials, cloud calls or
deployed reads; it belongs with its `service-cleanup-operation.test.mjs` and
`worker-cleanup.test.mjs` neighbours, and its
production module is consumed by `scripts/account-recovery-inputs.mjs` and
`scripts/cleanup-worker-accounts.mjs`. The infra contracts protect pinned source,
the two producer record identities, deployment identity and execution
validation; their offline assertions remain required by `check` without
claiming actual publication or qualification.

The automatic `Check` entry's `tool-regressions` job runs the retained tool tests, their
implementation and fixture dependencies, shared evidence/source contracts, the
vendored deployment contract (the v3 core plus the v4 Service bake gate) with its
provenance assertion, and
compatibility/lockfile inputs. `quality.yml` carried no path
filter, so that job now runs on every check rather than only on its former path set; the
cost is recorded in the PR body for #163. Both jobs have only `contents: read` and no
deployment environment or credential steps. SQS prototypes are excluded from both routine
core and tool checks and retain their [source-only handoff](scripts/beta-sqs-boundary-handoff.md).
The accepted [testing principles](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/system-component-architecture/technical-architecture/devops/test/test_governance.md)
define the classification, cost, evidence, admission and retirement policy this
repository applies.

## Execution Policy

Pull requests do not run cross-repository browser E2E as a required check. The E2E
Check entry runs compatibility validation, the explicit 27 core test files, the
credential-free tool regressions, lint, type checking, and
Playwright test discovery. Client and Service workflows remain responsible for their
required unit, repository integration, contract, database, and browser integration tests.

The `smoke` operation of the protected `qualify` entry is an on-demand deployed Beta
diagnostic and runs only the small `@smoke` subset. It checks out the reviewed peer commits
for diagnostic revision evidence, verifies their deployed identities, and exercises Beta's
real identity boundary. It does not run a local database or mutate the deployment.
Only the `full` operation can issue a passing qualification record.

The protected `pnpm test` suite step is reserved for the `full` operation of the `qualify`
entry, and it runs the release-gating selection. Only a passing run against the exact
reviewed Client, Service, and E2E revisions
produces qualification evidence that Production may consume. The
[scenario inventory](docs/scenario-inventory.md) records which scenarios that step's
selection contains; a measurement or drill result is not part of it and carries no release
verdict in either direction.

The qualification record states the selection that produced it instead of a constant. Its
`test` member names the invocation the suite step ran and the `--grep` tag that invocation
selects, the SHA-256 digest of the run's own Playwright JSON report, and one entry per
selected scenario with its outcome and how many of its collected tests were skipped. A
scenario's `collected` count counts collected test cases, one per case per declared
Playwright project — a skipped case is still collected and a retried case still counts
once — so a second project would count each case once per project. `test.result` is `passed`
unless at least one selected scenario passed only on a retry, which records it as `flaky`; a
declared skip is recorded in that scenario's own counts and does not change the run result.
A retry-only pass still issues a record, because a retry is the run-level flake control,
while the testing policy's admission condition is about a scenario that routinely needs one.
The suite step writes the report to the path the job declares as
`E2E_QUALIFICATION_REPORT`, and both the qualification evidence artifact and its
diagnostics retain the report, so the digest the record states is auditable against the
bytes it names. Two different verifiers judge that statement. The record verifier a release
gate calls holds no report: from the checkout it is given it re-derives the invocation, the
tag and the membership — the spec titles cross-checked against the
[scenario inventory](docs/scenario-inventory.md) — and refuses a record whose stated
selection or scenario list disagrees with them. The producer's own verify step, which runs
in the job before upload, re-derives the per-scenario outcomes, the counts and the digest
from the report the suite just wrote. A record issued before this change always stays valid,
because the verifier that judges it is always the one from the record's own producing
revision; the current verifier does not accept the retired `suite: 'complete'` shape.

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

The manual `Beta Qualification` entry (`qualify`) is the single protected dispatch
surface, with the required operation menu `full` (release gate), `smoke` (diagnostic),
`measure` (sizing) and `recover` (account recovery). The `full` operation is the
production-readiness gate for an already-deployed Beta environment. It reads the reviewed
full SHAs from `compatibility.json`, verifies those identities against the deployed Client
`build-metadata.json` and Service `/health`, runs the release-gating deployed selection,
rechecks both identities and the Service image digest, and hands a checksummed
qualification record to the credential-free `record` job, which re-verifies it offline and
attaches the artifact. A failed, mismatched, or changed deployment, or a worker task
definition that changed during the suite, cannot issue a passing record. The workflow
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
`full` and `smoke` operations of the `qualify` entry do not mutate tester policy or claim to
verify a real tester mailbox. Future changes to admission behavior should define only the
focused tests needed for that change; the retired deployed harness is not a standing release gate.

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
revisions under test and for the two deployment producers that wrote the
deployment records. It accepts only full commit SHAs; branch and tag names are
rejected. When invoked, the `smoke` operation of the `qualify` entry checks out those exact
private repositories, including their recursive API submodules, and records every tested
revision as an artifact.

Update `compatibility.json` only after the peer commits exist on their remotes
and their repository-owned pipelines pass.

## Release-slice qualification contract v3

The release-slice split moves `AnyWearRuntimeStack-{beta,prod}` (formerly
`AnyWearWorkloadStack-{beta,prod}`) to `AnyWear-Service`. `AnyWear-Infra` keeps
Bootstrap, the persistent Base stack (`AnyWearPlatformStack-beta`) and Billing,
plus the disposable `AnyWearEgressStack-beta`, and the reviewed observation
entry; the Service release chain builds, verifies, deploys and records the
Runtime slice in one run. E2E follows that split: the deployed tuple is qualified
by two per-producer deployment records, not by one Infra record covering every
stack and not by a committed cross-repository `selection`.

The full v3 shape, the two record identities, the deferred shape (contract
history) and the checks each record passes are in
[docs/compatibility-v3.md](docs/compatibility-v3.md).
The committed v3 pin names two producers:

```json
{
  "version": 3,
  "client": { "repository": "git-malu/AnyWear-Client", "sha": "<full-client-sha>" },
  "service": { "repository": "git-malu/AnyWear-Service", "sha": "<full-image-producer-sha>" },
  "infra": { "repository": "git-malu/AnyWear-Infra", "sha": "<full-observed-infra-sha>" },
  "platform": {
    "producer": "git-malu/AnyWear-Infra",
    "producer_sha": "<full-infra-producer-sha>",
    "record": { "<Infra deployment identity>" }
  },
  "workload": {
    "producer": "git-malu/AnyWear-Service",
    "producer_sha": "<full-service-producer-sha>"
  },
  "deployment": { "<Service release-chain deployment identity>" },
  "service_artifacts": {
    "repository": "git-malu/AnyWear-Service",
    "release_id": 1,
    "manifest_asset_id": 2,
    "manifest_sha256": "<exact-manifest-byte-sha256>"
  }
}
```

A deployment identity is either `status: deferred` — the producer and workflow are
named, no run is claimed — or `status: recorded` with `run_id`, `run_attempt`,
`artifact_id` and the exact record byte hash. The deferred shape survives only as
contract history; the committed pin records both producer deployment identities:

- `platform.producer_sha` is `5420469f`, the commit whose reviewed Infra
  `runtime.yml` observation run wrote the platform record, and that run's
  `head_sha`. `infra.sha` stays `da67841f`, the reviewed observation source the
  suite checks out; it is a different pin and the two may differ.
- `platform.record` records run `39104244598` attempt `1`, artifact
  `infra-deployment-39104244598-1` (artifact id `12128200024`), and the SHA-256 of
  the exact `deployment-record.json` bytes (`0c63e881…`).
- `workload.producer_sha` is `5af797f9`, the Service release-chain commit the
  `service-artifacts.yml` deploy run executed at `main`.
- `deployment` records run `39098055973` attempt `1`, artifact
  `service-deployment-39098055973-1` (artifact id `12124879790`), and the
  SHA-256 of the exact `service-deployment.json` bytes (`b7b52eef…`).
- `service.sha` is `ef21aaa6`, the deployed Service source named by the record's
  `observed.service_sha`. That is deliberately distinct from
  `workload.producer_sha`, the release-chain commit that ran the deploy: the
  record observed the sealed release's source, not the run's head.
- `service_artifacts` is sealed release `415718734`, whose manifest image source
  and digest are exactly the record's observed Service commit and image.

No historical Infra `runtime.yml` run and no Service publication run is
relabelled as a deployment.

`client.sha` does not move: the deployed Client still serves `7b92ace1` through
its `build-metadata.json`, and no Client publish ran after the previous pin.

[`docs/compatibility-pin.md`](docs/compatibility-pin.md) is the routine that moves
the pin; a move carries both records, never one producer at a time.

The Platform → Runtime deploy ordering is not claimed safe in general, but the
producer-side extension has landed. C's post-C Platform deploy removes every
`PublishOutput*` output, and the release-slice deploy's last eleven weak reads
(nine cleanup values and two isolated-subnet values) became stage-contract
parameters. Under `@git-malu/stage-contracts` 0.3.0 the stage contract publishes
36 definitions — 35 unconditional including `api_base_url`, plus the conditional
`cleanup_task_role_arn` — and the release chain reads what it consumes as pure
SSM parameters; there is no resident/stopped input variant. E2E hardcodes
neither the count nor the names: it accepts the producer's recorded, sorted and
unique list and derives the schema hash from it. Once both stacks read pure SSM
parameters, deploy order no longer matters. One authorized Platform → Workload
deployment succeeded; Issue #166 renamed that slice to Runtime without changing
the record shape, and the platform record is now pinned, so neither producer's
record is deferred.

`scripts/migrate-compatibility.mjs` owns the offline transition. v2 → v3 is
strict: a valid v2 previous pin plus both producer records (Infra v3 and Service
v4 with its passed bake gate), with each record's producer, stack set and observed
application tuple checked before the candidate is written. v1 → v2 is historical
only and is never accepted as a live migration input by the CLI.
`scripts/validate-compatibility-pin.mjs` re-reads both exact record byte streams
and refuses a deferred or non-forward pin. The vendored contract is the v4 Service
record and bake-gate contract from `AnyWear-Infra` at the pinned commit, with one
declared import rewrite in place of the package specifier; its source SHA, file
hashes and that rewrite are in [vendor provenance](scripts/vendor/README.md) and
enforced by `scripts/vendored-contract.mjs`.

Private retrieval uses separate GitHub App readers: Infra-only Contents/Actions read
through `GH_TOKEN`, and Service-only Contents/Actions read through
`SERVICE_ARTIFACT_READ_TOKEN`. App token creation uses v3 so the declared
permissions are applied. Smoke source checkouts use a separate Contents read token
limited to Client, Service, and Service-API; cleanup tokens retain only Service
Actions write. The two deployment-record reads use the reader of the producer they
belong to: the Infra record uses `GH_TOKEN`, the Service release-chain record uses
`SERVICE_ARTIFACT_READ_TOKEN`. The pinned Infra observer receives an environment
with no other reader. It does not use a PAT. The Ubuntu runner uses Python's ZIP
reader to read exactly one declared member of each record artifact, without
extracting any archive paths.


AWS credentials are assumed before the first observation through
`beta-e2e-qualification-role`. The exact compatibility-pinned Infra helper observes
the three stage-base stacks, the actual CFN Original template content hashes, the
stable Lambda configuration and code hashes, the queue settings and the stage SSM
inputs. The Runtime identity is bound by the deployed Service `/health` and the
Client build metadata. The v3 record's `schema` member is a content hash of the
stage-contract inputs; the database/applied schema identity moved to the Service
release chain with the release slice.

Before and after observations must match the trusted deployed tuple and remain
stable across the release-gating deployed selection. Only the `full` operation
emits passing records, and the record states `operation: full`; the qualification
record remains schema v2, while its `deployment` member now carries the platform
and workload records separately. Its local `verifyQualificationRecord` checks
schema, integrity, the signed operation and all tuple bindings while the producer
is in progress.
A release consumer must call `verifyQualificationForPromotion` with authenticated
completed-success E2E run/attempt, unexpired exact artifact metadata and the pinned
record bytes/hash. A checksum alone does not establish trusted publication.

## Ordinary E2E execution

The former offline cross-repository builder gate was retired with the `selection`
contract. The Service release chain verifies its own sealed release before it
deploys, and E2E binds the pinned release/asset identity and exact manifest bytes
without executing the retired Service parser.

Verify that Infra/Client/legacy writers have ceased before allocating an E2E
qualification or recovery window. Repository-local concurrency
does not serialize those other repositories. Keep `ENABLE_BETA_MUTATION` unset or
`false` during preparation. For an authorized protected Beta dispatch, configure:

| Variable | Required value |
| --- | --- |
| `ENABLE_BETA_MUTATION` | `true` only after role/access/cutover gates pass; the single stage switch shared by the system |
| `E2E_CLEANUP_SERVICE_SOURCE_SHA` | Full reviewed deployed Service source SHA bound into the fixed cleanup capability |
| `E2E_CLEANUP_SERVICE_SHA` | Legacy source/operator guard value retained during cutover |
| `E2E_CLEANUP_SERVICE_IMAGE_DIGEST` | Reviewed deployed Service image digest |
| `BETA_CLEANUP_STATE_MACHINE_VERSION_ARN` | Immutable version ARN of the Infra-owned cleanup state machine |
| `E2E_WORKER_SLOT_OFFSET` | Allocated first slot, integer 0 through 6; selected workers must fit within slots 0 through 7 |
| `AWS_ACCOUNT_ID`, `AWS_REGION` | `650880818323`, `ap-east-1` |

The protected Beta environment, exact repository/owner IDs, main workflow dispatch,
the single `qualify` entry and the explicitly stated `operation` establish source
identity. `execution-guard.mjs --source-only` checks that identity before credentials,
including that the operation is one of `full`, `smoke`, `measure` or `recover` and that
the workflow ref is the entry the operation map names. After
assuming the dedicated `beta-e2e-qualification-role`, each operation job captures fresh
STS account/principal values and checks the exact account, role and region. Those
values are supplied by the workflow, not dispatch inputs. The default guard requires
that captured principal before observations, suite and mutation boundaries, including
Cognito deletion after a fixed cleanup operation wait. Missing or mismatched identity
retains the cleanup manifest for protected recovery. `full` has a 90-minute
job bound; `smoke`, `measure` and `recover` have 60-minute bounds. All four share
the `beta-e2e-account-pool` concurrency group with cancellation disabled. Verify
all local/Actions/CFN/ECS/nested Service jobs have ceased before handing the
environment to another writer; timeout alone never releases it.

The Infra-owned versioned Step Functions cleanup capability invokes Service's fixed
application-data task. An ordinary qualification cleanup and a protected `recover`
dispatch submit the same strict normal-mode envelope and enter the same resume/verify/
retry rule. Recovery validates the completed original E2E owner and captured worker
subjects; unknown or unrecovered identities and quarantined leases remain in its
manifest and fail recovery. The account artifact preserves the capability execution,
source/image binding and exact cleanup request before any Cognito deletion, including
when later cleanup fails. Legacy `service-cleanup-run.json` records remain accepted as
historical recovery input; new runs use `service-cleanup-operation.json`. E2E does not
check out a mutable cleanup helper or pass the Lifecycle/Cleanup task roles. Service's
surviving operator must select the dedicated `CleanupTaskRoleArn` with no fallback to
the old Lifecycle role. Its legacy image still needs narrowly reviewed data-cleanup
permissions for the two Beta DLQs, while admission controls remain outside that role.
None of these operations deploy CDK, change admission policy, or revive the retired
runtime drill.

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

Protected account recovery and the ordinary qualification cleanup share one rule. For the
exact captured run scope, the entry point resolves one deterministic execution name,
`beta-cleanup-<runScope>-<requestHash16>`; an absent generation 0 is started under the
current version and normal envelope. It resumes that execution while it is `RUNNING`,
verifies the committed result when it has `SUCCEEDED`, and only when it is terminal
non-success performs the bounded predecessor check: the execution `describe` that
established the terminal state, then one inventory pass over the three bounded cleanup
task families (`beta-anywear-cleanup`, `beta-anywear-cleanup-verify` and
`beta-anywear-cleanup-acceptance`) asking ECS only for `RUNNING`-desired tasks. The
inventory never reads `lastStatus`: any returned task refuses the next start, and an
inventory that cannot complete refuses as well. A task still draining with a `STOPPED`
desired status is therefore outside this single-inventory check. Otherwise the dispatch
starts `beta-cleanup-<runScope>-<requestHash16>-retry1` once, or resumes or verifies that
name when it already exists.

A protected `recover` dispatch supplies the original owner evidence. That evidence is
validated in its own terms, so an execution captured under an older state-machine
version, an older Service image/source or a legacy mode-less owner input is observed and
verified under its own envelope and version. A retry newly started by this dispatch
always uses the current version and normal envelope; a retry already recorded in the
original evidence is observed and, when `SUCCEEDED`, verified under that evidence's own
version and envelope. The original evidence's captured request and run scope must equal
the current canonical request and scope.

A captured run scope therefore carries at most two executions: the base deterministic
name and one `-retry1`. A dispatch that finds `-retry1` already terminal non-success
refuses; a `RUNNING` retry is resumed and a `SUCCEEDED` retry is verified. A refused
dispatch records `refusal_phase`/`refusal_category` in the operation evidence, starts no
third execution and deletes no identity. The retry is the only retry: there is no attempt
number, attempt input, predecessor artifact or execution-history hash, and no second
cessation sample. An operator supplies the captured identities once; the protected
`recover` dispatch takes `source_run_id`/`source_run_attempt`.

Every dispatch always emits `operation_mode: 'normal'` and no `recovery_attempt`; the
envelope keeps the optional attempt field only because the Service validates it.
`validateCommitted` still compares both echoed fields, so a Service that echoes an
attempt is refused. The `recover` operation and its original-artifact preparation remain
the only consumer of the capture inputs in the shared `qualify` entry; partial Cognito
reconciliation never shrinks the canonical cleanup request. Shared account-pool
concurrency does not establish a cross-repository writer allocation; that remains an
operational preflight gate.

The `full`, `smoke` and `measure` operations accept `worker_slot_offset` (default `0`) for
allocating the run's worker slots; for example `2` selects slots 2 and 3 without
reusing slots 0 and 1, while `measure` allocates one slot. Admission eligibility does not
use the offset. Recovery always uses the exact captured
original emails/subjects, independent of later slot allocations. An offset does
not establish cessation of other jobs or authorize use of occupied slots: verify
outstanding executions, tasks and manifests are reconciled before reuse.

## Beta sizing evidence

`scripts/beta-sizing-benchmark.mjs` classifies collected sizing evidence. It does
not authenticate artifact publication or replace the `qualify` entry. A normal
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

The `full` and `smoke` operations do not run the workload and accept no sizing stage. The
`measure` operation refuses the menu's `none` sentinel and any stage other than `S1`, `S2` or
`S3`, and there is no default stage, so a measurement is never implicit. It runs
`tests/beta-sizing.spec.ts` in `pnpm test:instrumentation`
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

The capture is unconditional for every qualification run, because a deployment change
cannot qualify release evidence of any kind. The `measure` operation captures the same
identity around its own workload, so a rotated task definition during a measurement is
attributable too. The
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

The `measure` operation preserves `.qualification-inputs/beta-sizing-runtime-before.json`
and `test-results/beta-sizing-workload.json` in its own
`beta-measurement-<run>-<attempt>` artifact, including
partial business results after failure. They are measurement evidence, not part of the
`full` operation's diagnostics, which do not carry them. Protected leased-account
application
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
