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
- Measurement or drill: `pnpm test:instrumentation`; never part of the release-gating
  selection
- Scenario classification: [docs/scenario-inventory.md](docs/scenario-inventory.md)

Run install and build commands from this repository.

## Test Design

- Tag stable critical paths with `@smoke`, release-gating scenarios with
  `@regression`, and all cross-repository scenarios with `@full-stack`. Tag a
  measurement workload or drill with `@instrumentation`: it is admitted as
  measurement and can neither satisfy nor fail release qualification.
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
- Treat `compatibility.json` as the system-test compatibility contract. Use only
  full Client, Service and Infra commit SHAs that exist on their remotes; never
  use a mutable branch or tag. Version 3 pins the two deployment producers (Infra
  for the platform record, the Service release chain for the workload record);
  the shape and the deferred-record rule are in
  [docs/compatibility-v3.md](docs/compatibility-v3.md), and
  [docs/compatibility-pin.md](docs/compatibility-pin.md) is the routine that moves
  it.
- For release qualification, record the full intended Client, Service, and E2E
  SHAs and verify that the target environment serves those Client and Service
  revisions through Client `build-metadata.json` and Service `/health`. Recheck
  both identities and the Service image digest after the suite; a mismatch or
  deployment change cannot qualify the release. Preserve the observed runtime
  revisions, image digest, environment endpoints, and qualification run/artifact
  links together with the intended SHAs in the release evidence. Checking out
  pinned source alone does not prove the deployed system ran it.
- The single protected `qualify` entry in `beta-qualification.yml` owns the deployed
  operations for beta and later stages; it must not target dev. Separation between
  qualification, the smoke diagnostic, measurement and account recovery now lives in the
  signed `operation` field, not in a workflow-file boundary: `qualification-record.json` is
  produced only by the `full` operation, the record binds the operation that was dispatched,
  and both this repository's producer/verifier and the Infra-side executor allow-list require
  `operation: full`. A `smoke`, `measure` or `recover` run therefore can neither produce nor
  withhold the record the release gate produced, and a measurement or recovery result is
  never substituted for qualification evidence.
