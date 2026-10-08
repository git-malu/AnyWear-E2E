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
native publication/receipt, deployment identity and writer-window validation; their
offline assertions remain required by `check` without claiming actual publication or
qualification.

The tool workflow watches the registered tests, their implementation and fixture
dependencies, shared evidence/source contracts, vendored publication validators and
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
writer-window, quarantine and Service/Cognito cleanup controls remain shared with
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

The placeholders above are rejected by validation. To migrate, supply all exact
values explicitly to `node scripts/migrate-compatibility.mjs --reviewed-input
<reviewed-v2.json>`. First prepare `.infra-source` as a clean checkout of the
candidate's exact Infra SHA from its expected origin. Supply the Infra reader as
`GH_TOKEN`, the Service reader as `SERVICE_ARTIFACT_READ_TOKEN`, and a Client-only
Contents read token as `CLIENT_CONTENTS_READ_TOKEN` for remote commit checks.
The script checks remote commit availability, retrieves the
pinned trusted deployment artifact and sealed Service manifest, then writes the
candidate for review. It does not infer SHAs, dispatch workflows, or run a suite.
The final #54 tuple must pin the deployment record produced **after old IAM/trust
retirement**; the rehearsal record cannot substitute.

The evidence reader accepts only the protected Infra `runtime.yml` and Service
`service-artifacts.yml` completed-success main run/attempt. It rejects missing,
expired, tampered or duplicate-key records, unknown formats, unsealed releases,
asset/source mismatches and unverified release attestations. Publication proof
also requires the selector's exact receipt hash and full release/asset/producer
bindings from a tracked `publications/<manifest-sha256>.json` in the clean pinned
Infra source. E2E executes that Infra revision's consumer with an explicit trusted
source root and SHA; its vendored directory cannot supply receipt trust. The
consumer checks native release verification JSON and every signed asset, rather
than accepting CLI exit status alone. Private retrieval
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

## Frozen E2E writer windows

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
`false` during preparation. For one reviewed protected Beta dispatch, configure:

| Variable | Required value |
| --- | --- |
| `ENABLE_INFRA_E2E` | `true` only after role/access/cutover gates pass |
| `E2E_WRITER_WINDOW_TOKEN` | Exact nonsecret manager allocation token; matching workflow input |
| `E2E_WRITER_SHA` | Full reviewed E2E source SHA |
| `E2E_WRITER_RUN_ID`, `E2E_WRITER_RUN_ATTEMPT` | Exact allocated run/attempt |
| `E2E_WRITER_EXPIRES_AT` | UTC timestamp bounding the complete suite and nested cleanup |
| `E2E_WRITER_RECORD_URL` | Manager's allocation comment URL on AnyWear issue #54 |
| `E2E_CLEANUP_SERVICE_SHA` | Full reviewed Service app-data operator SHA; independent of image producer SHA |
| `AWS_ACCOUNT_ID`, `AWS_REGION` | `650880818323`, `ap-east-1` |
| `APP_ID`, `APP_PRIVATE_KEY` | Installed read/cleanup App configuration; private key remains a secret |

Allocate the run identity while it awaits the protected Beta environment approval
and read back the effective environment variables before releasing it. The guard
requires protected main `workflow_dispatch`, exact run/attempt/source/token and an
unexpired window. It is checked before observations, suite and mutation boundaries,
including Cognito deletion after a nested Service cleanup wait. An expired window
retains the cleanup manifest for a separately allocated recovery run. The manager
must verify all local/Actions/CFN/ECS/nested Service jobs have ceased before handing
the environment to another writer; timeout alone never releases it.

Service `beta-testers.yml` remains the bounded application-data cleanup entrypoint.
Both normal and recovery cleanup dispatch that endpoint within the allocated data
window, verify its exact reviewed operator source/run/attempt and require completed
success before deleting Cognito identities. Recovery validates the completed
original E2E owner and captured worker subjects; unknown or unrecovered identities
and quarantined leases remain in its manifest and fail recovery. The account
artifact also preserves the successful nested Service run/attempt/source and exact
cleanup request before any Cognito deletion, including when later cleanup fails.
This evidence is diagnostic; recovery still executes and verifies its own guarded
Service cleanup. E2E does not check out a mutable cleanup
helper or pass the Lifecycle/Cleanup task roles. Service's surviving operator must
select the dedicated `CleanupTaskRoleArn` with no fallback to the old Lifecycle
role. Its legacy image still needs narrowly reviewed data-cleanup permissions for
the two Beta DLQs, while admission controls remain outside that role. None of these
workflows deploy CDK, change admission policy, or revive the retired runtime drill.
