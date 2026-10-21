# AnyWear E2E Agent Instructions

This repository owns system tests that cross at least two deployable AnyWear
boundaries. It uses TypeScript, Playwright Test, Node.js 24, and pnpm 11.18.0.

## Ownership Rules

- Keep mocked browser tests in `AnyWear-Client`.
- Keep Service route, database, contract, and CDK tests in `AnyWear-Service`.
- Add a test here only when it exercises the real Client and Service together,
  a deployed environment, or a real external identity/cloud boundary.
- Treat Client and Service as black boxes. Do not import their implementation
  modules into E2E tests.

## Stage Policy

- Do not run or gate the `AnyWear-E2E` suite in the dev stage. Dev-stage
  verification is covered by unit tests and integration tests; those are
  sufficient for that stage.
- Run this E2E suite only in the beta stage and later stages, including prod.
  Do not add dev-stage E2E jobs, release gates, or required checks.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Audit: `pnpm audit`
- Lint: `pnpm lint`
- Type check: `pnpm typecheck`
- Discover tests: `pnpm test:list`
- Smoke tests: `pnpm test:smoke`
- Release-gating deployed selection: `pnpm test:regression`; `pnpm test` runs the same
  selection, and the protected qualification step runs it as the release gate
- Scenario classification: [docs/scenario-inventory.md](docs/scenario-inventory.md)

Run install and build commands from this repository.

## Test Design

- Tag stable critical paths with `@smoke`, release-gating scenarios with
  `@regression`, and all cross-repository scenarios with `@full-stack`.
- Classify every scenario in the [scenario inventory](docs/scenario-inventory.md):
  its policy class, intent, selecting invocation, evidence level, cleanup contract
  and what a red result means. A new scenario is admitted only under the testing
  policy's admission rule.
- Generate unique users and records per test so parallel execution is safe.
- Clean up every cloud resource created by a test in teardown, even after a
  failed assertion.
- Fail clearly when required environment variables are missing; do not silently
  skip a required CI gate.
- Use role, label, and visible-text locators before test IDs or CSS selectors.
- Never commit credentials, browser storage state, reports, traces, screenshots,
  or videos.
- Qualification reads the live deployed tuple. The Client identifies itself through
  `build-metadata.json` (`source_commit`, `client_version`, `built_at`, schema 3) and the
  Service through `/health` (`service_commit`, `image_digest`, `minimum_client_version`);
  `full` compares those values with the dispatch expectation and refuses a mismatch before
  the suite, naming the observed and the expected value. The only committed input on the
  live path is `minimum-supported-client.json` (`{version, sha}`): the oldest supported
  Client the deployed Service still accepts, whose `version` must equal the live Service
  floor (a disagreement is a refusal, never an automatic choice). Do not add a committed
  file that describes the deployed revisions; that is what #180 removed.
- For release qualification, record the full intended Client, Service, and E2E
  SHAs and verify that the target environment serves those Client and Service
  revisions through Client `build-metadata.json` and Service `/health`. Recheck
  both identities, the platform observation and the Service image digest after the suite;
  a mismatch or deployment change cannot qualify the release. Preserve the observed runtime
  revisions, image digest, environment endpoints, and qualification run/artifact
  links together with the intended SHAs in the release evidence. Checking out
  pinned source alone does not prove the deployed system ran it.
- Qualification record schema v3 is self-contained: `expected`, `revisions`
  (`e2e`/`client`/`service`, never `infra`), `service_artifacts` (including
  `service-artifacts-<service sha>`), the two `observations`, `test`, `workflow`
  (including `trigger` and `dispatched_by`) and `integrity`. It has no `compatibility` and
  no `deployment` member. The independent platform observation is this repository's own
  authenticated read (`scripts/infra-observation.mjs`) through the vendored contract, not a
  cross-repository Infra checkout.
- `compatibility.json`, `docs/compatibility-pin.md`, `docs/compatibility-v3.md` and the
  pin tools (`validate-compatibility-pin.mjs`, `migrate-compatibility.mjs`,
  `check-compatibility.mjs`) are **retained inert until Wave 2**. No **release-qualification**
  path may read them (`beta-qualification.yml`, `pnpm check`, `test:core` and `test:list` are
  pin-free); the repository keeps them only as the revert target until a real `full` run passes
  against the live tuple. Do not add new readers, and do not delete them in a Wave-1 change.
  The retained pin tools are not runnable after Wave 1: they import the deleted
  `trusted-deployment-inputs.mjs` and only work after reverting the Wave-1 PR. No executed
  path reads the pin: the former measurement workload that did is deleted with the sizing
  apparatus. `runtime-drill.mjs` and `runtime-recovery-artifact.mjs` read the pin only in their manual
  CLI entry points; no workflow, `pnpm check`, `test:core` or `test:list` path reads that
  branch, and Wave 2 replaces the input with the qualification tuple or deletes the CLI with
  the pin.
- The release decision is the green `full` run plus the sealed record that `record` verifies
  and attaches. There is no separate approval job or approval Environment: the audit trail is
  the `qualify` `workflow_dispatch` event (actor and time), the E2E `full` run/attempt and the
  record tuple. Do not add an approval Environment or approval/`Approved`/`Rejected` states.
- The single protected `qualify` entry in `beta-qualification.yml` owns the deployed
  operations for beta and later stages; it must not target dev. Separation between
  qualification, the smoke diagnostic and account recovery now lives in the
  signed `operation` field, not in a workflow-file boundary: `qualification-record.json` is
  produced only by the `full` operation, the record binds the operation that was dispatched,
  and both this repository's producer/verifier and the Infra-side executor allow-list require
  `operation: full`. A `smoke` or `recover` run therefore can neither produce nor
  withhold the record the release gate produced, and a recovery result is
  never substituted for qualification evidence.
