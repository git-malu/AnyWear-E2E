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

- Tag stable critical paths with `@smoke` and all local system tests with
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
- The E2E Integration workflow owns cross-repository checkout and full-stack
  execution. The AnyWear shell repository is a local workspace and must not own
  E2E CI credentials.

After committing E2E changes, update the `AnyWear-E2E` submodule pointer in the
AnyWear shell repository for local workspace reproducibility. This pointer does
not trigger or select the E2E CI compatibility set.
