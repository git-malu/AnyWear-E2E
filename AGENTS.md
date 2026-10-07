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
- Full suite: `pnpm test`

Run install and build commands from this repository, never from the AnyWear
shell root.

## Test Design

- Tag stable critical paths with `@smoke` and all cross-repository scenarios with
  `@full-stack`.
- Generate unique users and records per test so parallel execution is safe.
- Clean up every cloud resource created by a test in teardown, even after a
  failed assertion.
- Fail clearly when required environment variables are missing; do not silently
  skip a required CI gate.
- Use role, label, and visible-text locators before test IDs or CSS selectors.
- Never commit credentials, browser storage state, reports, traces, screenshots,
  or videos.
- Treat `compatibility.json` as the system-test compatibility contract. Use only
  full Client and Service commit SHAs that exist on their remotes; never use a
  mutable branch or tag.
- For release qualification, record the full intended Client, Service, and E2E
  SHAs and verify that the target environment serves those Client and Service
  revisions through Client `build-metadata.json` and Service `/health`. Recheck
  both identities and the Service image digest after the suite; a mismatch or
  deployment change cannot qualify the release. Preserve the observed runtime
  revisions, image digest, environment endpoints, and qualification run/artifact
  links together with the intended SHAs in the release evidence. Checking out
  pinned source alone does not prove the deployed system ran it.
- The E2E Integration workflow owns on-demand cross-repository checkout and diagnostic
  execution for beta and later stages; it must not target dev. The Beta Qualification
  workflow owns the complete deployed suite and release evidence. The AnyWear shell
  repository is a local workspace and must not own E2E CI credentials.

After committing E2E changes, update the `AnyWear-E2E` submodule pointer in the
AnyWear shell repository for local workspace reproducibility. This pointer does
not trigger or select the E2E CI compatibility set.
